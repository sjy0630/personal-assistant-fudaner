import { ipcMain, type BrowserWindow } from 'electron';
import type { FudanerApi } from '../shared/ipc';
import type { PlatformState } from '../shared/types';
import type { AppContext } from './app-context';
import type { AuthManager } from './auth/auth-manager';
import type { DemoElearningClient, DemoMailClient } from './demo/demo';
import { demoLateMail, seedDemoProfile } from './demo/demo';
import { localDate } from './engine/calendar';
import { parseFile } from './library/parse';
import { buildToday } from './today';
import { OpenAiCompatClient } from './ai/llm';

/**
 * 把 FudanerApi（src/shared/ipc.ts）逐个映射到主进程实现。
 * 通道名格式：<分组>.<方法>，如 chat.send。
 */
export function registerIpc(ctx: AppContext, opts: {
  auth: AuthManager; window: () => BrowserWindow | null;
  demo: { elearning: DemoElearningClient; mail: DemoMailClient };
  secrets: { setMailPassword(p: string): void; hasMailPassword(): boolean };
  restartScheduler(): void;
}): void {
  const { repo } = ctx;
  const handle = <T extends unknown[], R>(ch: string, fn: (...a: T) => R | Promise<R>) =>
    ipcMain.handle(ch, (_e, ...args) => fn(...(args as T)));

  type Api = FudanerApi;
  handle<Parameters<Api['chat']['history']>, ReturnType<Api['chat']['history']>>('chat.history', async (limit, aroundId) => aroundId ? repo.messagesAround(aroundId, limit ?? 100) : repo.recentMessages(limit ?? 100));
  handle<Parameters<Api['chat']['send']>, void>('chat.send', async (text, refs) => { void ctx.agent.handleUserMessage(text, refs); });
  handle<Parameters<Api['chat']['quickAction']>, void>('chat.quickAction', async (_messageId, action, payload) => {
    if (action === 'forget_memory' && payload?.id) { repo.removeMemory(String(payload.id)); return; }
    if (action === 'accept_ticket' && payload?.ticketId) { repo.setTicketStatus(String(payload.ticketId), 'queued'); void ctx.executor.runNext(); return; }
    if (action === 'decline_ticket' && payload?.ticketId) { repo.setTicketStatus(String(payload.ticketId), 'dropped'); return; }
    if (action === 'login') { await opts.auth.requestLogin(); await ctx.syncAll(); return; }
    if (action === 'say' && payload?.text) { void ctx.agent.handleUserMessage(String(payload.text)); return; }
  });
  handle('today', async () => buildToday(repo));

  handle<[{ type?: string }?], unknown>('feed.list', async (f) => repo.listFeed(f?.type));
  handle<[string, string?], void>('feed.dismiss', async (id, reason) => {
    repo.setFeedStatus(id, 'dismissed', reason);
    if (reason) repo.addMemory({ type: 'interest', content: `不关心：${reason}`, source: 'feedback' });
  });
  handle<[string, string], void>('feed.act', async (id, action) => {
    const card = repo.getFeedCard(id);
    const a = card?.actions.find((x) => x.action === action);
    if (action === 'accept_ticket' && a?.payload?.ticketId) {
      repo.setTicketStatus(String(a.payload.ticketId), 'queued');
      repo.setFeedStatus(id, 'accepted');
      void ctx.executor.runNext();
    }
  });

  handle('goals.list', async () => ({ goals: repo.listGoals(), tasks: repo.listTasks() }));
  handle<[string, 'todo' | 'done' | 'skipped'], void>('goals.setTaskStatus', async (id, status) => repo.setTaskStatus(id, status));

  handle<[string?], unknown>('library.list', async (courseId) => repo.listResources(courseId));
  handle<[string], unknown>('library.get', async (id) => repo.getResource(id) ?? null);
  handle<[string], unknown>('library.upload', async (path) => {
    const f = await parseFile(path);
    return repo.addResource({ title: f.title, kind: 'upload', mime: f.mime, text: f.text, path });
  });

  handle<[string], unknown>('search', async (q) => repo.search(q));

  handle('memory.list', async () => repo.listMemories());
  handle<[string, never], void>('memory.add', async (content, type) => { repo.addMemory({ content, type, source: 'manual' }); });
  handle<[string, string], void>('memory.update', async (id, content) => repo.updateMemory(id, content));
  handle<[string], void>('memory.remove', async (id) => repo.removeMemory(id));

  handle('profile.get', async () => repo.getProfile());
  handle<[object], void>('profile.set', async (p) => repo.setProfile(p));

  // 设置：返回给界面时隐藏 API Key
  handle('settings.get', async () => {
    const s = repo.getSettings();
    const mask = (m?: { apiKey: string }) => (m ? { ...m, apiKey: m.apiKey ? '••••••' + m.apiKey.slice(-4) : '' } : m);
    return { ...s, cloud: mask(s.cloud), local: mask(s.local) };
  });
  handle<[Record<string, unknown>], void>('settings.set', async (patch) => {
    const cur = repo.getSettings();
    for (const k of ['cloud', 'local'] as const) {
      const m = patch[k] as { apiKey?: string } | undefined;
      if (m?.apiKey?.startsWith('••••••')) m.apiKey = cur[k]?.apiKey;
    }
    repo.setSettings(patch);
    opts.restartScheduler();
  });
  handle<[string], void>('settings.setMailPassword', async (p) => opts.secrets.setMailPassword(p));
  handle<['cloud' | 'local'], { ok: boolean; message: string }>('settings.testModel', async (which) => {
    const cfg = repo.getSettings()[which];
    if (!cfg) return { ok: false, message: '还没有配置' };
    try {
      const r = await new OpenAiCompatClient(cfg, which).chat([{ role: 'user', content: '只回复两个字：你好' }], { maxTokens: 10 });
      return { ok: true, message: `连通，模型回复：${r.content.trim().slice(0, 20)}` };
    } catch (e) {
      return { ok: false, message: (e as Error).message };
    }
  });

  handle('platforms.status', async (): Promise<PlatformState[]> => {
    const s = repo.getSettings();
    if (s.demoMode) return (['elearning', 'icourse', 'mail'] as const).map((platform) => ({ platform, status: 'demo' }));
    return [
      { platform: 'elearning', status: await opts.auth.status('elearning') },
      { platform: 'icourse', status: await opts.auth.status('icourse') },
      { platform: 'mail', status: s.mail?.user && opts.secrets.hasMailPassword() ? 'ok' : 'not_configured' },
    ];
  });
  handle('platforms.login', async () => opts.auth.requestLogin());
  handle('platforms.syncNow', async () => {
    const result = await ctx.syncAll();
    await ctx.engine.tick();
    if (result.errors.length) throw new Error('同步未完成，请检查登录状态、邮箱配置和网络后重试。');
  });

  handle<[number?], unknown>('decisions', async (limit) => {
    const date = localDate(new Date());
    const b = repo.getBudget(date, () => ({ budget: 10, phase: 'regular' }));
    return { evals: repo.listEvals(limit ?? 100), budget: { date, budget: b.budget, spent: b.spent, phase: b.phase } };
  });
  handle('tickets', async () => repo.listTickets());

  // 演示与调试（设置 → 开发者）
  handle<[string], void>('dev.setDemoPhase', async (phase) => {
    repo.setKv('phase_override', phase || null);
    repo.resetBudget(localDate(new Date()));
    await ctx.engine.tick();
  });
  handle('dev.tick', async () => {
    const result = await ctx.syncAll();
    await ctx.engine.tick();
    if (result.errors.length) throw new Error('同步未完成，请检查登录状态、邮箱配置和网络后重试。');
    await ctx.executor.runNext();
  });
  handle('dev.wipe', async () => { repo.wipe(); });
  handle('dev.demoSubmitNext', async () => {
    const next = repo.listItems({ kind: 'assignment', done: false, dueAfter: new Date().toISOString(), limit: 1, dueBefore: new Date(Date.now() + 30 * 86_400_000).toISOString() })[0];
    if (next) opts.demo.elearning.submit(next.sourceId);
    await ctx.syncAll();
    await ctx.engine.tick();
  });
  // 一键重置演示：清空数据 → 重新写入演示画像 → 首次同步 → 运行一次引擎 → 刷新界面（录视频前用）
  handle('dev.resetDemo', async () => {
    repo.wipe();
    opts.demo.elearning.reset();
    opts.demo.mail.reset();
    repo.setSettings({ demoMode: true });
    seedDemoProfile(repo);
    await ctx.syncAll();
    await ctx.engine.tick();
    opts.window()?.webContents.reload();
  });
  handle('dev.demoNewMail', async () => {
    opts.demo.mail.inject(demoLateMail(new Date()));
    await ctx.syncAll();
    await ctx.engine.tick();
  });

}
