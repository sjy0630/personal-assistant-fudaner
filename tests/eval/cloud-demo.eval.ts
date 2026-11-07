import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { expect, it, vi } from 'vitest';
import { AppContext } from '../../src/main/app-context';
import { DemoElearningClient, DemoMailClient, demoLateMail, seedDemoProfile } from '../../src/main/demo/demo';
import { localDate } from '../../src/main/engine/calendar';
import { nullChannels } from '../../src/main/engine/channels';
import { parseFile } from '../../src/main/library/parse';
import type { McpHub } from '../../src/main/mcp/hub';
import type { CardRef, ChatMessage, ModelConfig } from '../../src/shared/types';

/**
 * 按 docs/DEMO.md 的镜头顺序，用云端模型在同一个演示库里连续回放需要模型的镜头。
 * 走应用真实的 AppContext / ModelRouter / ChatAgent / TicketExecutor / 引擎，不读取应用数据库与设置。
 * 运行：EVAL_CLOUD_DEMO=1 EVAL_BASE_URL=https://api.deepseek.com EVAL_MODEL=deepseek-chat EVAL_API_KEY=...（只放环境变量）
 * 可选 EVAL_DEMO_NOW=2026-11-08T10:00:00+08:00 模拟录制时刻。
 */
const enabled = process.env.EVAL_CLOUD_DEMO === '1';
type ToolTrace = { name: string; ok: boolean; args: Record<string, unknown>; result: string };
type Shot = { id: string; passed: boolean; elapsedMs: number; checks: Record<string, boolean>; tools: ToolTrace[]; posted: { content: string; cards: string[]; actions: string[] }[]; reply?: string; resource?: { title: string; text: string }; note?: string; error?: string };

function config(): ModelConfig {
  const baseURL = process.env.EVAL_BASE_URL, model = process.env.EVAL_MODEL, apiKey = process.env.EVAL_API_KEY;
  if (!baseURL || !model || !apiKey) throw new Error('需要 EVAL_BASE_URL、EVAL_MODEL、EVAL_API_KEY');
  const url = new URL(baseURL);
  if (url.protocol !== 'https:' || url.username || url.password) throw new Error('云端地址必须是不带凭据的 https 地址');
  return { baseURL: url.href.replace(/\/$/, ''), model, apiKey };
}

const shanghai = (iso: string) => new Date(new Date(iso).getTime() + 8 * 3_600_000);

