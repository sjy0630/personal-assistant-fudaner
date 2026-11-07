import { createCoursesServer } from '@fudaner/mcp-fudan-courses';
import { createElearningServer, type ElearningClient } from '@fudaner/mcp-fudan-elearning';
import { createMailServer, type MailClient } from '@fudaner/mcp-fudan-mail';
import { Db } from './db/db';
import { dirname, join } from 'node:path';
import { ResourceImages } from './library/resource-images';
import { Repo } from './db/repo';
import { ModelRouter } from './ai/llm';
import { ChatAgent } from './ai/agent';
import { courseRegistryData } from './courses/registry';
import { buildCalendar, localDate } from './engine/calendar';
import { applyDemoCourseExtras } from './demo/demo';
import type { Channels } from './engine/channels';
import type { ExternalMcpStatus, PlatformState } from '../shared/types';
import { childEnv, externalServerName, launchOf, toolAllowed } from './mcp/external';
import { isStale, nextOccurrence } from './engine/reminders';
import { ProactiveEngine } from './engine/engine';
import { TicketExecutor } from './engine/executor';
import { createLocalServer } from './local-tools/server';
import { McpHub } from './mcp/hub';
import { syncElearning } from './sources/elearning-sync';
import { syncMail } from './sources/mail-sync';
import { importArticle, syncFeeds, type FetchText } from './activities/sync';
import { demoFeeds, demoFetchText, demoNoticeSources } from './demo/demo-activities';
import { enabledNoticeSources, syncNotices } from './notices/sync';
import { importExams, importTimetable, type CampusReader } from './sources/timetable-sync';
import { readCardBalance, readLibrary, type LibraryStatus } from './sources/campus-life';
import { demoCardBalance, demoExams, demoLibrary, demoElectricity, demoTreehole, demoLiterature } from './demo/demo-campus';
import type { LibrarySearch, LiteratureQuery } from './sources/library-search';
import type { TreeholeApi, TreeholeClient } from './sources/treehole';
import { readElectricity, type DormElectricity } from './sources/dorm';

/**
 * 应用的组装根（参考 dsh-superagent 的 Runtime）：创建并连接所有部件，不包含业务规则。
 * 不依赖 Electron，测试中可以直接创建（传入内存数据库和演示客户端）。
 */
export interface AppDeps {
  dbPath: string;
  channels: Channels;
  elearning: () => ElearningClient | null;
  mail: () => MailClient | null;
  /** 各平台连接状态。probe=false 时只用已知状态、不发网络请求 */
  platformStatus?: (probe: boolean) => Promise<PlatformState[]>;
  /** 读取网页（活动文章、订阅源）。不提供时无法导入文章和同步订阅源 */
  fetchText?: FetchText;
  /** 用统一身份认证会话读教务系统、校园卡（只读） */
  campusReader?: () => CampusReader | null;
  /** 公开接口的 POST 请求（图书馆人数） */
  postPublic?: (url: string) => Promise<{ status: number; text: string }>;
  /** 图书馆文献检索（公开接口） */
  library?: LibrarySearch;
  /** 树洞与旦克（树洞账号令牌 + 直连 / WebVPN） */
  treehole?: () => TreeholeClient | null;
}

export class AppContext {
  readonly repo: Repo;
  readonly images: ResourceImages;
  readonly router: ModelRouter;
  readonly hub = new McpHub();
  readonly executorHub = new McpHub();
  readonly engine: ProactiveEngine;
  readonly agent: ChatAgent;
  readonly executor: TicketExecutor;
  private syncing = false;
  /** 外部 MCP 服务的连接状态（设置页展示） */
  private external = new Map<string, ExternalMcpStatus>();
  private externalVersion = 0;

  constructor(private readonly deps: AppDeps) {
    this.repo = new Repo(new Db(deps.dbPath));
    this.images = new ResourceImages(this.repo, join(dirname(deps.dbPath), 'attachment-images'));
    this.repo.setCalendar(buildCalendar());
    this.router = new ModelRouter(() => this.repo.getSettings());
    this.engine = new ProactiveEngine(this.repo, this.router, deps.channels);
    this.agent = new ChatAgent(this.repo, this.router, this.hub, deps.channels, () => this.platformStatus(false), (id) => this.images.read(id));
    this.executor = new TicketExecutor(this.repo, this.router, this.executorHub, deps.channels);
  }

