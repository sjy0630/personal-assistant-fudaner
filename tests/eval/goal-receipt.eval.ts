import { writeFile } from 'node:fs/promises';
import { expect, it } from 'vitest';
import { AppContext } from '../../src/main/app-context';
import { ChatAgent } from '../../src/main/ai/agent';
import { ModelRouter, OpenAiCompatClient, type AiTask, type LlmClient } from '../../src/main/ai/llm';
import { DemoElearningClient, DemoMailClient, seedDemoProfile } from '../../src/main/demo/demo';
import { nullChannels } from '../../src/main/engine/channels';

it.runIf(process.env.EVAL_GOAL_RECEIPT === '1')('本机Qwen的GRE目标/任务实际关联与成功回执一致', async () => {
  const now = new Date('2026-11-07T17:15:00+08:00');
  const prompt = '我想准备 GRE，帮我建一个长期目标，并在这个目标下添加“完成一套 GRE 模考”的任务。暂时不设置截止日期。';
  const cfg = { baseURL: 'http://127.0.0.1:11434/v1', model: 'qwen2.5:7b', apiKey: '' };
  const ctx = new AppContext({ dbPath: ':memory:', channels: nullChannels, elearning: () => new DemoElearningClient(() => now), mail: () => new DemoMailClient(() => now) });
  const tools: { name: string; args: Record<string, unknown>; ok: boolean; result: string }[] = [];
  const visible: string[] = []; const rawModelText: string[] = [];
  const started = performance.now();
  class Router extends ModelRouter { override for(task: AiTask) { return task === 'chat' ? super.for(task) : null; } }
  try {
    seedDemoProfile(ctx.repo); ctx.repo.setSettings({ demoMode: true });
    await ctx.start(); expect((await ctx.syncAll(now)).errors).toEqual([]);
    const exchange = ctx.repo.addGoal({ title: '申请2027春季交换', level: 'long_term', createdBy: 'user' });
    ctx.repo.setSettings({ local: cfg });
    const actual = new OpenAiCompatClient(cfg, 'local');
    const bounded: LlmClient = { label: actual.label, async chat(messages, options) {
      const remaining = 150_000 - (performance.now() - started);
      if (remaining <= 0) throw new Error('case_budget');
      const signal = AbortSignal.any([AbortSignal.timeout(Math.min(40_000, Math.floor(remaining))), ...(options?.signal ? [options.signal] : [])]);
      const delta = options?.onDelta;
      return actual.chat(messages, { ...options, maxTokens: 1500, signal, onDelta: delta ? text => { rawModelText.push(text); delta(text); } : undefined });
    } };
    const router = new Router(() => ({ ...ctx.repo.getSettings(), cloud: undefined }), () => bounded);
    const call = ctx.hub.call.bind(ctx.hub);
    ctx.hub.call = async (name, args) => { const result = await call(name, args); tools.push({ name, args, ok: result.ok, result: result.text.slice(0, 3000) }); return result; };
    const agent = new ChatAgent(ctx.repo, router, ctx.hub, { ...nullChannels, delta: view => visible.push(view.content) });
    const reply = await agent.handleUserMessage(prompt);
    const goals = reply.cards.filter(c => c.type === 'goal').map(c => ctx.repo.getGoal(c.id)).filter(g => g && /GRE/i.test(g.title));
    const tasks = reply.cards.filter(c => c.type === 'task').map(c => ctx.repo.getTask(c.id)).filter(t => t);
    const checks = {
      oneNewGreGoal: goals.length === 1,
      oneExactTask: tasks.length === 1 && tasks[0]!.title.replace(/\s/gu, '') === '完成一套GRE模考',
      actualParentIsGre: tasks.length === 1 && goals.length === 1 && tasks[0]!.goalId === goals[0]!.id,
      exchangeUntouched: ctx.repo.listTasks({ goalId: exchange.id }).length === 0,
      dateNotInvented: tasks.length === 1 && !tasks[0]!.dueAt,
      truthfulReceipt: goals.length === 1 && reply.content.includes(`所属目标「${goals[0]!.title}」`) && !reply.content.includes('交换'),
      truthfulVisibleStream: visible.every(text => !text.includes('交换')),
      truthfulCard: goals.length === 1 && reply.cards.some(c => c.type === 'task' && c.subtitle?.includes(`所属：${goals[0]!.title}`)),
      persistedReply: ctx.repo.getMessage(reply.id)?.content === reply.content,
    };
    await writeFile(new URL('./goal-receipt-results.json', import.meta.url), `${JSON.stringify({ generatedAt: new Date().toISOString(), model: 'local:qwen2.5:7b', prompt, checks, elapsedMs: Math.round(performance.now() - started), content: reply.content, cards: reply.cards, goals, tasks, tools, rawModelText: rawModelText.join(''), limitations: ['Single fixed fictitious GRE scenario, not formal T1/T6 acceptance or rendered Electron verification.', 'Production ChatAgent and full MCP tool set; memory extraction and summary are disabled to isolate the goal receipt. No application configuration/database, real accounts or keys are read.', 'Success text is generated from persisted Repo objects; this does not certify free-form model narration accuracy.'] }, null, 2)}\n`);
    expect(Object.values(checks).every(Boolean), '完整结果已保存到 goal-receipt-results.json').toBe(true);
  } finally { await ctx.close(); }
}, 180_000);
