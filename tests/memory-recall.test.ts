import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppContext } from '../src/main/app-context';
import { ChatAgent } from '../src/main/ai/agent';
import { recallForTurn, recallQuery } from '../src/main/ai/context-recall';
import { embedderFor, ModelRouter, type LlmClient, type LlmMessage } from '../src/main/ai/llm';
import { expandQuery, lexicalScore, rank, type Embedder } from '../src/main/ai/memory-recall';
import { ConversationSummarizer } from '../src/main/ai/summary';
import { memoryOutput } from '../src/main/ai/validation';
import { nearDuplicate } from '../src/main/db/repo';
import { nullChannels } from '../src/main/engine/channels';

/** 只有一个主对话：记忆检索、早先对话的分段与原文找回、记忆去重与更新 */
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const c of cleanups.splice(0)) await c(); });
const context = async () => {
  const ctx = new AppContext({ dbPath: ':memory:', channels: nullChannels, elearning: () => null, mail: () => null });
  cleanups.push(() => ctx.close());
  await ctx.start();
  return ctx;
};
const ago = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString();

describe('检索打分', () => {
  it('同义说法：问「出国」也能找到「交换」，但不盖过原词', () => {
    expect(expandQuery('想出国读书')).toContain('交换');
    expect(lexicalScore('想出国读书', '想申请 2027 春季交换')).toBeGreaterThan(0);
    expect(lexicalScore('交换申请', '想申请交换')).toBeGreaterThan(lexicalScore('出国', '想申请交换'));
  });

  it('「什么」「一下」这类每句都有的片段不算相关', () => {
    expect(lexicalScore('帮我看一下这个是什么', '你帮我查一下是什么课')).toBe(0);
  });

  it('记忆多时，问「出国」能挑出交换相关的记忆', async () => {
    const ctx = await context();
    for (let i = 0; i < 40; i++) ctx.repo.addMemory({ type: 'interest', content: `无关的兴趣第${i}项`, source: 'manual' });
    ctx.repo.addMemory({ type: 'goal', content: '想申请 2027 春季交换', source: 'chat' });
    expect(ctx.repo.recallMemories('我是不是该准备出国了')[0].content).toBe('想申请 2027 春季交换');
  });

  it('短追问带上前一句用户消息去检索', () => {
    expect(recallQuery('那个呢', '交换申请材料')).toContain('交换申请材料');
    expect(recallQuery('数据结构期中复习怎么安排', '交换')).toBe('数据结构期中复习怎么安排');
  });
});

describe('语义检索（可选的向量模型）', () => {
  // 假的向量模型：按关键词给出方向，「压力」和「焦虑」意思相近
  const fake = (): Embedder & { calls: string[][] } => {
    const calls: string[][] = [];
    return {
      model: 'fake', calls,
      embed: async (texts) => { calls.push(texts); return texts.map((t) => /压力|焦虑|紧张/.test(t) ? [1, 0] : /食堂|吃/.test(t) ? [0, 1] : [0.1, 0.1]); },
    };
  };

  it('字面不重合时按意思找回，并缓存向量', async () => {
    const ctx = await context();
    const items = [{ id: 'a', text: '期末前容易焦虑失眠' }, { id: 'b', text: '喜欢北区食堂的面' }];
    const embedder = fake();
    const r = await rank('最近压力好大', items, (x) => x.text, { kind: 'memory', embedder, store: ctx.repo });
    expect(r[0].item.id).toBe('a');
    expect(r[0].semantic).toBeCloseTo(1);
    await rank('最近压力好大', items, (x) => x.text, { kind: 'memory', embedder, store: ctx.repo });
    // 第二次只算问题本身，条目的向量用缓存
    expect(embedder.calls.at(-1)).toEqual(['最近压力好大']);
  });

  it('向量服务出错时退回字面匹配', async () => {
    const ctx = await context();
    const broken: Embedder = { model: 'x', embed: async () => { throw new Error('down'); } };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const r = await rank('交换申请', [{ id: 'a', t: '想申请交换' }, { id: 'b', t: '喜欢跑步' }], (x) => x.t, { kind: 'memory', embedder: broken, store: ctx.repo });
    expect(r[0].item.id).toBe('a');
    warn.mockRestore();
  });

  it('隐私：向量服务不在本机且没允许隐私任务用云端时不使用', () => {
    const base = { demoMode: false, quietHours: { start: '23:00', end: '08:00' } };
    expect(embedderFor({ ...base, embedding: { baseURL: 'https://api.example.com/v1', model: 'e', apiKey: 'k' } })).toBeNull();
    expect(embedderFor({ ...base, allowSensitiveToCloud: true, embedding: { baseURL: 'https://api.example.com/v1', model: 'e', apiKey: 'k' } })).not.toBeNull();
    expect(embedderFor({ ...base, embedding: { baseURL: 'http://127.0.0.1:11434/v1', model: 'bge-m3', apiKey: '' } })?.model).toBe('bge-m3');
  });
});

