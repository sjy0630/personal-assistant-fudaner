import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppContext } from '../src/main/app-context';
import { ChatAgent, runAgentLoop } from '../src/main/ai/agent';
import { ModelRouter, parseJsonLoose, type LlmClient, type LlmMessage, type LlmOptions, type LlmResult } from '../src/main/ai/llm';
import { DemoElearningClient, DemoMailClient, seedDemoProfile } from '../src/main/demo/demo';
import { nullChannels } from '../src/main/engine/channels';
import { TicketExecutor } from '../src/main/engine/executor';
import type { McpHub } from '../src/main/mcp/hub';
import type { ChatMessage, ChatRun } from '../src/shared/types';

const NOW = new Date('2026-11-06T10:00:00+08:00');
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });

type Turn = (messages: LlmMessage[], options?: LlmOptions) => LlmResult | Promise<LlmResult>;
function script(turns: Turn[]): LlmClient {
  let turn = 0;
  return { label: 'cloud:fixture', chat: vi.fn(async (messages, options) => {
    const next = turns[turn++];
    if (!next) throw new Error('Unexpected model request');
    return next(messages, options);
  }) };
}
const answer = (content = '已根据查询结果整理。'): LlmResult => ({ content, toolCalls: [] });
function calls(...tools: [name: string, args: Record<string, unknown>][]): LlmResult {
  return { content: '', toolCalls: tools.map(([name, args], index) => ({ id: `${name}-${index}`, name, arguments: JSON.stringify(args) })) };
}
function toolData<T>(messages: LlmMessage[], name?: string): T {
  const response = [...messages].reverse().find((m) => m.role === 'tool' && (!name || m.content?.includes(name)));
  expect(response?.content).toContain('<external_data');
  return parseJsonLoose<T>(response!.content!)!;
}
async function context() {
  const posted: ChatMessage[] = [];
  const snapshots: ChatRun[] = [];
  const channels = { ...nullChannels, messagePosted: (message: ChatMessage) => posted.push(message), delta: (run: ChatRun) => snapshots.push(structuredClone(run)) };
  const app = new AppContext({ dbPath: ':memory:', channels, elearning: () => new DemoElearningClient(() => NOW), mail: () => new DemoMailClient(() => NOW) });
  cleanups.push(() => app.close());
  app.repo.setSettings({ demoMode: true });
  seedDemoProfile(app.repo);
  await app.start();
  await app.syncAll(NOW);
  return { app, posted, snapshots, channels };
}
function router(app: AppContext, llm: LlmClient): ModelRouter {
  app.repo.setSettings({ cloud: { baseURL: 'http://127.0.0.1:1/v1', model: 'fixture', apiKey: '' } });
  return new ModelRouter(() => app.repo.getSettings(), () => llm);
}
const deadlines: [string, Record<string, unknown>] = ['fudaner_local__list_deadlines', { from: NOW.toISOString(), to: new Date(NOW.getTime() + 7 * 86_400_000).toISOString() }];

