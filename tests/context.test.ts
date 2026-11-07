import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppContext } from '../src/main/app-context';
import { ChatAgent, historyForModel, recentFactsText, type ToolFact } from '../src/main/ai/agent';
import { ModelRouter, type LlmClient, type LlmMessage } from '../src/main/ai/llm';
import { personaPrompt } from '../src/main/ai/prompts';
import { nullChannels } from '../src/main/engine/channels';
import { buildToday } from '../src/main/today';

/** 上下文管理：记忆召回、主动消息份额、跨轮次的工具数据、提示词顺序 */
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const c of cleanups.splice(0)) await c(); });
const context = async () => {
  const ctx = new AppContext({ dbPath: ':memory:', channels: nullChannels, elearning: () => null, mail: () => null });
  cleanups.push(() => ctx.close());
  await ctx.start();
  return ctx;
};

describe('记忆召回', () => {
  it('记忆不多时全部带上', async () => {
    const ctx = await context();
    for (let i = 0; i < 12; i++) ctx.repo.addMemory({ type: 'interest', content: `兴趣 ${i}`, source: 'manual' });
    expect(ctx.repo.recallMemories('随便问一句')).toHaveLength(12);
  });

  it('记忆多时按中文片段挑相关的（原来整句当一个词，几乎匹配不上）', async () => {
    const ctx = await context();
    for (let i = 0; i < 40; i++) ctx.repo.addMemory({ type: 'status', content: `无关的记录第${i}条`, source: 'manual' });
    ctx.repo.addMemory({ type: 'goal', content: '想申请 2027 春季交换', source: 'chat' });
    ctx.repo.addMemory({ type: 'interest', content: '在准备雅思考试', source: 'chat' });
    const r = ctx.repo.recallMemories('交换项目一般什么时候截止申请？');
    expect(r[0].content).toBe('想申请 2027 春季交换');
    expect(ctx.repo.recallMemories('雅思口语怎么练')[0].content).toBe('在准备雅思考试');
  });
});

describe('对话历史里的主动消息', () => {
  it('只带 12 小时内最多 4 条主动消息，不挤掉对话', () => {
    const now = Date.parse('2026-11-08T12:00:00Z');
    const at = (h: number) => new Date(now - h * 3_600_000).toISOString();
    const history = [
      { role: 'assistant', content: '昨天的提醒', proactive: true, createdAt: at(20) },
      { role: 'user', content: '我想选数据结构', createdAt: at(10) },
      ...Array.from({ length: 6 }, (_, i) => ({ role: 'assistant', content: `提醒 ${i}`, proactive: true, createdAt: at(5 - i * 0.5) })),
      { role: 'user', content: '刚才说的课呢', createdAt: at(0) },
    ];
    const h = historyForModel(history, { now }).map((m) => m.content);
    expect(h).toEqual(['我想选数据结构', '提醒 2', '提醒 3', '提醒 4', '提醒 5', '刚才说的课呢']);
  });
});

describe('跨轮次的工具数据', () => {
  it('上一轮查到的数据下一轮还在提示里；敏感工具的结果不记', async () => {
    const ctx = await context();
    const prompts: string[] = [];
    let turn = 0;
    const chat = vi.fn(async (messages: LlmMessage[]) => {
      prompts.push(messages[0].content as string);
      turn++;
      if (turn === 1) return { content: '', toolCalls: [{ id: 'a', name: 'fudaner_local__get_today', arguments: '{}' }] };
      if (turn === 2) return { content: '今天没课。', toolCalls: [] };
      return { content: '好的。', toolCalls: [] };
    });
    ctx.repo.setSettings({ cloud: { baseURL: 'http://127.0.0.1:1/v1', model: 'fixture', apiKey: '' } });
    const router = new ModelRouter(() => ctx.repo.getSettings(), () => ({ label: 'cloud:fixture', chat }) as LlmClient);
    const agent = new ChatAgent(ctx.repo, router, ctx.hub, nullChannels);
    await agent.handleUserMessage('今天有什么课');
    await agent.handleUserMessage('那明天呢');
    expect(prompts[2]).toContain('最近几轮查过的数据');
    expect(prompts[2]).toContain('fudaner-local/get_today');
    expect(recentFactsText([{ tool: 'x', text: 'old', at: new Date(Date.now() - 7 * 3_600_000).toISOString() } satisfies ToolFact])).toBe('');
  });
});

describe('提示词顺序', () => {
  it('常变的内容（连接状态、时间）放在画像和记忆后面', async () => {
    const ctx = await context();
    const prompt = personaPrompt({ profile: ctx.repo.getProfile(), memories: [], today: buildToday(ctx.repo), nowIso: new Date().toISOString(), platforms: [{ platform: 'elearning', status: 'ok' }] });
    expect(prompt.indexOf('平台连接状态')).toBeGreaterThan(prompt.indexOf('用户画像'));
    expect(prompt.indexOf('平台连接状态')).toBeGreaterThan(prompt.indexOf('应用使用说明'));
  });
});