it.runIf(enabled)('云端模型按演示剧本回放镜头 3–8', async () => {
  const model = config();
  const redact = (text: string) => text.split(model.apiKey).join('***');
  const now = new Date(process.env.EVAL_DEMO_NOW ?? '2026-11-08T10:00:00+08:00');
  const allowSensitive = process.env.EVAL_ALLOW_SENSITIVE === '1';
  const suffix = allowSensitive ? '-sensitive' : '';
  vi.useFakeTimers({ toFake: ['Date'], now, shouldAdvanceTime: true });
  const posted: ChatMessage[] = [];
  const tools: ToolTrace[] = [];
  const ctx = new AppContext({
    dbPath: ':memory:', channels: { ...nullChannels, messagePosted: (m) => posted.push(m) },
    elearning: () => elearning, mail: () => mail,
  });
  const elearning = new DemoElearningClient(() => new Date());
  const mail = new DemoMailClient(() => new Date());
  const instrument = (hub: McpHub) => {
    const call = hub.call.bind(hub);
    hub.call = async (name, args) => { const r = await call(name, args); tools.push({ name, ok: r.ok, args, result: redact(r.text).slice(0, 1500) }); return r; };
  };
  const shots: Shot[] = [];
  const run = async (id: string, body: (s: Shot, used: (name: string) => ToolTrace[]) => Promise<void>) => {
    const started = performance.now(); const toolStart = tools.length; const postStart = posted.length;
    const s: Shot = { id, passed: false, elapsedMs: 0, checks: {}, tools: [], posted: [] };
    const used = (name: string) => tools.slice(toolStart).filter(t => t.ok && t.name.endsWith(`__${name}`));
    try { await body(s, used); } catch (e) { s.error = redact(String((e as Error)?.message ?? e)).slice(0, 300); }
    s.tools = tools.slice(toolStart);
    s.posted = posted.slice(postStart).map(m => ({ content: m.content, cards: m.cards.map(c => `${c.type}:${c.title}`), actions: m.actions.map(a => a.label) }));
    s.elapsedMs = Math.round(performance.now() - started);
    s.passed = !s.error && Object.keys(s.checks).length > 0 && Object.values(s.checks).every(Boolean);
    shots.push(s);
    console.log(`${id}：${s.passed ? '通过' : '未通过'}，${Math.round(s.elapsedMs / 1000)}秒，工具${s.tools.length}次${s.error ? `，错误：${s.error}` : ''}`);
  };
  const chat = async (s: Shot, text: string, refs: CardRef[] = []) => {
    const reply = await ctx.agent.handleUserMessage(text, refs);
    s.reply = reply.content;
    s.checks.answered = !!reply.content.trim() && !/回复未完成|已停止生成|步骤有点多|模型没有返回正文/.test(reply.content);
    return reply;
  };

  try {
    ctx.repo.setSettings({ demoMode: true, cloud: model, allowSensitiveToCloud: allowSensitive });
    seedDemoProfile(ctx.repo);
    await ctx.start();
    instrument(ctx.hub); instrument(ctx.executorHub);

    await run('镜头3-早安', async (s) => {
      const synced = await ctx.syncAll(); await ctx.engine.tick();
      s.checks.synced = synced.errors.length === 0;
      const morning = posted.find(m => m.role === 'assistant' && /早|今天/.test(m.content));
      s.checks.morningMessage = !!morning;
      s.note = `录制时刻 ${now.toISOString()}；早安消息只在 07:30–14:00 发送`;
    });
    await run('镜头3-就差报告', async (s, used) => {
      const reply = await chat(s, '昨晚写了一半，就差报告了');
      // 系统提示已含今天课程与空闲时段，模型可直接据此回答；查工具或答出 15:10 后空闲均算有依据。
      s.checks.groundedFreeSlot = used('get_today').length > 0 || /15[:：]10/.test(reply.content);
      s.note = used('get_today').length ? '调用了 get_today' : '未调用工具，依据系统提示中的今日安排回答';
    });
    await run('镜头3-4点提醒', async (s, used) => {
      await chat(s, '好，4 点提醒我');
      s.checks.scheduled = used('schedule_followup').length > 0;
      const due = ctx.repo.pendingFollowups().map(f => shanghai(f.dueAt).toISOString().slice(11, 16));
      s.checks.at1600 = due.includes('16:00');
      s.note = `待跟进时间（上海）：${due.join('、') || '无'}`;
    });
    await run('镜头4-补充邮件', async (s) => {
      mail.inject(demoLateMail(new Date())); await ctx.syncAll(); await ctx.engine.tick();
      s.checks.lab5Message = posted.some(m => /Lab 5/.test(m.content) && /补充|PDF|报告/.test(m.content));
    });
    await run('镜头4-交换目标', async (s, used) => {
      const card = ctx.repo.listFeed().find(c => /交换/.test(c.title));
      s.checks.exchangeCard = !!card;
      if (!card) return;
      await chat(s, '我适合报吗？如果合适帮我建个目标，排一下准备计划', [{ type: 'feed', id: card.id, title: card.title }]);
      s.checks.createdGoal = used('create_goal').length > 0;
      s.checks.addedTasks = used('add_task').length >= 2;
      const tasks = used('add_task').map(t => { try { return JSON.parse(t.result) as { title: string; dueAt?: string; goalId?: string }; } catch { return undefined; } }).filter(Boolean) as { title: string; dueAt?: string; goalId?: string }[];
      const local = tasks.filter(t => t.dueAt).map(t => shanghai(t.dueAt!));
      s.checks.avoidsTuesdayEvening = local.every(d => !(d.getUTCDay() === 2 && d.getUTCHours() >= 18));
      s.checks.avoidsAfter23 = local.every(d => d.getUTCHours() < 23 || (d.getUTCHours() === 23 && d.getUTCMinutes() === 59));
      s.checks.tasksUnderGoal = tasks.length > 0 && tasks.every(t => t.goalId && ctx.repo.getGoal(t.goalId));
      s.note = tasks.map(t => `${t.title}${t.dueAt ? ` @${shanghai(t.dueAt).toISOString().slice(0, 16)}` : ''}`).join('；');
    });
    await run('镜头5-建议工单', async (s) => {
      const suggestions = ctx.repo.listFeed().filter(c => c.actions.some(a => a.action === 'accept_ticket'));
      const card = suggestions.find(c => /交换/.test(c.title));
      s.checks.suggestionCard = !!card;
      s.note = `建议卡片：${suggestions.map(c => c.title).join('、') || '无'}`;
      if (!card) return;
      const ticketId = card.actions.find(a => a.action === 'accept_ticket')!.payload!.ticketId as string;
      ctx.repo.decideSuggestedTicket(ticketId, true, card.id);
      await ctx.executor.runNext();
      const ticket = ctx.repo.getTicket(ticketId);
      const saved = ticket?.resultResourceId ? ctx.repo.getResource(ticket.resultResourceId) : undefined;
      s.checks.done = ticket?.status === 'done';
      s.checks.saved = !!saved?.text.trim();
      s.checks.resultMessage = posted.some(m => m.cards.some(c => c.type === 'resource' && c.id === saved?.id));
      if (saved) s.resource = { title: saved.title, text: saved.text };
    });
    await run('镜头6-交作业闭环', async (s) => {
      const next = ctx.repo.listItems({ kind: 'assignment', done: false, dueAfter: new Date().toISOString(), limit: 1, dueBefore: new Date(Date.now() + 30 * 86_400_000).toISOString() })[0];
      s.checks.hasAssignment = !!next;
      if (!next) return;
      elearning.submit(next.sourceId); await ctx.syncAll(); await ctx.engine.tick();
      s.checks.closedLoop = posted.some(m => m.content.includes(next.title) && /交了|已提交|完成/.test(m.content));
      s.note = `交掉的作业：${next.title}`;
    });
    await run('镜头7-讲义出题', async (s, used) => {
      const path = fileURLToPath(new URL('../../demo-assets/数据结构-期中复习讲义.pdf', import.meta.url));
      const f = await parseFile(path);
      const res = ctx.repo.addResource({ title: f.title, kind: 'upload', mime: f.mime, text: f.text, path });
      await chat(s, '根据这份讲义出 10 道复习题，存到资源库', [{ type: 'resource', id: res.id, title: res.title }]);
      const savedId = used('save_resource').map(t => { try { return (JSON.parse(t.result) as { id?: string }).id; } catch { return undefined; } }).filter(Boolean).at(-1);
      const saved = savedId ? ctx.repo.getResource(savedId) : undefined;
      s.checks.saved = !!saved;
      const count = saved ? (saved.text.match(/^\s*(?:\d+[.、．)]|#+\s*\d+|[（(]\d+[)）]|第\s*\d+\s*题)/gmu) ?? []).length : 0;
      s.checks.tenQuestions = count >= 10;
      s.checks.searchable = ctx.repo.search('复习题').some(h => h.id === saved?.id);
      if (saved) s.resource = { title: saved.title, text: saved.text };
      s.note = `识别到题号 ${count} 个`;
    });
    await run('镜头8-考试周复习计划', async (s) => {
      ctx.repo.setKv('phase_override', 'pre_exam'); ctx.repo.resetBudget(localDate(new Date()));
      const before = posted.length;
      await ctx.engine.tick();
      const ask = posted.slice(before).find(m => m.actions.some(a => a.action === 'accept_ticket'));
      s.checks.proactiveAsk = !!ask && /考试/.test(ask.content);
      if (!ask) return;
      const ticketId = ask.actions.find(a => a.action === 'accept_ticket')!.payload!.ticketId as string;
      ctx.repo.decideSuggestedTicket(ticketId, true);
      await ctx.executor.runNext();
      const ticket = ctx.repo.getTicket(ticketId);
      const saved = ticket?.resultResourceId ? ctx.repo.getResource(ticket.resultResourceId) : undefined;
      s.checks.done = ticket?.status === 'done';
      s.checks.saved = !!saved?.text.trim();
      if (saved) s.resource = { title: saved.title, text: saved.text };
      s.note = `询问：${ask.content.slice(0, 80)}`;
    });
  } finally {
    await ctx.close();
    vi.useRealTimers();
  }

  const report = {
    generatedAt: new Date().toISOString(), model: `cloud:${model.model}`, demoNow: now.toISOString(),
    allowSensitiveToCloud: allowSensitive, localModel: false,
    passed: shots.filter(s => s.passed).length, total: shots.length, shots,
    limitations: [
      'Fictitious demo data in an in-memory database following docs/DEMO.md; no application settings, account data or real mail were read; the API key is not stored.',
      allowSensitive ? 'allowSensitiveToCloud is true: mail bodies, classification, assessment and memory extraction may be sent to the cloud model (fictitious demo data only).' : 'Sensitive tasks (mail classification, assessment, memory extraction) stay on rules because no local model is configured and allowSensitiveToCloud is false, matching a cloud-only demo setup.',
      'Automatic checks verify tool calls, persistence and visible messages; wording quality still needs human review of replies and resources.',
      'Not a rendered Electron UI check; one run per shot, model output varies between runs.',
    ],
  };
  await writeFile(new URL(`./cloud-demo-results${suffix}.json`, import.meta.url), `${redact(JSON.stringify(report, null, 2))}\n`, 'utf8');
  expect(shots.filter(s => !s.passed).map(s => s.id), `完整结果见 tests/eval/cloud-demo-results${suffix}.json`).toEqual([]);
}, 15 * 60_000);