describe('T1 对话工具流程（真实 MCP，脚本模型，不访问外部模型）', () => {
  it('DDL 回答来自工具返回，并保留可点击事项卡片和同 ID 快照', async () => {
    const { app, channels, snapshots } = await context();
    const llm = script([() => calls(deadlines), (messages) => answer(toolData<{ title: string }[]>(messages)[0].title)]);
    const reply = await new ChatAgent(app.repo, router(app, llm), app.hub, channels).handleUserMessage('这周有哪些 DDL？');
    expect(reply.content).toBe('Lab 5：链表与栈');
    expect(reply.toolCalls.map((t) => t.name)).toEqual(['list_deadlines']);
    expect(reply.cards.some((c) => c.type === 'item' && c.title === reply.content)).toBe(true);
    expect(snapshots.at(-1)?.id).toBe(reply.id);
    expect(snapshots.at(-1)?.content).toBe(reply.content);
  });

  it('待回复邮件回答来自邮箱工具', async () => {
    const { app, channels } = await context();
    const llm = script([() => calls(['fudan_mail__list_action_required', {}]), (messages) => answer(toolData<{ subject: string }[]>(messages)[0].subject)]);
    const reply = await new ChatAgent(app.repo, router(app, llm), app.hub, channels).handleUserMessage('有哪些邮件要回？');
    expect(reply.content).toContain('组会');
    expect(reply.toolCalls[0]).toMatchObject({ server: 'fudan-mail', name: 'list_action_required', ok: true });
    expect(reply.cards.some((c) => c.type === 'item' && c.title === reply.content)).toBe(true);
  });

  it('规划先查询 DDL、空闲时段和已有记忆', async () => {
    const { app, channels } = await context();
    const llm = script([
      () => calls(deadlines, ['fudaner_local__get_today', { date: NOW.toISOString() }], ['fudaner_local__recall', { query: '周二晚上社团' }]),
      (messages) => {
        const items = toolData<{ title: string }[]>(messages, 'list_deadlines');
        const today = toolData<{ freeSlots: { start: string }[] }>(messages, 'get_today');
        const memories = toolData<{ content: string }[]>(messages, 'recall');
        return answer(`先完成${items[0].title}，空闲从${today.freeSlots.at(-1)!.start}开始；${memories[0].content}`);
      },
    ]);
    const reply = await new ChatAgent(app.repo, router(app, llm), app.hub, channels).handleUserMessage('帮我规划一下这周');
    expect(reply.toolCalls.every((t) => t.ok)).toBe(true);
    expect(reply.toolCalls.map((t) => t.name)).toEqual(['list_deadlines', 'get_today', 'recall']);
    expect(reply.content).toContain('15:10');
    expect(reply.content).toContain('Lab 5');
  });

  it('创建 GRE 目标并用真实目标 ID 添加任务，结果保留撤销权限', async () => {
    const { app, channels } = await context();
    const llm = script([
      () => calls(['fudaner_local__create_goal', { title: '准备 GRE', level: 'long_term' }]),
      (messages) => calls(['fudaner_local__add_task', { goal_id: toolData<{ id: string }>(messages).id, title: '完成第一套词汇练习' }]),
      () => answer('已创建 GRE 目标，并加入词汇练习任务。'),
    ]);
    const reply = await new ChatAgent(app.repo, router(app, llm), app.hub, channels).handleUserMessage('我想准备 GRE，帮我建个目标');
    const goal = reply.cards.find((c) => c.type === 'goal')!;
    const task = reply.cards.find((c) => c.type === 'task')!;
    expect(app.repo.getTask(task.id)?.goalId).toBe(goal.id);
    expect(reply.cards.every((c) => !!c.undoToken)).toBe(true);
  });

  it('保存计划后返回真实资源卡片，且内容可读取', async () => {
    const { app, channels } = await context();
    const markdown = '# 本周计划\n- 今天完成 Lab 5\n- 明天复习链表与栈';
    const llm = script([() => calls(['fudaner_local__save_resource', { title: '本周计划', content: markdown }]), () => answer('计划已存入资源库。')]);
    const reply = await new ChatAgent(app.repo, router(app, llm), app.hub, channels).handleUserMessage('把刚才的计划存下来');
    expect(reply.cards).toHaveLength(1);
    expect(reply.cards[0].type).toBe('resource');
    expect(app.repo.getResource(reply.cards[0].id)?.text).toBe(markdown);
    expect(reply.cards[0].undoToken).toBeTruthy();
  });
});

describe('工具循环失败和中断保护', () => {
  it.each(['{"title":"GRE"', '{} trailing text', '```json\n{}\n```', '[]', 'null', '"{}"'])('非法参数 %s 不执行任何工具', async (argumentsText) => {
    const call = vi.fn();
    await expect(runAgentLoop({
      llm: script([() => ({ content: '', toolCalls: [{ id: 'invalid', name: 'fudaner_local__create_goal', arguments: argumentsText }] })]),
      hub: { call } as unknown as McpHub, tools: [], messages: [],
    })).rejects.toThrow('工具参数不完整');
    expect(call).not.toHaveBeenCalled();
  });

  it('失败的写工具即使返回看似有效 ID 也不生成成果卡片', async () => {
    const result = await runAgentLoop({
      llm: script([() => calls(['fudaner_local__save_resource', { title: '计划', content: '正文' }]), () => answer('保存失败。')]),
      hub: { call: async () => ({ ok: false, server: 'fudaner-local', tool: 'save_resource', text: '{"id":"invented","title":"计划"}' }) } as unknown as McpHub,
      tools: [], messages: [],
    });
    expect(result.finishReason).toBe('answer');
    expect(result.cards).toEqual([]);
    expect(result.toolCalls[0].ok).toBe(false);
  });

  it('八轮仍调用工具时明确标记步骤耗尽', async () => {
    const call = vi.fn(async () => ({ ok: true, server: 'fudaner-local', tool: 'get_today', text: '{"date":"2026-11-06"}' }));
    const result = await runAgentLoop({ llm: { label: 'fixture', chat: async () => calls(['fudaner_local__get_today', {}]) }, hub: { call } as unknown as McpHub, tools: [], messages: [] });
    expect(result.finishReason).toBe('step_limit');
    expect(call).toHaveBeenCalledTimes(8);
  });

  it('下一轮断流仍保留已经完成的目标、卡片和撤销权限', async () => {
    const { app, channels } = await context();
    const llm = script([
      () => calls(['fudaner_local__create_goal', { title: 'GRE 复习', level: 'week' }]),
      (_messages, options) => { options?.onDelta?.('已经创建目标，'); throw new Error('private-provider-response'); },
    ]);
    const reply = await new ChatAgent(app.repo, router(app, llm), app.hub, channels).handleUserMessage('创建目标');
    expect(reply.content).toContain('已经创建目标');
    expect(reply.content).toContain('未完成');
    expect(reply.content).not.toContain('private-provider-response');
    expect(reply.toolCalls[0].ok).toBe(true);
    expect(app.repo.getGoal(reply.cards[0].id)?.title).toBe('GRE 复习');
    expect(reply.cards[0].undoToken).toBeTruthy();
  });
});