  /** 启动 MCP 服务（进程内）。智能体用完整工具集，执行器用受限工具集。 */
  async start(): Promise<void> {
    const repo = this.repo;
    const elearningData = {
      listCourses: async () => repo.listCourses().map((c) => ({ code: c.code, name: c.name, teachers: c.teachers })),
      listAssignments: async (f: { courseCode?: string; dueBefore?: string; status?: string }) => {
        const course = f.courseCode ? repo.findCourse(f.courseCode) : undefined;
        return repo.listItems({ kind: 'assignment', courseId: course?.id, dueBefore: f.dueBefore, done: f.status === 'pending' ? false : f.status === 'submitted' ? true : undefined })
          .map((i) => ({ id: i.id, title: i.title, course: i.courseId ? repo.getCourse(i.courseId)?.name : undefined, dueAt: i.dueAt, submitted: i.done, url: i.url }));
      },
      getAssignment: async (id: string) => {
        const i = repo.getItem(id);
        return i ? { ...i, related: repo.linksOf(id).map((l) => ({ title: l.item.title, reason: l.reason })) } : null;
      },
      listAnnouncements: async (f: { courseCode?: string; since?: string }) => {
        const course = f.courseCode ? repo.findCourse(f.courseCode) : undefined;
        return repo.listItems({ kind: 'announcement', courseId: course?.id, since: f.since }).map((i) => ({ id: i.id, title: i.title, at: i.publishedAt, body: i.body.slice(0, 500) }));
      },
      refresh: () => this.syncAll().then(() => undefined),
    };
    const mailData = {
      search: async (f: { query?: string; since?: string; category?: string; limit?: number }) =>
        repo.listItems({ kind: 'email', query: f.query, since: f.since, category: f.category, limit: f.limit ?? 20 })
          .map((i) => ({ id: i.id, from: i.sender, subject: i.title, date: i.publishedAt, category: i.aiCategory, summary: i.aiSummary, action: i.aiAction })),
      get: async (id: string) => {
        const i = repo.getItem(id);
        return i && i.kind === 'email' ? { id: i.id, from: i.sender, subject: i.title, date: i.publishedAt, body: i.body.slice(0, 4000), summary: i.aiSummary } : null;
      },
      listActionRequired: async () => repo.listItems({ kind: 'email', done: false, limit: 50 })
        .filter((i) => i.aiCategory === 'reply' || i.aiCategory === 'action')
        .map((i) => ({ id: i.id, from: i.sender, subject: i.title, summary: i.aiSummary, action: i.aiAction })),
    };
    const courses = courseRegistryData(repo);

    await this.hub.connect('fudan-elearning', createElearningServer(elearningData));
    await this.hub.connect('fudan-mail', createMailServer(mailData));
    await this.hub.connect('fudan-courses', createCoursesServer(courses));
    await this.hub.connect('fudaner-local', createLocalServer(repo, this.deps.channels, 'chat', {
      importArticle: (url) => this.importArticle(url), library: () => this.library(), cardBalance: () => this.cardBalance(),
      literature: { search: (q) => this.searchLiterature(q), get: (id) => this.getLiterature(id) },
      treehole: () => this.treehole(), electricity: () => this.electricity(),
    }));

    await this.executorHub.connect('fudan-elearning', createElearningServer(elearningData));
    await this.executorHub.connect('fudan-mail', createMailServer(mailData));
    await this.executorHub.connect('fudan-courses', createCoursesServer(courses));
    await this.executorHub.connect('fudaner-local', createLocalServer(repo, this.deps.channels, 'executor'));
  }

  async platformStatus(probe = true): Promise<PlatformState[]> {
    return this.deps.platformStatus ? this.deps.platformStatus(probe) : [];
  }

