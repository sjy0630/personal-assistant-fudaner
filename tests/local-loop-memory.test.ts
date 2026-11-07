import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ChatAgent, runAgentLoop } from '../src/main/ai/agent';
import type { LlmClient, LlmMessage, LlmOptions, ModelRouter } from '../src/main/ai/llm';
import { memoryWriteProblem } from '../src/main/ai/memory-policy';
import { personaPrompt } from '../src/main/ai/prompts';
import { Db } from '../src/main/db/db';
import { Repo } from '../src/main/db/repo';
import { nullChannels } from '../src/main/engine/channels';
import { McpHub } from '../src/main/mcp/hub';
import { createLocalServer } from '../src/main/local-tools/server';
import { buildToday } from '../src/main/today';
import { queryArguments, queryRange, queryResultContext } from '../src/main/ai/query-context';

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const answer = (content = '完成。') => ({ content, toolCalls: [] });
const tool = (id: string, name: string, args = {}) => ({ content: '', toolCalls: [{ id, name, arguments: JSON.stringify(args) }] });
type Turn = (messages: LlmMessage[], options?: LlmOptions) => ReturnType<typeof answer> | ReturnType<typeof tool> | Promise<ReturnType<typeof answer> | ReturnType<typeof tool>>;
function script(turns: Turn[]): LlmClient {
  let index = 0;
  return { label: 'local:fixture', chat: vi.fn((messages, options) => Promise.resolve(turns[index++](messages, options))) };
}
function repo() { const db = new Db(':memory:'); cleanups.push(() => db.close()); return new Repo(db); }
async function hubFixture() {
  let value = 1;
  const read = vi.fn(async () => ({ content: [{ type: 'text' as const, text: JSON.stringify({ value }) }] }));
  const write = vi.fn(async () => { value++; return { content: [{ type: 'text' as const, text: '{}' }] }; });
  const server = new McpServer({ name: 'fixture', version: '1' });
  server.registerTool('read', { inputSchema: { a: z.number().optional(), b: z.number().optional(), refresh: z.boolean().optional() }, annotations: { readOnlyHint: true } }, read);
  server.registerTool('write', { inputSchema: {} }, write);
  const hub = new McpHub(); cleanups.push(() => hub.close()); await hub.connect('fixture', server);
  return { hub, read, write };
}

