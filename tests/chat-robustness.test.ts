import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppContext } from '../src/main/app-context';
import { ChatAgent, historyForModel, shrinkOldToolResults } from '../src/main/ai/agent';
import { describeModelError, ModelRouter, type LlmClient, type LlmMessage } from '../src/main/ai/llm';
import { nullChannels } from '../src/main/engine/channels';

/** 用一段时间后「回复未完成」：对话历史越来越长、原因看不到 */
describe('发给模型的历史', () => {
  it('跳过空消息和失败提示，长消息截短，总长度有上限，越新越优先', () => {
    const long = '很长'.repeat(3000);
    const h = historyForModel([
      { role: 'user', content: '最早的问题' },
      { role: 'assistant', content: long },
      { role: 'assistant', content: '' },
      { role: 'user', content: '你能看到我的排名吗' },
      { role: 'assistant', content: '> 回复未完成：连接中断或模型未能正常返回，请检查网络和模型配置后重试。' },
      { role: 'tool', content: '{}' },
      { role: 'user', content: '再试一次' },
    ], { total: 1500 });
    expect(h.map((m) => m.content)).toEqual(['你能看到我的排名吗', '再试一次']);
    expect(historyForModel([{ role: 'assistant', content: long }])[0].content).toContain('已截短');
  });

  it('一轮里工具结果太多时，较早的结果截短，最近的保留全文', () => {
    const big = 'x'.repeat(12_000);
    const messages: LlmMessage[] = Array.from({ length: 8 }, (_, i) => ({ role: 'tool' as const, tool_call_id: String(i), content: big }));
    shrinkOldToolResults(messages);
    const lens = messages.map((m) => m.content!.length);
    expect(lens.slice(-3)).toEqual([12_000, 12_000, 12_000]);
    expect(lens.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(60_000);
  });
});

describe('失败原因', () => {
  it('说清楚是什么问题', () => {
    expect(describeModelError({ status: 400, message: "This model's maximum context length is 65536 tokens" })).toEqual({ text: '这段对话太长，超出了模型一次能读的长度', contextTooLong: true });
    expect(describeModelError({ status: 401, message: 'Authentication Fails (sk-abcdefghijk)' }).text).toContain('API Key');
    expect(describeModelError({ status: 402, message: 'Insufficient Balance' }).text).toContain('余额');
    expect(describeModelError({ status: 429 }).text).toContain('频繁');
    expect(describeModelError(new Error('fetch failed')).text).toContain('网络');
    expect(describeModelError({ status: 400, message: 'bad sk-secret123456' }).text).not.toContain('secret');
  });
});

describe('超出上下文时自动缩短历史重试', () => {
  const cleanups: (() => Promise<void>)[] = [];
  afterEach(async () => { for (const c of cleanups.splice(0)) await c(); });
  it('第一次超长，缩短后成功；失败时消息里写明原因', async () => {
    const ctx = new AppContext({ dbPath: ':memory:', channels: nullChannels, elearning: () => null, mail: () => null });
    cleanups.push(() => ctx.close());
    await ctx.start();
    for (let i = 0; i < 12; i++) {
      ctx.repo.addMessage({ role: 'user', content: `问题 ${i}` });
      ctx.repo.addMessage({ role: 'assistant', content: '长回复'.repeat(800) });
    }
    const sizes: number[] = [];
    const chat = vi.fn(async (messages: LlmMessage[]) => {
      sizes.push(messages.length);
      if (sizes.length === 1) throw Object.assign(new Error('maximum context length exceeded'), { status: 400 });
      return { content: '好的，看不到排名，但可以帮你算绩点。', toolCalls: [] };
    });
    ctx.repo.setSettings({ cloud: { baseURL: 'http://127.0.0.1:1/v1', model: 'fixture', apiKey: '' } });
    const router = new ModelRouter(() => ctx.repo.getSettings(), () => ({ label: 'cloud:fixture', chat }) as LlmClient);
    const agent = new ChatAgent(ctx.repo, router, ctx.hub, nullChannels);
    const reply = await agent.handleUserMessage('你能看到我的排名吗');
    expect(reply.content).toContain('绩点');
    expect(sizes[1]).toBeLessThan(sizes[0]);

    chat.mockImplementation(async () => { throw Object.assign(new Error('Insufficient Balance'), { status: 402 }); });
    const failed = await agent.handleUserMessage('再试一次');
    expect(failed.content).toContain('余额不足');
  });
});