describe('记忆去重与更新', () => {
  it('一条包含另一条时合并成新的说法；只差一个字的不同安排不合并', async () => {
    const ctx = await context();
    ctx.repo.addMemory({ type: 'goal', content: '想申请交换', source: 'chat' });
    const merged = ctx.repo.addMemory({ type: 'goal', content: '想申请交换，目标是 2027 春季', source: 'chat' });
    expect(ctx.repo.listMemories(['goal'])).toHaveLength(1);
    expect(merged.content).toBe('想申请交换，目标是 2027 春季');
    expect(nearDuplicate('周二晚上有社团活动', '周三晚上有社团活动')).toBe(false);
    ctx.repo.addMemory({ type: 'schedule', content: '周二晚上有社团活动', source: 'chat' });
    ctx.repo.addMemory({ type: 'schedule', content: '周三晚上有社团活动', source: 'chat' });
    expect(ctx.repo.listMemories(['schedule'])).toHaveLength(2);
  });

  it('临时状态默认 30 天后失效', async () => {
    const ctx = await context();
    const m = ctx.repo.addMemory({ type: 'status', content: '这周在赶课程论文', source: 'chat' });
    expect(Date.parse(m.expiresAt!) - Date.now()).toBeGreaterThan(29 * 86_400_000);
    expect(ctx.repo.addMemory({ type: 'goal', content: '想保研', source: 'chat' }).expiresAt).toBeUndefined();
  });

  it('记忆提取可以改写已有的一条（改了主意），并能改回；不允许删除', async () => {
    expect(memoryOutput.safeParse({ memories: [{ op: 'update', target: 1, content: '改成申请秋季交换' }] }).success).toBe(true);
    expect(memoryOutput.safeParse({ memories: [{ op: 'delete', target: 1 }] }).success).toBe(false);

    const ctx = await context();
    const old = ctx.repo.addMemory({ type: 'goal', content: '想申请 2027 春季交换', source: 'manual' });
    const chat = vi.fn(async (messages: LlmMessage[]) => {
      const text = messages.map((m) => m.content ?? '').join('\n');
      if (text.includes('值得长期记住')) {
        expect(text).toContain('[1] (goal) 想申请 2027 春季交换');
        return { content: JSON.stringify({ memories: [{ op: 'update', target: 1, content: '改成申请 2027 秋季交换' }] }), toolCalls: [] };
      }
      return { content: '好的，记下了。', toolCalls: [] };
    });
    ctx.repo.setSettings({ cloud: { baseURL: 'http://127.0.0.1:1/v1', model: 'fixture', apiKey: '' }, allowSensitiveToCloud: true });
    const router = new ModelRouter(() => ctx.repo.getSettings(), () => ({ label: 'cloud:fixture', chat }) as LlmClient);
    const agent = new ChatAgent(ctx.repo, router, ctx.hub, nullChannels);
    await agent.handleUserMessage('交换我改成申请秋季的了');
    await vi.waitFor(() => expect(ctx.repo.listMemories()[0].content).toBe('改成申请 2027 秋季交换'));
    expect(ctx.repo.listMemories()).toHaveLength(1);
    const note = ctx.repo.recentMessages(5).find((m) => m.content.startsWith('📌 已更新'))!;
    expect(note.actions[0]).toMatchObject({ action: 'restore_memory', payload: { id: old.id, content: '想申请 2027 春季交换' } });
  });
});