describe('T6 后台工单完成条件', () => {
  async function execute(turns: Turn[], kind: 'materials' | 'outline' = 'materials', wrapHub?: (hub: McpHub) => McpHub, allowSensitiveToCloud = false) {
    const state = await context();
    state.app.repo.setSettings({ allowSensitiveToCloud });
    const llm = script(turns);
    const ticket = state.app.repo.addTicket({ title: kind === 'materials' ? '交换材料清单' : '数据结构复习提纲', request: kind === 'materials' ? '查询交换邮件，整理材料清单并保存' : '查询数据结构课程和作业，整理复习提纲并保存', mandate: 'explicit', status: 'queued' });
    const executor = new TicketExecutor(state.app.repo, router(state.app, llm), wrapHub ? wrapHub(state.app.executorHub) : state.app.executorHub, state.channels);
    const result = await executor.runNext();
    return { ...state, ticket, llm, result };
  }

  it('材料清单先查邮件、读取正文再保存，后台完全不启用流式', async () => {
    const state = await execute([
      () => calls(['fudan_mail__search_mail', { query: '交换' }]),
      (messages) => calls(['fudan_mail__get_mail', { id: toolData<{ id: string }[]>(messages)[0].id }]),
      (messages) => calls(['fudaner_local__save_resource', { title: '交换材料清单', content: `# 交换材料清单\n\n${toolData<{ body: string }>(messages).body}\n\n来源：交换项目通知邮件。` }]),
      () => answer('清单已整理并保存。'),
    ], 'materials', undefined, true);
    expect(state.result?.status).toBe('done');
    expect(state.app.repo.getResource(state.result!.resultResourceId!)?.text).toContain('成绩单');
    expect(state.posted).toHaveLength(1);
    expect(state.posted[0].cards).toHaveLength(1);
    expect(state.snapshots).toHaveLength(0);
    expect(vi.mocked(state.llm.chat).mock.calls.every(([, options]) => options?.onDelta === undefined)).toBe(true);
    const report = state.app.repo.db.get<{ content: string }>('SELECT content FROM ticket_reports WHERE ticket_id = ? AND kind = ?', state.ticket.id, 'ready');
    expect(report?.content).toContain('fudan-mail/get_mail');
  });

  it('复习提纲依据课程工具返回的真实作业标题保存', async () => {
    const state = await execute([
      () => calls(['fudan_courses__get_course', { code: '数据结构' }]),
      (messages) => {
        const course = toolData<{ assignments: { title: string }[] }>(messages);
        return calls(['fudaner_local__save_resource', { title: '数据结构复习提纲', content: `# 复习提纲\n${course.assignments.map((a) => `- 复习：${a.title}`).join('\n')}\n来源：数据结构课程作业。` }]);
      },
      () => answer('复习提纲已保存。'),
    ], 'outline');
    expect(state.result?.status).toBe('done');
    expect(state.app.repo.getResource(state.result!.resultResourceId!)?.text).toContain('二叉树');
  });

  it('未查来源直接回答完成时，不创建兜底资源，不报告成功', async () => {
    const state = await execute([() => answer('整理好了，请准备成绩单。')]);
    expect(state.result?.status).toBe('failed');
    expect(state.app.repo.listResources()).toHaveLength(0);
    expect(state.posted[0].content).toContain('没做完');
    expect(state.posted[0].cards).toHaveLength(0);
  });

  it('未查来源时拦截直接保存，避免把编造内容当成果', async () => {
    const state = await execute([() => calls(['fudaner_local__save_resource', { title: '材料清单', content: '编造的材料和截止时间' }])]);
    expect(state.result?.status).toBe('failed');
    expect(state.app.repo.listResources()).toHaveLength(0);
  });

  it('读取空结果不能充当已有信息来源', async () => {
    const state = await execute([
      () => calls(['fudan_mail__search_mail', { query: 'no-such-mail-2026' }]),
      () => calls(['fudaner_local__save_resource', { title: '材料清单', content: '没有资料却声称完成' }]),
    ]);
    expect(state.result?.status).toBe('failed');
    expect(state.app.repo.listResources()).toHaveLength(0);
  });

  it('save_resource 校验失败时不使用最终一句话兜底报告成功', async () => {
    const state = await execute([
      () => calls(['fudan_mail__search_mail', { query: '交换' }]),
      () => calls(['fudaner_local__save_resource', { content: '缺少标题，工具应拒绝' }]),
      () => answer('已经完成了。'),
    ]);
    expect(state.result?.status).toBe('failed');
    expect(state.app.repo.listResources()).toHaveLength(0);
  });

  it('保存返回不存在的资源 ID 时报告失败', async () => {
    const state = await execute([
      () => calls(['fudan_mail__search_mail', { query: '交换' }]),
      () => calls(['fudaner_local__save_resource', { title: '材料清单', content: '计划内容' }]),
    ], 'materials', (hub) => ({
      llmTools: () => hub.llmTools(),
      call: async (name, args) => name.endsWith('__save_resource') ? { ok: true, server: 'fudaner-local', tool: 'save_resource', text: '{"id":"missing-resource"}' } : hub.call(name, args),
    }) as McpHub);
    expect(state.result?.status).toBe('failed');
    expect(state.posted[0].content).toContain('有效资源');
    expect(state.result?.resultResourceId).toBeUndefined();
  });

  it('空白资源不能作为完成成果', async () => {
    const state = await execute([
      () => calls(['fudan_mail__search_mail', { query: '交换' }]),
      () => calls(['fudaner_local__save_resource', { title: '空资源', content: '  \n  ' }]),
    ]);
    expect(state.result?.status).toBe('failed');
    expect(state.result?.resultResourceId).toBeUndefined();
  });

  it('保存后继续调用到步骤上限仍失败，保留已保存的部分成果', async () => {
    const state = await execute([
      () => calls(['fudan_mail__search_mail', { query: '交换' }]),
      () => calls(['fudaner_local__save_resource', { title: '部分材料清单', content: '# 部分清单\n- 成绩单\n尚待核对其他材料。' }]),
      ...Array.from({ length: 10 }, () => () => calls(['fudan_mail__search_mail', { query: '交换' }])),
    ]);
    expect(state.result?.status).toBe('failed');
    expect(state.posted[0].content).toContain('步骤达到上限');
    expect(state.app.repo.listResources()).toHaveLength(1);
    expect(state.result?.resultResourceId).toBeUndefined();
  });

  it('步数将尽时提示立即保存，模型据此保存后工单完成', async () => {
    let noticeSeen = false;
    const state = await execute([
      ...Array.from({ length: 10 }, () => () => calls(['fudan_mail__search_mail', { query: '交换' }])),
      (messages) => {
        noticeSeen = messages.some((m) => m.role === 'system' && typeof m.content === 'string' && m.content.includes('执行步数即将用完'));
        return calls(['fudaner_local__save_resource', { title: '交换材料清单', content: '# 交换材料清单\n- 成绩单（待核实）' }]);
      },
      () => answer('已保存交换材料清单。'),
    ]);
    expect(noticeSeen).toBe(true);
    expect(state.result?.status).toBe('done');
    expect(state.app.repo.getResource(state.result!.resultResourceId!)?.title).toBe('交换材料清单');
  });

  it('模型异常报告不回显服务端敏感错误详情', async () => {
    const state = await execute([() => { throw new Error('private-provider-response'); }]);
    expect(state.result?.status).toBe('failed');
    expect(state.posted[0].content).not.toContain('private-provider-response');
  });

  it('没有模型时保留演示模板路径和资源卡片', async () => {
    const state = await context();
    state.app.repo.addTicket({ title: '交换材料清单', request: '交换项目材料', mandate: 'explicit', status: 'queued' });
    const result = await state.app.executor.runNext();
    expect(result?.status).toBe('done');
    expect(state.app.repo.getResource(result!.resultResourceId!)?.text).toContain('未配置模型');
    expect(state.posted[0].cards[0].type).toBe('resource');
  });
});
