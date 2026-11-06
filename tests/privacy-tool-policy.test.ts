import { afterEach, describe, expect, it, vi } from 'vitest';
import { ChatAgent, runAgentLoop } from '../src/main/ai/agent';
import { createToolPolicy } from '../src/main/ai/tool-policy';
import type { LlmClient, LlmMessage, LlmOptions, LlmResult, LlmTool, ModelRouter } from '../src/main/ai/llm';
import { Db } from '../src/main/db/db';
import { Repo } from '../src/main/db/repo';
import { TicketExecutor } from '../src/main/engine/executor';
import { nullChannels } from '../src/main/engine/channels';
import type { McpHub } from '../src/main/mcp/hub';

const opened: Db[] = [];
afterEach(() => opened.splice(0).forEach(db => db.close()));
const PRIVATE_BODY = 'PRIVATE_MAIL_BODY_MUST_STAY_LOCAL';
const makeCalls = (names: [string, Record<string, unknown>][]): LlmResult => ({
  content: '', toolCalls: names.map(([name, args], index) => ({ id: `call-${index}`, name, arguments: JSON.stringify(args) })),
});
const answer = (): LlmResult => ({ content: '已处理查询。', toolCalls: [] });
const names = [
  ['fudan-mail', 'get_mail'], ['fudaner-local', 'search_all'], ['fudan-elearning', 'get_assignment'],
  ['fudan-mail', 'list_action_required'], ['fudaner-local', 'save_resource'],
] as const;
function setup(label = 'cloud:fixture', allow = false) {
  const db = new Db(':memory:'); opened.push(db);
  const repo = new Repo(db); repo.setSettings({ allowSensitiveToCloud: allow });
  const base = { publishedAt: '2026-11-06T02:00:00Z', done: false };
  const email = repo.upsertItem({ ...base, source: 'mail', kind: 'email', sourceId: 'mail', title: '邮件标题', body: PRIVATE_BODY }).item;
  const assignment = repo.upsertItem({ ...base, source: 'elearning', kind: 'assignment', sourceId: 'assignment', title: '课程作业', body: 'ASSIGNMENT_CONTENT' }).item;
  const call = vi.fn<McpHub['call']>(async (qualified, args) => {
    const [raw, tool] = qualified.split('__');
    const server = raw.replace(/_/g, '-');
    const data = tool === 'search_all' ? [{ snippet: PRIVATE_BODY }] : tool === 'get_mail' ? { body: PRIVATE_BODY }
      : tool === 'get_assignment' ? repo.getItem(String(args.id))
      : tool === 'save_resource' ? repo.addResource({ title: String(args.title), text: String(args.content), kind: 'assistant_output', mime: 'text/markdown' })
      : [{ id: email.id, summary: '脱敏摘要' }];
    return { server, tool, ok: true, text: JSON.stringify(data) };
  });
  const hub = {
    call,
    llmTools: (filter?: (server: string, tool: string) => boolean): LlmTool[] => names.filter(([server, tool]) => !filter || filter(server, tool))
      .map(([server, tool]) => ({ type: 'function', function: { name: `${server.replace(/-/g, '_')}__${tool}`, parameters: { type: 'object' } } })),
  } as unknown as McpHub;
  const sent: string[] = [], advertised: string[][] = [];
  const llm: LlmClient = { label, chat: vi.fn(async () => answer()) };
  const route = { for: (task: string) => task === 'chat' || task === 'ticket' ? llm : null } as ModelRouter;
  const script = (first: [string, Record<string, unknown>][], save = false) => {
    let turn = 0;
    llm.chat = vi.fn(async (messages: LlmMessage[], opts?: LlmOptions) => {
      sent.push(JSON.stringify(messages));
      advertised.push((opts?.tools ?? []).map(tool => tool.function.name));
      if (turn++ === 0) return makeCalls(first);
      if (save && turn === 2) return makeCalls([['fudaner_local__save_resource', { title: '材料清单', content: JSON.stringify(messages.filter(message => message.role === 'tool')) }]]);
      return answer();
    });
  };
  return { repo, email, assignment, call, hub, llm, route, script, sent, advertised };
}