  /**
   * 按设置连接外部 MCP 服务（社区做的复旦校园服务）。在后台进行，不阻塞启动：
   * 第一次启动 uvx 之类的服务要下载依赖，可能要一两分钟。
   */
  async reloadExternal(): Promise<ExternalMcpStatus[]> {
    const version = ++this.externalVersion;
    const configs = this.repo.getSettings().externalMcp ?? [];
    for (const name of this.hub.list().map((s) => s.server).filter((n) => n.startsWith('ext-'))) await this.hub.disconnect(name);
    this.external = new Map(configs.map((c) => [c.id, { id: c.id, name: c.name, state: c.enabled ? 'connecting' : 'off', tools: [], blocked: [] } satisfies ExternalMcpStatus]));
    this.deps.channels.changed('platforms');
    await Promise.all(configs.filter((c) => c.enabled).map(async (c) => {
      let status: ExternalMcpStatus;
      try {
        const launch = launchOf(c);
        const r = await this.hub.connectStdio(externalServerName(c), { ...launch, env: childEnv() }, (t) => toolAllowed(c, t));
        status = { id: c.id, name: c.name, state: 'ok', tools: r.tools, blocked: r.blocked };
      } catch (e) {
        status = { id: c.id, name: c.name, state: 'error', tools: [], blocked: [], error: (e as Error).message };
      }
      // 期间设置又变了：丢弃这次结果
      if (version !== this.externalVersion) { await this.hub.disconnect(externalServerName(c)); return; }
      this.external.set(c.id, status);
      this.deps.channels.changed('platforms');
    }));
    return this.externalStatus();
  }

  externalStatus(): ExternalMcpStatus[] {
    return [...this.external.values()];
  }

  private remindersRunning = false;

  /**
   * 到点的定时提醒和定时任务。由主进程每 10 秒调用一次。
   * - 用户自己设的，到点必达：不占注意力预算、不受静默时段限制；
   * - 电脑关机或睡眠错过超过 12 小时的跳过，只排下一次；
   * - 定时任务需要模型；对话正在生成时等下一轮再执行。
   */
  async runReminders(now = new Date()): Promise<number> {
    if (this.remindersRunning) return 0;
    this.remindersRunning = true;
    let ran = 0;
    try {
      const name = this.repo.getProfile().assistantName;
      for (const r of this.repo.dueReminders(now.toISOString())) {
        const next = nextOccurrence(r.repeat, now)?.toISOString();
        if (isStale(r, now)) { this.repo.advanceReminder(r.id, next); continue; }
        const useModel = r.kind === 'task' && !!this.router.for('chat');
        if (useModel && this.agent.busy()) continue;
        const late = r.nextAt && now.getTime() - Date.parse(r.nextAt) > 10 * 60_000 ? `（原定 ${new Date(r.nextAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}，电脑刚恢复）` : '';
        this.repo.advanceReminder(r.id, next, now.toISOString());
        ran++;
        if (useModel) {
          const msg = await this.agent.runScheduled(r.title, r.prompt || r.title);
          this.deps.channels.notify(name, `${r.title}：${msg.content.replace(/^⏰[^\n]*\n+/, '').slice(0, 80)}`, msg.id);
        } else {
          const text = r.kind === 'task'
            ? `⏰ 到时间了：${r.title}${late}。还没有接上大模型，没法自动去做，记得自己处理一下。`
            : `⏰ ${r.prompt || r.title}${late}`;
          const msg = this.repo.addMessage({ role: 'assistant', content: text, proactive: true, trigger: `reminder:${r.id}` });
          this.deps.channels.messagePosted(msg);
          this.deps.channels.notify(name, text.replace(/^⏰ /, ''), msg.id);
        }
      }
    } finally {
      this.remindersRunning = false;
    }
    return ran;
  }

  /** 读取网页：演示模式下只读虚构文章 */
  private fetchText(): FetchText | undefined {
    return this.repo.getSettings().demoMode ? demoFetchText : this.deps.fetchText;
  }

  /** 导入一篇文章里的活动（对话里用户发来链接时） */
  async importArticle(url: string) {
    const fetchText = this.fetchText();
    if (!fetchText) throw new Error('当前环境不能读取网页。');
    const result = await importArticle({ repo: this.repo, router: this.router, fetchText }, url);
    // 导入后马上研判，推荐的活动立刻出现在动态里
    await this.engine.tick().catch(() => undefined);
    return result;
  }

  private reader(): CampusReader {
    const reader = this.deps.campusReader?.();
    if (!reader) throw new Error('请先在「设置 → 复旦账号」登录复旦账号。');
    return reader;
  }

