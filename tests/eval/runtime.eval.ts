import { writeFile } from 'node:fs/promises';
import { expect, it } from 'vitest';
import { AppContext } from '../../src/main/app-context';
import { ChatAgent } from '../../src/main/ai/agent';
import { ModelRouter, OpenAiCompatClient, type AiTask, type LlmClient } from '../../src/main/ai/llm';
import { DemoElearningClient, DemoMailClient, seedDemoProfile } from '../../src/main/demo/demo';
import { TicketExecutor } from '../../src/main/engine/executor';
import { nullChannels } from '../../src/main/engine/channels';
import type { McpHub } from '../../src/main/mcp/hub';
import type { ChatMessage, ModelConfig } from '../../src/shared/types';

const enabled = process.env.EVAL_RUNTIME === '1';
const now = new Date('2026-11-06T10:00:00+08:00');
const caseBudgetMs = 60_000;
type ToolTrace = { name: string; ok: boolean; args: Record<string, unknown>; result: string };
type Outcome = { id: string; passed: boolean; elapsedMs: number; checks: Record<string, boolean>; tools: ToolTrace[]; messages: { content: string; cards: ChatMessage['cards'] }[]; resource?: { title: string; text: string }; error?: string };

/** Disable incidental memory/summary model work so seven cases cannot contend for the GPU. */
class RuntimeRouter extends ModelRouter {
  override for(task: AiTask): LlmClient | null { return task === 'chat' || task === 'ticket' ? super.for(task) : null; }
}

function instrument(hub: McpHub, tools: ToolTrace[]) {
  const call = hub.call.bind(hub);
  hub.call = async (name, args) => {
    const result = await call(name, args);
    tools.push({ name, ok: result.ok, args, result: result.text.slice(0, 2000) });
    return result;
  };
}