describe('模型工具的邮件正文隐私策略', () => {
  it('云端对话隐藏正文/全文工具，模型强行请求时也不执行，邮件ID不能冒充作业', async () => {
    const state = setup();
    state.script([
      ['fudan_mail__get_mail', { id: state.email.id }],
      ['fudaner_local__search_all', { query: '邮件' }],
      ['fudan_elearning__get_assignment', { id: state.email.id }],
    ]);
    const reply = await new ChatAgent(state.repo, state.route, state.hub, nullChannels).handleUserMessage('查询邮件');
    expect(state.advertised[0]).not.toContain('fudan_mail__get_mail');
    expect(state.advertised[0]).not.toContain('fudaner_local__search_all');
    expect(state.call).not.toHaveBeenCalled();
    expect(reply.toolCalls).toHaveLength(3);
    expect(reply.toolCalls.every(call => call.ok === false)).toBe(true);
    expect(state.sent.join('')).not.toContain(PRIVATE_BODY);
    expect(state.sent[1]).toContain('当前未允许');
  });

  it.each([
    ['local:fixture', false], ['cloud:fixture', true],
  ])('%s / 云端授权=%s 可以读取正文和全文，正常作业仍可查询', async (label, allow) => {
    const state = setup(label, allow);
    state.script([
      ['fudan_mail__get_mail', { id: state.email.id }],
      ['fudaner_local__search_all', { query: '邮件' }],
      ['fudan_elearning__get_assignment', { id: state.assignment.id }],
    ]);
    const reply = await new ChatAgent(state.repo, state.route, state.hub, nullChannels).handleUserMessage('查询资料');
    expect(state.advertised[0]).toContain('fudan_mail__get_mail');
    expect(state.advertised[0]).toContain('fudaner_local__search_all');
    expect(state.call).toHaveBeenCalledTimes(3);
    expect(reply.toolCalls.every(call => call.ok)).toBe(true);
    expect(state.sent.join('')).toContain(PRIVATE_BODY);
    expect(state.sent.join('')).toContain('ASSIGNMENT_CONTENT');
  });

  it.each([['local:fixture', false], ['cloud:fixture', true], ['cloud:fixture', false]])(
    '任何路由都不允许用邮件或不存在ID调用get_assignment：%s / %s', async (label, allow) => {
      const state = setup(label, allow);
      state.script([
        ['fudan_elearning__get_assignment', { id: state.email.id }],
        ['fudan_elearning__get_assignment', { id: 'missing' }],
      ]);
      const reply = await new ChatAgent(state.repo, state.route, state.hub, nullChannels).handleUserMessage('查作业');
      expect(state.call).not.toHaveBeenCalled();
      expect(reply.toolCalls.every(call => call.ok === false)).toBe(true);
      expect(state.sent.join('')).not.toContain(PRIVATE_BODY);
    },
  );

  it('云端仍能读取允许的摘要工具和有效作业，不影响普通查询', async () => {
    const state = setup();
    state.script([
      ['fudan_mail__list_action_required', {}],
      ['fudan_elearning__get_assignment', { id: state.assignment.id }],
    ]);
    const reply = await new ChatAgent(state.repo, state.route, state.hub, nullChannels).handleUserMessage('查待回复邮件和作业');
    expect(state.call).toHaveBeenCalledTimes(2);
    expect(reply.toolCalls.every(call => call.ok)).toBe(true);
    expect(state.sent.join('')).toContain('脱敏摘要');
    expect(state.sent.join('')).not.toContain(PRIVATE_BODY);
  });

  it('云端后台工单同样拒绝正文、全文和邮件ID别名，不把拒绝结果当信息来源', async () => {
    const state = setup();
    state.script([
      ['fudan_mail__get_mail', { id: state.email.id }],
      ['fudaner_local__search_all', { query: '邮件' }],
      ['fudan_elearning__get_assignment', { id: state.email.id }],
    ]);
    state.repo.addTicket({ title: '清单', request: '整理邮件材料', mandate: 'explicit', status: 'queued' });
    const result = await new TicketExecutor(state.repo, state.route, state.hub, nullChannels).runNext();
    expect(result?.status).toBe('failed');
    expect(state.call).not.toHaveBeenCalled();
    expect(state.sent.join('')).not.toContain(PRIVATE_BODY);
    expect(state.advertised[0]).not.toContain('fudan_mail__get_mail');
    expect(state.advertised[0]).not.toContain('fudaner_local__search_all');
  });

  it.each([['local:fixture', false], ['cloud:fixture', true]])(
    '获准的后台工单仍能查询正文后保存成果：%s / %s', async (label, allow) => {
      const state = setup(label, allow);
      state.script([['fudan_mail__get_mail', { id: state.email.id }]], true);
      state.repo.addTicket({ title: '清单', request: '整理邮件材料', mandate: 'explicit', status: 'queued' });
      const result = await new TicketExecutor(state.repo, state.route, state.hub, nullChannels).runNext();
      expect(result?.status).toBe('done');
      expect(state.repo.getResource(result!.resultResourceId!)?.text).toContain(PRIVATE_BODY);
      expect(state.call).toHaveBeenCalledTimes(2);
    },
  );

  it('执行前重新读取授权，并遵循Hub拆分规则阻止附加后缀绕过', async () => {
    const state = setup('cloud:fixture', true);
    const policy = createToolPolicy(state.repo, state.llm);
    expect(policy.filter('fudan-mail', 'get_mail')).toBe(true);
    state.repo.setSettings({ allowSensitiveToCloud: false });
    const messages: LlmMessage[] = [];
    state.script([['fudan_mail__get_mail__ignored', { id: state.email.id }]]);
    const result = await runAgentLoop({ llm: state.llm, hub: state.hub, tools: [], messages, authorizeTool: policy.authorize });
    expect(state.call).not.toHaveBeenCalled();
    expect(result.toolCalls[0].ok).toBe(false);
    expect(messages.find(message => message.role === 'tool')?.content).toContain('当前未允许');
  });
  it('未授权时模型明确获知隐私设置原因和开启路径', async () => {
    const state = setup(); state.script([]);
    await new ChatAgent(state.repo, state.route, state.hub, nullChannels).handleUserMessage('读取邮件原文');
    const system = JSON.parse(state.sent[0])[0].content;
    expect(system).toContain('用户尚未允许向云端发送邮件正文');
    expect(system).toContain('设置 → 模型 → 隐私任务的云端授权');
    expect(state.advertised[0]).not.toContain('fudan_mail__get_mail');
  });

  it.each([['cloud:fixture', true], ['local:fixture', false], ['cloud:fixture', false]])(
    '引用已有摘要的邮件依照正文授权处理：%s / %s', async (label, allow) => {
      const state = setup(label, allow);
      state.repo.setItemAi(state.email.id, { summary: '仅有摘要', category: 'notice' });
      state.script([]);
      await new ChatAgent(state.repo, state.route, state.hub, nullChannels).handleUserMessage('解释这封邮件', [{ type: 'item', id: state.email.id, title: '邮件' }]);
      const messages = JSON.parse(state.sent[0]) as LlmMessage[];
      const user = messages.at(-1)!.content;
      if (allow || label.startsWith('local:')) {
        expect(user).toContain(PRIVATE_BODY);
        expect(messages[0].content).toContain('调用 get_mail 读取 body');
      } else {
        expect(user).not.toContain(PRIVATE_BODY);
        expect(user).toContain('仅有摘要');
      }
    },
  );

});