  /** 导入真实课表（演示模式下课表是内置的） */
  async importTimetable() {
    if (this.repo.getSettings().demoMode) {
      applyDemoCourseExtras(this.repo, new Date());
      return { kind: 'undergraduate' as const, semester: '演示学期', courses: this.repo.listCourses().length, entries: 0 };
    }
    const r = await importTimetable(this.repo, this.reader());
    this.clearCampusProblem('timetable');
    return r;
  }

  /** 手动导入成功后，清掉自动更新留下的失败记录 */
  private clearCampusProblem(key: string): void {
    const problems = this.repo.getKv<Record<string, string>>('campus_problems', {});
    if (key in problems) { delete problems[key]; this.repo.setKv('campus_problems', problems); }
  }

  /** 导入考试安排 */
  async importExams() {
    if (this.repo.getSettings().demoMode) return demoExams(this.repo, new Date());
    const r = await importExams(this.repo, this.reader());
    this.clearCampusProblem('exams');
    return r;
  }

  async library(): Promise<LibraryStatus[]> {
    if (this.repo.getSettings().demoMode) return demoLibrary();
    if (!this.deps.postPublic) throw new Error('当前环境不能访问网络。');
    return readLibrary(this.deps.postPublic);
  }

  /** 图书馆文献检索（演示模式下返回虚构文献） */
  async searchLiterature(q: LiteratureQuery) {
    if (this.repo.getSettings().demoMode) return demoLiterature(q.query);
    if (!this.deps.library) throw new Error('当前环境不能访问图书馆检索。');
    return this.deps.library.search(q);
  }

  getLiterature(recordId: string) {
    if (this.repo.getSettings().demoMode) return demoLiterature('').records.find((r) => r.recordId === recordId);
    return this.deps.library?.document(recordId);
  }

  /** 树洞与旦克：演示模式下用虚构内容；否则需要树洞账号 */
  treehole(): TreeholeApi {
    if (this.repo.getSettings().demoMode) return demoTreehole();
    const client = this.deps.treehole?.();
    if (!client) throw new Error('当前环境不能访问树洞。');
    return client;
  }

  /** 宿舍电量（10 分钟内重复查询用缓存） */
  async electricity(): Promise<DormElectricity & { at: string }> {
    const cached = this.repo.getKv<(DormElectricity & { at: string }) | null>('dorm_electricity', null);
    if (cached && Date.now() - Date.parse(cached.at) < 10 * 60_000) return cached;
    const value = { ...(this.repo.getSettings().demoMode ? demoElectricity() : await readElectricity(this.reader())), at: new Date().toISOString() };
    this.repo.setKv('dorm_electricity', value);
    return value;
  }

  /** 校园卡余额（10 分钟内重复查询用缓存） */
  async cardBalance(): Promise<{ balance: number; at: string }> {
    const cached = this.repo.getKv<{ balance: number; at: string } | null>('card_balance', null);
    if (cached && Date.now() - Date.parse(cached.at) < 10 * 60_000) return cached;
    const balance = this.repo.getSettings().demoMode ? demoCardBalance() : await readCardBalance(this.reader());
    const value = { balance, at: new Date().toISOString() };
    this.repo.setKv('card_balance', value);
    return value;
  }

  /**
   * 每天一次：更新课表、考试安排，查一次校园卡余额（低于 30 元提醒）。
   * 没登录或学校系统读不到时不打扰，只在设置页显示原因。
   */
  private async dailyCampus(now: Date, force: boolean): Promise<void> {
    const last = this.repo.getKv<string | null>('campus_last_sync', null);
    if (!force && last && now.getTime() - Date.parse(last) < 20 * 3_600_000) return;
    const demo = this.repo.getSettings().demoMode;
    if (!demo && !this.deps.campusReader?.()) return;
    this.repo.setKv('campus_last_sync', now.toISOString());
    const problems: Record<string, string> = {};
    const attempt = async (key: string, run: () => Promise<unknown>) => {
      try { await run(); } catch (e) { problems[key] = (e as Error).name === 'NeedLoginError' ? '需要重新登录复旦账号' : (e as Error).message; }
    };
    if (!demo) await attempt('timetable', () => this.importTimetable());
    await attempt('exams', () => this.importExams());
    await attempt('card', async () => {
      const { balance } = await this.cardBalance();
      if (balance < 30) {
        this.repo.addTrigger({ source: 'clock', kind: 'card_low', sourceRef: localDate(now), threadKey: 'campus-card', payload: { balance, title: `校园卡余额 ¥${balance.toFixed(2)}` } });
      }
    });
    await attempt('electricity', async () => {
      const e = await this.electricity();
      if (e.remainingKwh < 10) {
        this.repo.addTrigger({ source: 'clock', kind: 'power_low', sourceRef: localDate(now), threadKey: 'dorm-power', payload: { remaining: e.remainingKwh, room: e.room, title: `宿舍电量剩 ${e.remainingKwh} 度` } });
      }
    });
    this.repo.setKv('campus_problems', problems);
  }

