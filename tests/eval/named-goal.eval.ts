import { writeFile } from 'node:fs/promises';
import { expect, it } from 'vitest';
import { AppContext } from '../../src/main/app-context';
import { ChatAgent } from '../../src/main/ai/agent';
import { ModelRouter, OpenAiCompatClient, type AiTask, type LlmClient } from '../../src/main/ai/llm';
import { DemoElearningClient, DemoMailClient, seedDemoProfile } from '../../src/main/demo/demo';
import { nullChannels } from '../../src/main/engine/channels';

it.runIf(process.env.EVAL_NAMED_GOAL === '1')('本机Qwen在长历史下执行用户的非GRE目标原话', async () => {
  const phase = process.env.EVAL_PHASE === 'before' ? 'before' : 'after';
  const prompt = '帮我创建一个名为“回执验收临时目标”的长期目标，并在这个目标下添加“检查回执”任务。暂时不设置截止日期。';
  const cfg = { baseURL: 'http://127.0.0.1:11434/v1', model: 'qwen2.5:7b', apiKey: '' };
  const now = new Date('2026-11-07T17:58:00+08:00');
  const ctx = new AppContext({ dbPath: ':memory:', channels: nullChannels, elearning: () => new DemoElearningClient(() => now), mail: () => new DemoMailClient(() => now) });
  const tools: unknown[] = []; const requests: { toolCount: number; messageCount: number; inputCharacters: number }[] = [];
  const rawText: string[] = []; const visibleText: string[] = [];
  const started = performance.now();
  class Router extends ModelRouter { override for(task: AiTask) { return task === 'chat' ? super.for(task) : null; } }
  try {
    seedDemoProfile(ctx.repo); ctx.repo.setSettings({ demoMode: true });
    await ctx.start(); expect((await ctx.syncAll(now)).errors).toEqual([]);
    const exchange = ctx.repo.addGoal({ title: '申请2027春季交换', level: 'long_term', createdBy: 'user' });
    for (let i = 0; i < 10; i++) {
      ctx.repo.addMessage({ role: 'user', content: `第${i + 1}轮演示查询：请核对今天课程和未来七天的作业、邮件及任务安排。` });
      ctx.repo.addMessage({ role: 'assistant', content: ('这是之前的虚构演示记录：数学分析III在08:00至09:40，数据结构在13:30至15:10；Lab5、物理习题、英语作业、线代任务都有各自截止时间。交换目标需要查看通知、准备成绩单和个人陈述。这里是旧回答，不代表当前指令或新的授权。\n').repeat(3) });
    }
    ctx.repo.setSettings({ local: cfg });
    const actual = new OpenAiCompatClient(cfg, 'local');
    const bounded: LlmClient = { label: actual.label, async chat(messages, options) {
      const remaining = 100_000 - (performance.now() - started);
      if (remaining <= 0) throw new Error('case_budget');
      requests.push({ toolCount: options?.tools?.length ?? 0, messageCount: messages.length, inputCharacters: JSON.stringify({ messages, tools: options?.tools }).length });
      const delta = options?.onDelta;
      return actual.chat(messages, { ...options, maxTokens: 1200, signal: AbortSignal.any([AbortSignal.timeout(Math.min(40_000, Math.floor(remaining))), ...(options?.signal ? [options.signal] : [])]), onDelta: delta ? text => { rawText.push(text); delta(text); } : undefined });
    } };
    const router = new Router(() => ({ ...ctx.repo.getSettings(), cloud: undefined }), () => bounded);
    const original = ctx.hub.call.bind(ctx.hub);
    ctx.hub.call = async (name, args) => { const result = await original(name, args); tools.push({ name, args, ok: result.ok, result: result.text.slice(0, 2500) }); return result; };
    console.log(`named-goal ${phase}: modules loaded, replaying exact prompt with 20 fictitious history messages`);
    const reply = await new ChatAgent(ctx.repo, router, ctx.hub, { ...nullChannels, delta: view => visibleText.push(view.content) }).handleUserMessage(prompt);
    const goals = reply.cards.filter(c => c.type === 'goal').map(c => ctx.repo.getGoal(c.id)).filter(g => g);
    const tasks = reply.cards.filter(c => c.type === 'task').map(c => ctx.repo.getTask(c.id)).filter(t => t);
    const checks = {
      exactGoal: goals.length === 1 && goals[0]!.title === '回执验收临时目标' && goals[0]!.level === 'long_term',
      exactTask: tasks.length === 1 && tasks[0]!.title === '检查回执',
      actualParent: tasks.length === 1 && goals.length === 1 && tasks[0]!.goalId === goals[0]!.id,
      noDueDate: tasks.length === 1 && !tasks[0]!.dueAt,
      exchangeUntouched: ctx.repo.listTasks({ goalId: exchange.id }).length === 0,
      receiptAndCard: reply.content.includes('所属目标「回执验收临时目标」') && reply.cards.some(c => c.type === 'task' && c.subtitle?.includes('所属：回执验收临时目标')),
      noWrongVisibleGoal: visibleText.every(text => !text.includes('交换')),
    };
    let runtime: unknown = null;
    try { runtime = await fetch('http://127.0.0.1:11434/api/ps').then(r => r.json()); } catch { /* 仅补充观测，不影响实际结果 */ }
    await writeFile(new URL(`./named-goal-${phase}.json`, import.meta.url), `${JSON.stringify({ generatedAt: new Date().toISOString(), phase, model: 'local:qwen2.5:7b', prompt, checks, elapsedMs: Math.round(performance.now() - started), requests, tools, content: reply.content, goals, tasks, rawText: rawText.join(''), runtime, limitations: ['Exact user wording plus 20 synthetic historical messages in an isolated in-memory database; no application settings, account data or keys are read.', 'Character counts are not tokenizer counts and do not prove runtime truncation. Memory/summary generation disabled to isolate native tool execution.', 'Single non-GRE case; not all T1/T6 tasks or formal model quality.'] }, null, 2)}\n`);
    expect(Object.values(checks).every(Boolean), `完整结果已保存 named-goal-${phase}.json`).toBe(true);
  } finally { await ctx.close(); }
}, 150_000);