describe('主对话重复只读查询保护', () => {
  it('复用相同参数（键序不同）的成功查询，只用已有事实收尾，并保留流式正文', async () => {
    const { hub, read } = await hubFixture();
    const chunks: string[] = [];
    const llm = script([
      () => tool('a', 'fixture__read', { a: 1, b: 2 }),
      () => tool('b', 'fixture__read', { b: 2, a: 1 }),
      (messages, options) => {
        expect(options?.tools).toEqual([]);
        expect(messages.filter(m => m.role === 'tool').every(m => m.content?.includes('"value":1'))).toBe(true);
        options?.onDelta?.('查询值为1。'); return answer('查询值为1。');
      },
    ]);
    const result = await runAgentLoop({ llm, hub, tools: hub.llmTools(), messages: [], recoverRepeatedReads: true, onDelta: c => chunks.push(c) });
    expect(read).toHaveBeenCalledTimes(1);
    expect(llm.chat).toHaveBeenCalledTimes(3);
    expect(result.finishReason).toBe('answer'); expect(result.content).toBe('查询值为1。');
    expect(chunks.join('')).toBe(result.content); expect(result.toolCalls[1].summary).toContain('复用');
    expect(hub.isReadOnly('fixture__read')).toBe(true);
    expect(hub.isReadOnly('fixture__write')).toBe(false); expect(hub.isReadOnly('missing__read')).toBe(false);
  });

  it('写入后重新查询必须读新值，不能用写入前的缓存', async () => {
    const { hub, read, write } = await hubFixture();
    const llm = script([
      () => tool('a', 'fixture__read'), () => tool('b', 'fixture__write'), () => tool('c', 'fixture__read'),
      messages => { expect(messages.filter(m => m.role === 'tool').at(-1)?.content).toContain('"value":2'); return answer(); },
    ]);
    await runAgentLoop({ llm, hub, tools: hub.llmTools(), messages: [], recoverRepeatedReads: true });
    expect(read).toHaveBeenCalledTimes(2); expect(write).toHaveBeenCalledTimes(1);
  });

  it('失败查询允许重试；不同查询参数不会被当成重复', async () => {
    const { hub, read } = await hubFixture();
    read.mockRejectedValueOnce(new Error('temporary'));
    const llm = script([() => tool('a', 'fixture__read', { a: 1 }), () => tool('b', 'fixture__read', { a: 1 }), () => tool('c', 'fixture__read', { a: 2 }), () => answer()]);
    const result = await runAgentLoop({ llm, hub, tools: hub.llmTools(), messages: [], recoverRepeatedReads: true });
    expect(read).toHaveBeenCalledTimes(3); expect(result.toolCalls.map(t => t.ok)).toEqual([false, true, true]);
  });

  it('明确要求刷新时不复用查询结果', async () => {
    const { hub, read } = await hubFixture();
    const llm = script([() => tool('a', 'fixture__read', { refresh: true }), () => tool('b', 'fixture__read', { refresh: true }), () => answer()]);
    await runAgentLoop({ llm, hub, tools: hub.llmTools(), messages: [], recoverRepeatedReads: true });
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('无工具收尾时模型仍请求写入，不执行也不报告成功', async () => {
    const { hub, write } = await hubFixture();
    const llm = script([() => tool('a', 'fixture__read'), () => tool('b', 'fixture__read'), () => tool('c', 'fixture__write')]);
    const result = await runAgentLoop({ llm, hub, tools: hub.llmTools(), messages: [], recoverRepeatedReads: true });
    expect(write).not.toHaveBeenCalled(); expect(result.finishReason).toBe('step_limit'); expect(result.content).toContain('尚未完成');
  });

  it('收尾时取消仍然生效', async () => {
    const { hub } = await hubFixture(); const controller = new AbortController();
    const llm = script([() => tool('a', 'fixture__read'), () => tool('b', 'fixture__read'), () => { controller.abort(); return answer('不应完成'); }]);
    await expect(runAgentLoop({ llm, hub, tools: [], messages: [], recoverRepeatedReads: true, signal: controller.signal })).rejects.toThrow();
  });
});

describe('记忆必须来自本轮用户事实', () => {
  it.each([
    ['请查询今天有哪些课程？', '对AI方向的讲座感兴趣'],
    ['如果我想申请2027春季交换，怎么办？', '想申请2027春季交换'],
    ['我不喜欢喝咖啡。', '喜欢喝咖啡'],
    ['我准备GRE，目标320分。', 'GRE目标325分'],
    ['示例：“我喜欢简洁回答”。请分析这句话。', '喜欢简洁回答'],
    ['我想知道是否每周二晚上有社团？', '每周二晚上有社团'],
    ["I don't like coffee.", 'like coffee'],
  ])('拒绝不受原话支持的记忆：%s', (input, content) => expect(memoryWriteProblem(input, content, [])).toBeTruthy());

  it.each([
    ['我不喜欢喝咖啡。', '不喜欢喝咖啡'],
    ['我每周二晚上固定参加社团活动。', '每周二晚上固定参加社团活动'],
    ['我想申请2027春季交换，有哪些材料要准备？', '想申请2027春季交换'],
    ['I like concise answers.', 'like concise answers'],
  ])('保留有明确原话依据的事实：%s', (input, content) => expect(memoryWriteProblem(input, content, [])).toBeUndefined());

  async function memoryCase(input: string, memories: unknown[], initial?: string, response = '已查询。') {
    const r = repo(); if (initial) r.addMemory({ content: initial, type: 'interest', source: 'manual' });
    const posted: string[] = [];
    const memoryClient = { label: 'local:fixture', chat: vi.fn(async (messages: LlmMessage[]) => {
      expect(messages[0].content).not.toContain(`助理：${response}`);
      return answer(JSON.stringify({ memories }));
    }) };
    const router = { for: (task: string) => task === 'chat' ? script([() => answer(response)]) : task === 'memory_extract' ? memoryClient : null } as unknown as ModelRouter;
    const hub = { llmTools: () => [] } as unknown as McpHub;
    await new ChatAgent(r, router, hub, { ...nullChannels, messagePosted: m => posted.push(m.content) }).handleUserMessage(input);
    await new Promise<void>(resolve => setImmediate(resolve));
    return { r, posted };
  }

  it('不把演示记忆或助理建议误写成用户的新记忆', async () => {
    const { r, posted } = await memoryCase('请查询今天的课程和未来7天DDL。', [{ op: 'add', type: 'goal', content: '想申请2027春季交换' }], undefined, '建议你想申请2027春季交换。');
    expect(r.listMemories()).toEqual([]); expect(posted.some(t => t.includes('📌'))).toBe(false);
  });

  it('空格、英文大小写和全角差异不产生重复记忆或重复提示', async () => {
    const { r, posted } = await memoryCase('我对ＡＩ方向的讲座感兴趣。', [{ op: 'add', type: 'interest', content: '对ＡＩ方向的讲座感兴趣' }], '对 AI 方向的讲座感兴趣');
    expect(r.listMemories()).toHaveLength(1); expect(posted.some(t => t.includes('📌'))).toBe(false);
  });

  it('允许真实的新安排，保留来源及长期有效性，同批不重复新增', async () => {
    const content = '每周二晚上固定参加社团活动';
    const { r, posted } = await memoryCase(`我${content}。`, [{ op: 'add', type: 'schedule', content, expires_days: 7 }, { op: 'add', type: 'schedule', content: `每周二晚上 固定参加社团活动` }]);
    expect(r.listMemories()).toHaveLength(1);
    expect(r.listMemories()[0].content).toBe(content); expect(r.listMemories()[0].expiresAt).toBeUndefined();
    expect(r.getMessage(r.listMemories()[0].sourceMsgId!)?.role).toBe('user');
    expect(posted.filter(t => t.includes('📌'))).toHaveLength(1);
  });
});

describe('本地查询权限及上海时间', () => {
  const now = '2026-11-07T08:21:00Z';
  it('本周按校历周日起算，未来七天从当前时刻算起，不混用范围', () => {
    expect(queryRange('这周有哪些DDL？', now)).toEqual({ from: '2026-10-31T16:00:00.000Z', to: '2026-11-07T15:59:59.999Z' });
    expect(queryRange('从今天起未来7天的未完成作业', now)).toEqual({ from: '2026-11-07T08:21:00.000Z', to: '2026-11-14T08:21:00.000Z' });
    expect(queryRange('比较本周和下周', now)).toBeUndefined();
  });

  it('只校正明确的课程/DDL日期，不改写写工具参数', () => {
    expect(queryArguments('今天有哪些课程？', 'fudaner_local__get_today', { date: '2022-11-07' }, now)).toEqual({ date: '2026-11-07' });
    expect(queryArguments('未来7天未完成作业', 'fudaner_local__list_deadlines', { to: '2027-01-01' }, now)).toMatchObject({ to: '2026-11-14T08:21:00.000Z', pending_only: true });
    expect(queryArguments('今天创建目标', 'fudaner_local__create_goal', { title: 'GRE' }, now)).toEqual({ title: 'GRE' });
  });

  it('给模型补充上海展示时间及已结束状态，保留原始ISO值', () => {
    const text = JSON.stringify({ date: '2026-11-07', courses: [{ name: '数学分析III', time: '08:00–09:40' }], deadlines: [{ title: 'Lab 5', dueAt: '2026-11-07T15:59:00Z' }] });
    const result = JSON.parse(queryResultContext(text, now));
    expect(result.deadlines[0]).toMatchObject({ dueAt: '2026-11-07T15:59:00Z', dueAtShanghai: '2026-11-07 23:59:00（Asia/Shanghai）' });
    expect(result.courses[0].state).toBe('已结束');
    expect(queryResultContext('不是JSON', now)).toBe('不是JSON');
  });

  it('未完成筛选不会混入已完成作业', async () => {
    const r = repo(); const hub = new McpHub(); cleanups.push(() => hub.close());
    await hub.connect('fudaner-local', createLocalServer(r, nullChannels));
    for (const done of [false, true]) r.upsertItem({ source: 'elearning', kind: 'assignment', sourceId: String(done), title: done ? '已完成' : '待交', body: '', publishedAt: now, dueAt: '2026-11-07T15:59:00Z', done });
    const result = await hub.call('fudaner_local__list_deadlines', { from: now, to: '2026-11-08T00:00:00Z', pending_only: true });
    expect(result.ok).toBe(true); expect(JSON.parse(result.text).map((item: { title: string }) => item.title)).toEqual(['待交']);
  });

  it('查询问句不暴露写工具，强行写入也会被拒绝', async () => {
    const r = repo(); const hub = new McpHub(); cleanups.push(() => hub.close());
    await hub.connect('fudaner-local', createLocalServer(r, nullChannels));
    const llm = script([
      (_messages, options) => {
        expect(options?.tools?.some(t => t.function.name.endsWith('__get_today'))).toBe(true);
        expect(options?.tools?.some(t => t.function.name.endsWith('__create_goal'))).toBe(false);
        return tool('bad', 'fudaner_local__create_goal', { title: '意外目标', level: 'week' });
      },
      () => answer('仅查询。'),
    ]);
    const router = { for: (task: string) => task === 'chat' ? llm : null } as ModelRouter;
    const reply = await new ChatAgent(r, router, hub, nullChannels).handleUserMessage('这周有哪些DDL？');
    expect(r.listGoals()).toEqual([]);
    expect(reply.toolCalls.find(t => t.name === 'create_goal')).toMatchObject({ ok: false, summary: expect.stringContaining('仅允许查询') });
    expect(reply.toolCalls.some(t => t.name === 'list_deadlines' && t.ok)).toBe(true);
  });

  it('独立课程/DDL问句先真实查询，给模型的上下文不混入旧助理错误回答', async () => {
    const r = repo(); const hub = new McpHub(); cleanups.push(() => hub.close());
    await hub.connect('fudaner-local', createLocalServer(r, nullChannels));
    r.addMessage({ role: 'assistant', content: '旧错误事实标记：今晚要去火星上数学课。' });
    const call = vi.spyOn(hub, 'call');
    const llm = script([(messages) => {
      expect(call).toHaveBeenCalled();
      expect(messages.some(m => m.role === 'tool')).toBe(true);
      expect(messages.some(m => m.content?.includes('旧错误事实标记'))).toBe(false);
      return answer('已查询课程与DDL。');
    }]);
    const reply = await new ChatAgent(r, { for: task => task === 'chat' ? llm : null } as ModelRouter, hub, nullChannels).handleUserMessage('请先调用工具查询：\n1. 今天有哪些课程，分别几点开始、几点结束？\n2. 从今天起未来7天，有哪些未完成作业及截止时间？\n只根据查询结果回答。已经结束的课程请注明，不要补充没有查到的安排。');
    expect(reply.toolCalls.filter(t => t.ok).map(t => t.name)).toEqual(['get_today', 'list_deadlines']);
  });

  it('未支持的日期范围不会被预查询擅自改成七天', async () => {
    const r = repo(); const hub = new McpHub(); cleanups.push(() => hub.close());
    await hub.connect('fudaner-local', createLocalServer(r, nullChannels));
    const call = vi.spyOn(hub, 'call');
    const llm = script([messages => { expect(call).not.toHaveBeenCalled(); expect(messages.some(m => m.role === 'tool')).toBe(false); return answer(); }]);
    await new ChatAgent(r, { for: task => task === 'chat' ? llm : null } as ModelRouter, hub, nullChannels).handleUserMessage('请查询未来10天的DDL');
  });

  it('明确创建目标的请求保留写工具', async () => {
    const r = repo(); const hub = new McpHub(); cleanups.push(() => hub.close());
    await hub.connect('fudaner-local', createLocalServer(r, nullChannels));
    const llm = script([(_messages, options) => { expect(options?.tools?.some(t => t.function.name.endsWith('__create_goal'))).toBe(true); return answer(); }]);
    await new ChatAgent(r, { for: task => task === 'chat' ? llm : null } as ModelRouter, hub, nullChannels).handleUserMessage('帮我查询GRE资料，然后创建一个目标');
  });

  it('主对话 remember 也必须经过原话校验', async () => {
    const r = repo(); const hub = new McpHub(); cleanups.push(() => hub.close());
    await hub.connect('fudaner-local', createLocalServer(r, nullChannels));
    const llm = script([() => tool('bad', 'fudaner_local__remember', { type: 'goal', content: '想申请春季交换' }), () => answer()]);
    const reply = await new ChatAgent(r, { for: task => task === 'chat' ? llm : null } as ModelRouter, hub, nullChannels).handleUserMessage('帮我整理课程资料');
    expect(r.listMemories()).toEqual([]); expect(reply.toolCalls[0].ok).toBe(false);
  });

  it('16:21 的上海时间明确标注两节已结束课程', () => {
    const r = repo(); const today = buildToday(r, new Date('2026-11-07T16:21:00+08:00'));
    today.courses = [{ name: '数学分析III', time: '08:00–09:40' }, { name: '数据结构', time: '13:30–15:10' }];
    const prompt = personaPrompt({ profile: r.getProfile(), memories: [], today, nowIso: '2026-11-07T08:21:00Z' });
    expect(prompt).toContain('当前上海时间：2026-11-07 16:21:00');
    expect(prompt).toContain('08:00–09:40 数学分析III，已结束'); expect(prompt).toContain('13:30–15:10 数据结构，已结束');
  });
});
