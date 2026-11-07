import { isDeepStrictEqual } from 'node:util';
import { ipcMain, type BrowserWindow } from 'electron';
import type { FudanerApi } from '../shared/ipc';
import type { ChatMessage, ExternalMcpConfig, PlatformState } from '../shared/types';
import type { AppContext } from './app-context';
import type { AuthManager } from './auth/auth-manager';
import type { DemoElearningClient, DemoMailClient } from './demo/demo';
import { demoLateMail, seedDemoProfile } from './demo/demo';
import { NOTICE_SOURCES } from './notices/sources';
import { EXTERNAL_PRESETS, sanitizeExternal } from './mcp/external';
import { enabledNoticeSources } from './notices/sync';
import { localDate } from './engine/calendar';
import { parseFile } from './library/parse';
import { buildToday } from './today';
import { OpenAiCompatClient } from './ai/llm';
import { resolveChatReference } from './chat/references';

/**
 * 把 FudanerApi（src/shared/ipc.ts）逐个映射到主进程实现。
 * 通道名格式：<分组>.<方法>，如 chat.send。
 */
export function registerIpc(ctx: AppContext, opts: {
  auth: AuthManager; window: () => BrowserWindow | null;
  demo: { elearning: DemoElearningClient; mail: DemoMailClient };
  secrets: { setMailPassword(p: string): void; hasMailPassword(): boolean };
  restartScheduler(): void;
  openExternal?(url: string): Promise<unknown>;
  copyText?(text: string): void;
  onMessageUpdated?(message: ChatMessage): void;
  onChatCleared?(): void;
  onChanged?(what: 'goals' | 'library' | 'feed'): void;
}): void {
  const { repo } = ctx;
  let pendingUploads = 0;
  const handle = <T extends unknown[], R>(ch: string, fn: (...a: T) => R | Promise<R>) =>
    ipcMain.handle(ch, (_e, ...args) => fn(...(args as T)));

  type Api = FudanerApi;
  handle<Parameters<Api['chat']['page']>, ReturnType<Api['chat']['page']>>('chat.page', async (beforeId, limit) => repo.messagePage(beforeId, limit));
  handle<Parameters<Api['references']['open']>, ReturnType<Api['references']['open']>>('references.open', async (ref) => {
    const target = resolveChatReference(repo, ref);
    if (target.kind === 'external') {
      if (!opts.openExternal) throw new Error('暂时无法打开原文，请重试。');
      await opts.openExternal(target.url);
    }
    return target;
  });
  handle<Parameters<Api['chat']['undoResult']>, ReturnType<Api['chat']['undoResult']>>('chat.undoResult', async (messageId, type, id) => {
    if (ctx.agent.state()) throw new Error('请等待当前回复完成后再撤销。');
    const message = repo.undoMessageResult(messageId, type, id);
    opts.onMessageUpdated?.(message);
    opts.onChanged?.(type === 'resource' ? 'library' : 'goals');
    return message;
  });
  handle<Parameters<Api['chat']['history']>, ReturnType<Api['chat']['history']>>('chat.history', async (limit, aroundId) => aroundId ? repo.messagesAround(aroundId, limit ?? 100) : repo.recentMessages(limit ?? 100));
  handle<Parameters<Api['chat']['send']>, void>('chat.send', async (text, refs) => { await ctx.agent.handleUserMessage(text, refs); });
  handle('chat.state', async () => ctx.agent.state());
  handle<[string], void>('chat.cancel', async (id) => ctx.agent.cancel(id));
  const activeActions = new Set<string>();
  const decideTicket = (ticketId: string, accept: boolean, feedId?: string) => {
    for (const message of repo.decideSuggestedTicket(ticketId, accept, feedId)) opts.onMessageUpdated?.(message);
    opts.onChanged?.('feed');
    if (accept) void ctx.executor.runNext().catch(() => undefined);
  };
  handle<Parameters<Api['chat']['quickAction']>, void>('chat.quickAction', async (messageId, action, payload) => {
    const message = repo.getMessage(messageId);
    const button = message?.actions.find((candidate) => candidate.action === action && isDeepStrictEqual(candidate.payload ?? {}, payload ?? {}));
    if (message?.role !== 'assistant' || !button) throw new Error('这条消息没有该快捷操作。');
    if (button.used || activeActions.has(messageId)) throw new Error('该操作已处理或正在执行。');
    activeActions.add(messageId);
    try {
      const data = button.payload;
      const markUsed = () => {
        message.actions = message.actions.map((entry) => entry === button ? { ...entry, used: true } : entry);
        repo.updateMessageActions(message.id, message.actions);
      };
      if ((action === 'accept_ticket' || action === 'decline_ticket') && typeof data?.ticketId === 'string') {
        decideTicket(data.ticketId, action === 'accept_ticket');
        return;
      }
      if (action === 'login') { await opts.auth.requestLogin(); await ctx.syncAll(); return; }
      if (action === 'say' && typeof data?.text === 'string') {
        await ctx.agent.handleUserMessage(data.text);
        markUsed();
      } else {
        repo.db.tx(() => {
          if (action === 'forget_memory' && typeof data?.id === 'string') {
            const memory = repo.listMemories().find((entry) => entry.id === data.id);
            if (memory?.source === 'chat') repo.removeMemory(data.id);
          } else throw new Error('此快捷操作暂不可用。');
          markUsed();
        });
      }
      opts.onMessageUpdated?.(message);
    } finally { activeActions.delete(messageId); }
  });
  handle<Parameters<Api['copyText']>, void>('copyText', (text) => {
    if (typeof text !== 'string' || !opts.copyText) throw new Error('暂时无法复制回答。');
    opts.copyText(text);
  });
  handle('today', async () => buildToday(repo));

  handle<Parameters<Api['feed']['list']>, ReturnType<Api['feed']['list']>>('feed.list', async (filter) => {
    const cards = repo.listFeed(filter?.type);
    const target = filter?.includeId && !filter.type ? repo.getFeedCard(filter.includeId) : undefined;
    return target && target.status !== 'dismissed' && !cards.some((card) => card.id === target.id) ? [...cards, target] : cards;
  });
  handle<[string, string?], void>('feed.dismiss', async (id, reason) => {
    const card = repo.getFeedCard(id);
    repo.setFeedStatus(id, 'dismissed', reason);
    // 不感兴趣的活动以后不再推荐，也不再出现在活动列表里（重复导入同一篇文章也不会）
    for (const ref of card?.refs ?? []) {
      if (ref.type === 'item' && repo.getItem(ref.id)?.kind === 'activity') repo.markItemDone(ref.id, true);
    }
    if (reason) repo.addMemory({ type: 'interest', content: `不关心：${reason}`, source: 'feedback' });
  });
  handle<[string, string], void>('feed.act', async (id, action) => {
    const card = repo.getFeedCard(id);
    if (!card || card.status === 'dismissed') throw new Error('这条动态已不存在或已忽略。');
    const a = card.actions.find((x) => x.action === action);
    if (action === 'accept_ticket' && typeof a?.payload?.ticketId === 'string') {
      decideTicket(a.payload.ticketId, true, id);
    }
    // 在本地标记邮件已处理 / 作业已完成（不改邮箱和 eLearning）
    if (action === 'mark_done' && typeof a?.payload?.itemId === 'string') {
      if (!repo.markItemDone(a.payload.itemId, true)) throw new Error('对应的邮件或作业已不存在。');
      repo.setFeedStatus(id, 'accepted');
      opts.onChanged?.('feed');
      opts.onChanged?.('goals');
    }
    // 把活动加入「校园活动」目标
    if (action === 'add_to_plan' && typeof a?.payload?.itemId === 'string') {
      if (!repo.addActivityToPlan(a.payload.itemId)) throw new Error('这场活动已不存在。');
      repo.setFeedStatus(id, 'accepted');
      opts.onChanged?.('feed');
      opts.onChanged?.('goals');
    }
  });

  handle('goals.list', async () => ({ goals: repo.listGoals(), tasks: repo.listTasks() }));
  handle<[string, 'todo' | 'done' | 'skipped'], void>('goals.setTaskStatus', async (id, status) => repo.setTaskStatus(id, status));

  handle<[string?], unknown>('library.list', async (courseId) => repo.listResources(courseId));
  handle<[string], unknown>('library.get', async (id) => repo.getResource(id) ?? null);
  handle<[string], void>('library.remove', (id) => repo.removeResource(id));
  handle<[string], unknown>('library.upload', async (path) => {
    pendingUploads++;
    try {
      const f = await parseFile(path);
      const resource = repo.addResource({ title: f.title, kind: 'upload', mime: f.mime, text: f.text, path });
      opts.onChanged?.('library');
      return resource;
    } finally { pendingUploads--; }
  });

  handle<[string], unknown>('search', async (q) => repo.search(q));
  handle<Parameters<Api['searchDetail']>, string | null>('search.detail', (type, id) => {
    switch (type) {
      case 'message': return repo.getMessage(id)?.content ?? null;
      case 'feed': return repo.getFeedCard(id)?.body ?? null;
      case 'goal': return repo.getGoal(id)?.description ?? null;
      case 'task': return repo.getTask(id)?.title ?? null;
      case 'resource': return repo.getResource(id)?.text ?? null;
      case 'item': return repo.getItem(id)?.body ?? null;
      case 'memory': return repo.listMemories().find((memory) => memory.id === id)?.content ?? null;
      default: return null;
    }
  });

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
    // 外部服务会启动本机程序，只能通过 external.save（有字段校验）修改
    delete patch.externalMcp;
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

  handle('platforms.status', async (): Promise<PlatformState[]> => ctx.platformStatus(true));
  handle('platforms.login', async () => opts.auth.requestLogin());
  handle('platforms.syncNow', async () => {
    const result = await ctx.syncAll(new Date(), { force: true });
    await ctx.engine.tick();
    if (result.errors.length) throw new Error(`请检查登录状态、邮箱配置和网络后重新同步。${result.errors.join('；')}`);
  });

  // 课表、考试、校园卡、图书馆：错误改写成以「请」开头的说明，渲染进程原样显示
  const campusCall = <T>(run: () => Promise<T>) => run().catch((e: Error) => {
    if (e.name === 'NeedLoginError') throw new Error('请先在上方重新登录复旦账号（登录已过期或还没登录）。');
    throw new Error(e.message.startsWith('请') ? e.message : `请稍后重试：${e.message}`);
  });
  handle<[], unknown>('campus.status', async () => ({
    timetable: repo.getKv('timetable_meta', null), exams: repo.getKv('exam_meta', null), problems: repo.getKv('campus_problems', {}),
  }));
  handle<[], unknown>('campus.importTimetable', () => campusCall(async () => { const r = await ctx.importTimetable(); opts.onChanged?.('goals'); return r; }));
  handle<[], unknown>('campus.importExams', () => campusCall(async () => { const r = await ctx.importExams(); await ctx.engine.tick(); opts.onChanged?.('feed'); return r; }));
  handle<[], unknown>('campus.library', () => campusCall(() => ctx.library()));
  handle<[], unknown>('campus.cardBalance', () => campusCall(() => ctx.cardBalance()));

  // 外部 MCP 服务
  handle<[], unknown>('external.presets', async () => EXTERNAL_PRESETS.map(({ preset, name, summary, repo, license, setup, needsDir, dirHint }) => ({ preset, name, summary, repo, license, setup, needsDir, dirHint })));
  handle<[], unknown>('external.status', async () => ctx.externalStatus());
  handle<[ExternalMcpConfig[]], unknown>('external.save', async (configs) => {
    const clean = sanitizeExternal(configs);
    repo.setSettings({ externalMcp: clean });
    return ctx.reloadExternal();
  });

  handle<[], unknown>('notices.sources', async () => {
    const enabled = new Set(enabledNoticeSources(repo).map((s) => s.id));
    const errors = repo.getKv<string[]>('notice_errors', []);
    return NOTICE_SOURCES.map((s) => ({ ...s, enabled: enabled.has(s.id), error: errors.find((e) => e.startsWith(`${s.name}：`))?.slice(s.name.length + 1) }));
  });
  handle<[string?], unknown>('notices.list', async (query) => repo.listNotices({ query, limit: 50 }));

  handle<[number?], unknown>('activities.list', async (days) => {
    const now = Date.now();
    return repo.listActivities({ from: new Date(now - 2 * 3_600_000).toISOString(), to: new Date(now + (days ?? 14) * 86_400_000).toISOString(), limit: 100 });
  });
  handle<[string], unknown>('activities.import', async (url) => {
    try {
      const r = await ctx.importArticle(url);
      opts.onChanged?.('feed');
      return { title: r.article.title, activities: r.activities, past: r.past };
    } catch (e) {
      // 去掉技术细节，留下给用户看的原因（都以「请」开头，渲染进程会原样显示）
      throw new Error(`请检查链接：${(e as Error).message}`);
    }
  });
  handle<[], unknown>('activities.syncFeeds', async () => {
    const r = await ctx.syncAll(new Date(), { force: true });
    await ctx.engine.tick();
    opts.onChanged?.('feed');
    return r.activities ?? { entries: 0, activities: 0, errors: r.errors.filter((e) => e.startsWith('活动订阅')) };
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
    if (result.errors.length) throw new Error(`请检查登录状态、邮箱配置和网络后重新同步。${result.errors.join('；')}`);
    await ctx.executor.runNext();
  });
  const wipe = () => {
    if (ctx.agent.state() || pendingUploads || activeActions.size) throw new Error('请等当前回复或文件导入结束后再清除数据。');
    repo.wipe();
    opts.onChatCleared?.();
  };
  handle('dev.wipe', async () => { wipe(); });
  handle('dev.demoSubmitNext', async () => {
    const next = repo.listItems({ kind: 'assignment', done: false, dueAfter: new Date().toISOString(), limit: 1, dueBefore: new Date(Date.now() + 30 * 86_400_000).toISOString() })[0];
    if (next) opts.demo.elearning.submit(next.sourceId);
    await ctx.syncAll();
    await ctx.engine.tick();
  });
  // 一键重置演示：清空数据 → 重新写入演示画像 → 首次同步 → 运行一次引擎 → 刷新界面（录视频前用）
  handle('dev.resetDemo', async () => {
    wipe();
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

