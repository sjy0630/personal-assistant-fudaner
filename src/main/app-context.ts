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
import { ProactiveEngine } from './engine/engine';
import { TicketExecutor } from './engine/executor';
import { createLocalServer } from './local-tools/server';
import { McpHub } from './mcp/hub';
import { syncElearning } from './sources/elearning-sync';
import { syncMail } from './sources/mail-sync';

/**
 * 应用的组装根（参考 dsh-superagent 的 Runtime）：创建并连接所有部件，不包含业务规则。
 * 不依赖 Electron，测试中可以直接创建（传入内存数据库和演示客户端）。
 */
export interface AppDeps {
  dbPath: string;
  channels: Channels;
  elearning: () => ElearningClient | null;
  mail: () => MailClient | null;
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
    this.agent = new ChatAgent(this.repo, this.router, this.hub, deps.channels);
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
    await this.hub.connect('fudaner-local', createLocalServer(repo, this.deps.channels, 'chat'));

    await this.executorHub.connect('fudan-elearning', createElearningServer(elearningData));
    await this.executorHub.connect('fudan-mail', createMailServer(mailData));
    await this.executorHub.connect('fudan-courses', createCoursesServer(courses));
    await this.executorHub.connect('fudaner-local', createLocalServer(repo, this.deps.channels, 'executor'));
  }

  /** 同步所有已连接的平台，然后做闭环验证 */
  async syncAll(now = new Date()): Promise<{ elearning?: unknown; mail?: unknown; errors: string[] }> {
    if (this.syncing) return { errors: ['正在同步'] };
    this.syncing = true;
    const errors: string[] = [];
    const out: { elearning?: unknown; mail?: unknown; errors: string[] } = { errors };
    try {
      const el = this.deps.elearning();
      if (el) {
        out.elearning = await syncElearning(el, this.repo, now).catch((e: Error) => {
          errors.push(`eLearning：${e.message}`);
          // 登录过期：交给主动引擎提醒用户重新登录（每天每个平台最多一次）
          if (e.name === 'NeedLoginError') {
            this.repo.addTrigger({ source: 'elearning', kind: 'auth_expired', sourceRef: `${localDate(now)}:elearning`, threadKey: 'auth', payload: { platform: 'elearning' } });
          }
        });
        if (this.repo.getSettings().demoMode) applyDemoCourseExtras(this.repo, now);
      }
      const mail = this.deps.mail();
      if (mail) out.mail = await syncMail(mail, this.repo, this.router, now).catch((e) => { errors.push(`邮箱：${e.message}`); });
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