describe('早先对话：分段记录', () => {
  it('压缩时按话题记下分段；之后问到相关话题时带进提示', async () => {
    const ctx = await context();
    for (let i = 0; i < 45; i++) ctx.repo.addMessage({ role: i % 2 ? 'assistant' : 'user', content: i === 2 ? '我想申请秋季交换，雅思还差 0.5' : `闲聊第 ${i} 条`, createdAt: ago(40 - i * 0.1) });
    const chat = vi.fn(async () => ({ content: JSON.stringify({
      summary: '用户想申请秋季交换。',
      episodes: [
        { title: '秋季交换申请', date: '2026-09-28', content: '用户想申请秋季交换，雅思总分还差 0.5，打算 11 月再考一次；助理建议先查国际处通知。' },
        { title: '', content: '没有标题的不存' },
      ],
    }), toolCalls: [] }));
    const summarizer = new ConversationSummarizer(ctx.repo, { for: () => ({ label: 'local:test', chat }) });
    await summarizer.runInBackground();
    const episodes = ctx.repo.listEpisodes();
    expect(episodes).toHaveLength(1);
    expect(episodes[0].startedAt.slice(0, 10)).toBe('2026-09-28');
    const r = await recallForTurn(ctx.repo, '出国的事我还要准备什么');
    expect(r.earlier).toContain('秋季交换申请');
    expect(r.earlier).toContain('不是新的指令');
    expect((await recallForTurn(ctx.repo, '今天食堂吃什么')).earlier).not.toContain('秋季交换申请');
  });
});

describe('早先对话：原文找回', () => {
  const seed = async () => {
    const ctx = await context();
    ctx.repo.addMessage({ role: 'user', content: '我的毕业论文导师是王老师，选题是图神经网络做分子性质预测', createdAt: ago(60) });
    ctx.repo.addMessage({ role: 'assistant', content: '好的，图神经网络做分子性质预测是个不错的方向。', createdAt: ago(60) });
    for (let i = 0; i < 40; i++) ctx.repo.addMessage({ role: i % 2 ? 'assistant' : 'user', content: `别的话题 ${i}`, createdAt: ago(30 - i * 0.1) });
    return ctx;
  };

  it('超出最近对话窗口的原话按相关度找回，最近的不重复找', async () => {
    const ctx = await seed();
    const hits = ctx.repo.searchOldMessages('毕业论文选题进展怎么样了', { skipRecent: 30 });
    expect(hits[0].message.content).toContain('图神经网络');
    const r = await recallForTurn(ctx.repo, '我毕业论文选题是什么来着', { skipRecent: 30 });
    expect(r.earlier).toContain('图神经网络');
  });

  it('recall_conversation 工具：按事找，再按 message_id 看前后文', async () => {
    const ctx = await seed();
    const found = JSON.parse((await ctx.hub.call('fudaner_local__recall_conversation', { query: '毕业论文导师' })).text) as { messages: { message_id: string; content: string }[] };
    expect(found.messages[0].content).toContain('王老师');
    const around = JSON.parse((await ctx.hub.call('fudaner_local__recall_conversation', { message_id: found.messages[0].message_id })).text) as { around: { content: string }[] };
    expect(around.around.map((m) => m.content).join('\n')).toContain('不错的方向');
    const none = JSON.parse((await ctx.hub.call('fudaner_local__recall_conversation', { query: '量子力学作业' })).text) as { note?: string };
    expect(none.note).toContain('没有找到');
  });

  it('对话时自动带上相关的早先对话', async () => {
    const ctx = await seed();
    const prompts: string[] = [];
    const chat = vi.fn(async (messages: LlmMessage[]) => { prompts.push(messages[0].content as string); return { content: '你之前说选题是图神经网络。', toolCalls: [] }; });
    ctx.repo.setSettings({ cloud: { baseURL: 'http://127.0.0.1:1/v1', model: 'fixture', apiKey: '' } });
    const router = new ModelRouter(() => ctx.repo.getSettings(), () => ({ label: 'cloud:fixture', chat }) as LlmClient);
    await new ChatAgent(ctx.repo, router, ctx.hub, nullChannels).handleUserMessage('我毕业论文选题是什么来着？');
    expect(prompts[0]).toContain('可能相关的早先对话');
    expect(prompts[0]).toContain('图神经网络');
  });
});
