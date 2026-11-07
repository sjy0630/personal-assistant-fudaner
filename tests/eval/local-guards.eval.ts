import { writeFile } from 'node:fs/promises';
import { expect, it, vi } from 'vitest';
import { AppContext } from '../../src/main/app-context';
import { ChatAgent } from '../../src/main/ai/agent';
import { ModelRouter, OpenAiCompatClient, type AiTask } from '../../src/main/ai/llm';
import { DemoElearningClient, DemoMailClient, seedDemoProfile } from '../../src/main/demo/demo';
import { nullChannels } from '../../src/main/engine/channels';

const enabled = process.env.EVAL_LOCAL_GUARDS === '1';
const now = new Date('2026-11-07T16:21:00+08:00');
const prompts = [
  '这周有哪些 DDL？',
  '请先调用工具查询：\n1. 今天有哪些课程，分别几点开始、几点结束？\n2. 从今天起未来7天，有哪些未完成作业及截止时间？\n只根据查询结果回答。已经结束的课程请注明，不要补充没有查到的安排。',
];

it.runIf(enabled)('本机 Qwen 复测重复查询、事实回答和无关记忆', async () => {
  // 固定为回环服务；不读取应用配置、云端环境变量或真实数据。
  const cfg = { baseURL: 'http://127.0.0.1:11434/v1', model: 'qwen2.5:7b', apiKey: '' };
  const phase = process.env.EVAL_PHASE === 'before' ? 'before' : 'after';
  const trace: { name: string; args: Record<string, unknown>; ok: boolean }[] = [];
  const pending: Promise<unknown>[] = [];
  const ctx = new AppContext({ dbPath: ':memory:', channels: nullChannels,
    elearning: () => new DemoElearningClient(() => now), mail: () => new DemoMailClient(() => now) });
  class LocalRouter extends ModelRouter {
    override for(task: AiTask) { return task === 'chat' || task === 'memory_extract' ? super.for(task) : null; }
  }
  const router = new LocalRouter(() => ({ ...ctx.repo.getSettings(), cloud: undefined }), (config, kind) => {
    const client = new OpenAiCompatClient(config, kind);
    return { label: client.label, chat: (messages, options) => {
      const signal = AbortSignal.any([AbortSignal.timeout(40_000), ...(options?.signal ? [options.signal] : [])]);
      const request = client.chat(messages, { ...options, maxTokens: 1500, signal });
      pending.push(request.catch(() => undefined));
      return request;
    } };
  });
  const results: { prompt: string; content: string; tools: unknown; checks: Record<string, boolean>; elapsedMs: number }[] = [];
  try {
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(now);
    seedDemoProfile(ctx.repo); ctx.repo.setSettings({ demoMode: true });
    await ctx.start();
    const sync = await ctx.syncAll(now);
    expect(sync.errors).toEqual([]);
    ctx.repo.setSettings({ local: cfg });
    const initialMemories = ctx.repo.listMemories().map(m => m.id);
    const call = ctx.hub.call.bind(ctx.hub);
    ctx.hub.call = async (name, args) => { const result = await call(name, args); trace.push({ name, args, ok: result.ok }); return result; };
    const agent = new ChatAgent(ctx.repo, router, ctx.hub, nullChannels);
    console.log(`local-guards ${phase}: production modules loaded; starting two screenshot prompts`);
    for (const prompt of prompts) {
      const started = performance.now();
      const reply = await agent.handleUserMessage(prompt);
      await Promise.all(pending);
      const checks = {
        finishedAnswer: !/步骤有点多|尚未完成|回复未完成|模型没有返回正文/.test(reply.content),
        structuredReply: !/<\/?tool_call>/.test(reply.content),
        queried: reply.toolCalls.some(t => t.ok && /list_deadlines|list_assignments|get_today/.test(t.name)),
        noNewMemories: ctx.repo.listMemories().every(m => initialMemories.includes(m.id)),
        noEveningMath: !/今晚.{0,12}(?:数学分析|数分)|(?:数学分析|数分).{0,12}今晚/.test(reply.content),
        noUnrequestedWrites: !reply.toolCalls.some(t => t.ok && /create_goal|add_task|remember|save_resource|mark_item_done/.test(t.name)),
        deadlineFact: reply.content.split('\n').some(line => /Lab\s*5/i.test(line) && /23:59/.test(line)),
        ...(prompt === prompts[1] ? {
          queriedCourses: reply.toolCalls.some(t => t.ok && t.name === 'get_today'),
          courseTimes: /08:00|8:00/.test(reply.content) && /09:40|9:40/.test(reply.content) && /13:30/.test(reply.content) && /15:10/.test(reply.content),
          endedCourses: /已结束|已经结束|已上完|已经上完/.test(reply.content),
        } : {}),
      };
      results.push({ prompt, content: reply.content, tools: reply.toolCalls, checks, elapsedMs: Math.round(performance.now() - started) });
      console.log(`local-guards ${phase}: ${Object.entries(checks).filter(([, ok]) => !ok).map(([key]) => key).join(',') || 'checks passed'}`);
    }
    const report = { generatedAt: new Date(vi.getRealSystemTime()).toISOString(), phase, model: 'local:qwen2.5:7b', referenceNow: now.toISOString(), results, actualMcpCalls: trace,
      limitations: ['Two fixed fictitious screenshot scenarios only; not formal mail accuracy, full tool/work-order acceptance or a rendered Electron UI check.', 'Memory extraction enabled; summary model disabled to isolate the reported symptoms. API calls capped at 40s and 1500 tokens.'] };
    await writeFile(new URL(`./local-guards-${phase}.json`, import.meta.url), `${JSON.stringify(report, null, 2)}\n`);
    expect(results.every(r => Object.values(r.checks).every(Boolean)), '完整失败结果已保存在 local-guards JSON 中').toBe(true);
  } finally { await Promise.all(pending); vi.useRealTimers(); await ctx.close(); }
}, 240_000);