function config(): ModelConfig {
  if (process.env.EVAL_KIND !== 'local' || !process.env.EVAL_MODEL || !process.env.EVAL_BASE_URL) throw new Error('runtime 只支持显式配置的本机 local 模型');
  let url: URL;
  try { url = new URL(process.env.EVAL_BASE_URL); } catch { throw new Error('本机 runtime 地址无效'); }
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || !['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('runtime 仅允许无凭据的本机回环地址');
  return { baseURL: url.href, model: process.env.EVAL_MODEL, apiKey: '' };
}

const cases = [
  { id: 'T1-deadlines', prompt: '这周有哪些 DDL？现在是2026年11月6日，请用工具查询作业截止后回答，不要凭记忆编造。' },
  { id: 'T1-mail', prompt: '有哪些邮件要回？请查询待处理邮件，并列出发件人和主题。' },
  { id: 'T1-plan', prompt: '帮我规划接下来七天。请先查询DDL、当天空闲时段和我的长期记忆，再给简短计划，先不要创建任务。' },
  { id: 'T1-goal', prompt: '我想准备GRE。帮我创建一个长期目标，并在该目标下面添加一个“完成一套GRE模考”的任务；完成后简短告诉我。' },
  { id: 'T1-save', prompt: '把刚才的学习计划原样存到资源库，标题为“本周学习计划”，不要只在对话里重复计划。' },
  { id: 'T6-exchange', title: '交换申请材料清单', request: '整理新加坡国立大学交换申请材料清单。先查询交换项目邮件并读取正文，再根据邮件列出材料与截止日期，缺少的信息标为待核实；调用save_resource保存完整Markdown成果。' },
  { id: 'T6-review', title: '数据结构复习提纲', request: '先查数据结构课程信息和“数据结构期中复习讲义”资源，读取讲义正文，再据此整理复习提纲。不要猜题，不扩充资料外的考试范围；调用save_resource保存完整Markdown成果。' },
] as const;

it.runIf(enabled)('本机真实模型运行五类对话工具和两类工单，失败如实记录并继续', async () => {
  const model = config();
  const results: Outcome[] = [];
  for (const scenario of cases) {
    const started = performance.now();
    const deadline = started + caseBudgetMs;
    const posted: ChatMessage[] = [];
    const tools: ToolTrace[] = [];
    const ctx = new AppContext({ dbPath: ':memory:', channels: { ...nullChannels, messagePosted: (message) => posted.push(message) }, elearning: () => new DemoElearningClient(() => now), mail: () => new DemoMailClient(() => now) });
    let outcome: Outcome;
    try {
      ctx.repo.setSettings({ demoMode: true });
      seedDemoProfile(ctx.repo);
      await ctx.start();
      const synced = await ctx.syncAll(now);
      if (synced.errors.length) throw new Error('demo_sync_failed');
      ctx.repo.addResource({ title: '数据结构期中复习讲义', kind: 'upload', mime: 'text/markdown', courseId: ctx.repo.findCourse('COMP130004.01')?.id, text: '# 数据结构期中复习讲义（虚构）\n考试范围为第1–6章。重点：顺序表、双向链表、栈与队列、二叉树遍历；复习时先画指针图，再手算遍历顺序。Lab 5涉及链表与栈，Lab 6涉及二叉树。资料没有给出具体考题。' });
      if (scenario.id === 'T1-save') ctx.repo.addMessage({ role: 'assistant', content: '学习计划：周五完成Lab 5链表与栈，周六复习数分，周日完成GRE模考。' });
      // Set only this in-memory configuration, after demo mail synchronization (which uses rules).
      ctx.repo.setSettings({ local: model });
      const actual = new OpenAiCompatClient(model, 'local');
      const bounded: LlmClient = {
        label: actual.label,
        async chat(messages, options) {
          const remaining = deadline - performance.now();
          if (remaining < 50) throw new Error('case_timeout');
          const timeout = AbortSignal.timeout(Math.max(1, Math.min(30_000, Math.floor(remaining))));
          const signal = options?.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
          return actual.chat(messages, { ...options, maxTokens: 1000, signal });
        },
      };
      const router = new RuntimeRouter(() => ctx.repo.getSettings(), () => bounded);
      instrument(ctx.hub, tools); instrument(ctx.executorHub, tools);
      let resource: Outcome['resource'];
      let checks: Record<string, boolean>;
      if ('prompt' in scenario) {
        const agent = new ChatAgent(ctx.repo, router, ctx.hub, { ...nullChannels, messagePosted: (message) => posted.push(message) });
        const reply = await agent.handleUserMessage(scenario.prompt);
        const used = (name: string) => tools.some((tool) => tool.ok && tool.name.endsWith(`__${name}`));
        checks = {
          completed: !!reply.content.trim() && !/回复未完成|已停止生成|步骤有点多/.test(reply.content),
          toolErrorsAbsent: tools.every((tool) => tool.ok),
        };
        if (scenario.id === 'T1-deadlines') checks.expectedLookup = used('list_deadlines') || used('list_assignments') || used('get_today');
        if (scenario.id === 'T1-mail') checks.expectedLookup = used('list_action_required');
        if (scenario.id === 'T1-plan') {
          checks.deadlines = used('list_deadlines') || used('list_assignments') || used('get_today');
          checks.freeSlots = used('get_today'); checks.memories = used('recall');
        }
        if (scenario.id === 'T1-goal') {
          const goal = ctx.repo.listGoals().find((goal) => goal.createdBy === 'assistant' && /GRE/i.test(goal.title));
          checks.createdGoal = used('create_goal') && !!goal;
          checks.createdTask = used('add_task') && !!goal && ctx.repo.listTasks({ goalId: goal.id }).length > 0;
          checks.goalCard = reply.cards.some((card) => card.type === 'goal');
        }
        if (scenario.id === 'T1-save') {
          const saved = ctx.repo.listResources().find((resource) => resource.kind === 'assistant_output');
          checks.saved = used('save_resource') && !!saved?.text.includes('Lab 5');
          checks.resourceCard = reply.cards.some((card) => card.type === 'resource');
          if (saved) resource = { title: saved.title, text: saved.text };
        }
      } else {
        const ticket = ctx.repo.addTicket({ title: scenario.title, request: scenario.request, status: 'queued', mandate: 'explicit' });
        const executor = new TicketExecutor(ctx.repo, router, ctx.executorHub, { ...nullChannels, messagePosted: (message) => posted.push(message) });
        const finished = await executor.runNext();
        const saved = finished?.resultResourceId ? ctx.repo.getResource(finished.resultResourceId) : undefined;
        const saveIndex = tools.findIndex((tool) => tool.ok && tool.name.endsWith('__save_resource'));
        checks = {
          done: finished?.id === ticket.id && finished.status === 'done',
          saved: !!saved?.text.trim(),
          queriedBeforeSave: saveIndex > 0 && tools.slice(0, saveIndex).some((tool) => tool.ok && /__(?:search_mail|get_mail|search_resources|read_resource|get_course|list_courses|list_assignments|list_deadlines)$/.test(tool.name)),
          singleResultMessage: posted.length === 1,
          resourceCard: posted.length === 1 && posted[0].cards.some((card) => card.type === 'resource'),
          toolErrorsAbsent: tools.every((tool) => tool.ok),
        };
        if (saved) resource = { title: saved.title, text: saved.text };
      }
      outcome = { id: scenario.id, passed: Object.values(checks).every(Boolean), elapsedMs: Math.round(performance.now() - started), checks, tools, messages: posted.map((m) => ({ content: m.content, cards: m.cards })), resource };
    } catch {
      outcome = { id: scenario.id, passed: false, elapsedMs: Math.round(performance.now() - started), checks: {}, tools, messages: posted.map((m) => ({ content: m.content, cards: m.cards })), error: 'runtime_or_setup_failed; upstream error omitted' };
    } finally { await ctx.close(); }
    results.push(outcome);
    console.log(`${outcome.id}：${outcome.passed ? '通过' : '未通过'}，${Math.round(outcome.elapsedMs / 1000)}秒，工具${tools.length}次。`);
  }
  const report = {
    generatedAt: new Date().toISOString(), model: `local:${model.model}`, referenceNow: now.toISOString(),
    passed: results.filter((r) => r.passed).length, total: results.length, results,
    limitations: [
      'Local qwen runtime smoke only; does not replace the specified DeepSeek cloud test or a rendered Electron UI check.',
      'Fictitious seeded data and controlled explicit prompts; no application account/configuration or real mail was accessed.',
      'Each case has an isolated in-memory database; incidental model memory extraction and summarization are disabled to avoid GPU contention.',
      'Per-case budget 60 seconds, per-model-call budget 30 seconds, reply limit 1000 tokens; this differs from unrestricted interactive use.',
      'Automatic pass checks verify tool calls, cards, persistence, and order; factual completeness and prose quality still require review of the recorded outputs.',
    ],
  };
  await writeFile(new URL('./runtime-results.json', import.meta.url), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  // Save every case first; a failed case must not be disguised as a successful smoke suite.
  expect(results.filter((result) => !result.passed).map((result) => result.id), '完整结果见 tests/eval/runtime-results.json').toEqual([]);
}, 8 * 60_000);