  /** 同步所有已连接的平台，然后做闭环验证 */
  async syncAll(now = new Date(), opts: { force?: boolean } = {}): Promise<{ elearning?: unknown; mail?: unknown; activities?: unknown; notices?: unknown; errors: string[] }> {
    if (this.syncing) return { errors: ['正在同步'] };
    this.syncing = true;
    const errors: string[] = [];
    const out: { elearning?: unknown; mail?: unknown; activities?: unknown; notices?: unknown; errors: string[] } = { errors };
    try {
      try {
        const el = this.deps.elearning();
        if (el) out.elearning = await syncElearning(el, this.repo, now);
        if (this.repo.getSettings().demoMode) applyDemoCourseExtras(this.repo, now);
      } catch (error) {
        const e = error as Error;
        errors.push(`eLearning：${e.message}`);
        if (e.name === 'NeedLoginError') {
          this.repo.addTrigger({ source: 'elearning', kind: 'auth_expired', sourceRef: `${localDate(now)}:elearning`, threadKey: 'auth', payload: { platform: 'elearning' } });
        }
      }
      try {
        const fetchText = this.fetchText();
        const settings = this.repo.getSettings();
        const feeds = settings.demoMode ? demoFeeds : settings.feeds ?? [];
        if (fetchText && feeds.length) {
          const r = await syncFeeds({ repo: this.repo, router: this.router, fetchText }, feeds, now);
          out.activities = r;
          // 单篇文章读不到不算同步失败，只记录；整个订阅源读不到才报错
          errors.push(...r.errors.filter((e) => !e.includes('「')).map((e) => `活动订阅：${e}`));
        }
      } catch (error) {
        errors.push(`活动订阅：${(error as Error).message}`);
      }
      try {
        // 学校和院系官网通知：每 2 小时读一次（手动同步时总是读）
        const fetchText = this.fetchText();
        const demo = this.repo.getSettings().demoMode;
        const last = this.repo.getKv<string | null>('notice_last_sync', null);
        const due = opts.force || !last || now.getTime() - Date.parse(last) > 2 * 3_600_000;
        const sources = demo ? demoNoticeSources : enabledNoticeSources(this.repo);
        if (fetchText && due && sources.length) {
          const r = await syncNotices({ repo: this.repo, router: this.router, fetchText, pause: demo ? async () => {} : undefined }, sources, now);
          out.notices = r;
          this.repo.setKv('notice_last_sync', now.toISOString());
          this.repo.setKv('notice_errors', r.errors);
        }
      } catch (error) {
        errors.push(`学校通知：${(error as Error).message}`);
      }
      try {
        await this.dailyCampus(now, !!opts.force);
      } catch (error) {
        errors.push(`课表与校园卡：${(error as Error).message}`);
      }
      try {
        const mail = this.deps.mail();
        if (mail) out.mail = await syncMail(mail, this.repo, this.router, now);
      } catch (error) {
        errors.push(`邮箱：${(error as Error).message}`);
      }
      this.engine.verifyAfterSync();
      this.deps.channels.changed('goals');
      this.deps.channels.changed('feed');
    } finally {
      this.syncing = false;
    }
    return out;
  }

  async close(): Promise<void> {
    this.externalVersion++;
    await this.hub.close();
    await this.executorHub.close();
    this.repo.db.close();
  }
}
