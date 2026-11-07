import { createCoursesServer } from '@fudaner/mcp-fudan-courses';
import { createElearningServer, type ElearningClient } from '@fudaner/mcp-fudan-elearning';
import { createMailServer, type MailClient } from '@fudaner/mcp-fudan-mail';
import { Db } from './db/db';
import { Repo } from './db/repo';
import { ModelRouter } from './ai/llm';
import { ChatAgent } from './ai/agent';
import { courseRegistryData } from './courses/registry';
import { buildCalendar, localDate } from './engine/calendar';
import { applyDemoCourseExtras } from './demo/demo';
import type { Channels } from './engine/channels';
import type { PlatformState } from '../shared/types';
import { ProactiveEngine } from './engine/engine';
import { TicketExecutor } from './engine/executor';
import { createLocalServer } from './local-tools/server';
import { McpHub } from './mcp/hub';
import { syncElearning } from './sources/elearning-sync';
import { syncMail } from './sources/mail-sync';
import { importArticle, syncFeeds, type FetchText } from './activities/sync';
import { demoFeeds, demoFetchText } from './demo/demo-activities';

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
}

export class AppContext {
  readonly repo: Repo;
  readonly router: ModelRouter;
  readonly hub = new McpHub();
  readonly executorHub = new McpHub();
  readonly engine: ProactiveEngine;
  readonly agent: ChatAgent;
  readonly executor: TicketExecutor;
  private syncing = false;

  constructor(private readonly deps: AppDeps) {
    this.repo = new Repo(new Db(deps.dbPath));
    this.repo.setCalendar(buildCalendar());
    this.router = new ModelRouter(() => this.repo.getSettings());
    this.engine = new ProactiveEngine(this.repo, this.router, deps.channels);
    this.agent = new ChatAgent(this.repo, this.router, this.hub, deps.channels, () => this.platformStatus(false));
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
    await this.hub.connect('fudaner-local', createLocalServer(repo, this.deps.channels, 'chat', { importArticle: (url) => this.importArticle(url) }));

    await this.executorHub.connect('fudan-elearning', createElearningServer(elearningData));
    await this.executorHub.connect('fudan-mail', createMailServer(mailData));
    await this.executorHub.connect('fudan-courses', createCoursesServer(courses));
    await this.executorHub.connect('fudaner-local', createLocalServer(repo, this.deps.channels, 'executor'));
  }

  async platformStatus(probe = true): Promise<PlatformState[]> {
    return this.deps.platformStatus ? this.deps.platformStatus(probe) : [];
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

  /** 同步所有已连接的平台，然后做闭环验证 */
  async syncAll(now = new Date()): Promise<{ elearning?: unknown; mail?: unknown; activities?: unknown; errors: string[] }> {
    if (this.syncing) return { errors: ['正在同步'] };
    this.syncing = true;
    const errors: string[] = [];
    const out: { elearning?: unknown; mail?: unknown; activities?: unknown; errors: string[] } = { errors };
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
    await this.hub.close();
    await this.executorHub.close();
    this.repo.db.close();
  }
}
