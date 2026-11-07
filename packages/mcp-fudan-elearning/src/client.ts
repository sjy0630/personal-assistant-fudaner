import { NeedLoginError, PLATFORM_URLS, isUisLoginUrl, type FudanAuth } from '@fudaner/fudan-auth';

/** eLearning（Canvas）平台数据类型：只保留 Fudaner 用得到的字段。 */
export interface CanvasCourse {
  id: string;
  name: string;
  /** Canvas 的 course_code，期望形如 COMP130004.01（格式待实测） */
  courseCode: string;
  term?: string;
  teachers: { name: string; email?: string; role: 'teacher' | 'ta' }[];
}

export interface CanvasAssignment {
  id: string;
  courseId: string;
  name: string;
  description?: string;
  dueAt?: string;
  htmlUrl: string;
  /** 'online' 表示网上提交；'on_paper' / 'none' 表示线下或无需提交 */
  submissionTypes: string[];
  /** 本人有提交记录（已提交 / 已评分 / 待审阅） */
  submitted: boolean;
  submittedAt?: string;
  updatedAt?: string;
  /**
   * 在 eLearning 上被标记为完成但不一定有本人提交记录，例如：
   * - 学生在「待办 / 计划」里勾选了「标记为完成」（组作业由组长提交、线下提交等）；
   * - 单元（模块）里要求「标记为完成」的作业，已点过完成；
   * - 教师设置了免交（excused）。
   */
  markedDone?: boolean;
}

/** 作业在平台上是否算完成：有提交记录，或已标记完成 / 免交 */
export function isAssignmentDone(a: Pick<CanvasAssignment, 'submitted' | 'markedDone'>): boolean {
  return a.submitted || !!a.markedDone;
}

export interface CanvasAnnouncement {
  id: string;
  courseId: string;
  title: string;
  message: string;
  postedAt: string;
  htmlUrl: string;
}

/** 连接器的平台客户端接口。真实实现和演示实现都满足它。 */
export interface ElearningClient {
  listCourses(): Promise<CanvasCourse[]>;
  listAssignments(courseId: string): Promise<CanvasAssignment[]>;
  listAnnouncements(courseIds: string[], since?: string): Promise<CanvasAnnouncement[]>;
  /** 轻量检查会话是否有效 */
  ping(): Promise<boolean>;
}

/** 通过 UIS 共享会话访问 Canvas REST API 的真实实现（只读）。 */
export class CanvasClient implements ElearningClient {
  private readonly base = PLATFORM_URLS.elearning.base;

  constructor(private readonly auth: FudanAuth) {}

  private async request(url: string): Promise<Response> {
    for (let attempt = 0; ; attempt++) {
      const res = await this.auth.fetch('elearning', url, { headers: { Accept: 'application/json' } });
      if (res.status === 401 || isUisLoginUrl(res.url)) throw new NeedLoginError('elearning');
      if ((res.status === 429 || res.status >= 500) && attempt < 2) {
        const retry = res.headers.get('retry-after');
        const seconds = retry ? Number(retry) : NaN;
        const wait = Number.isFinite(seconds) ? seconds * 1000 : retry ? Date.parse(retry) - Date.now() : 500 * 2 ** attempt;
        // 不提前重试服务器要求长时间等待的请求。
        if (wait > 5000) throw new Error('eLearning 请求受限，请稍后再同步');
        await res.body?.cancel();
        await new Promise((resolve) => setTimeout(resolve, Math.max(0, Number.isFinite(wait) ? wait : 500)));
        continue;
      }
      if (!res.ok) throw Object.assign(new Error(`eLearning API 返回 ${res.status}`), { status: res.status });
      return res;
    }
  }

  private async get<T>(path: string, params: Record<string, string | string[]> = {}): Promise<T> {
    const first = new URL(`/api/v1${path}`, this.base);
    for (const [k, v] of Object.entries(params)) {
      for (const one of Array.isArray(v) ? v : [v]) first.searchParams.append(k, one);
    }
    first.searchParams.set('per_page', '100');
    let url: URL | undefined = first;
    const seen = new Set<string>();
    const rows: unknown[] = [];
    while (url) {
      if (url.origin !== first.origin || url.pathname !== first.pathname || url.username || url.password || seen.has(url.href)) {
        throw new Error('eLearning 返回了异常分页链接，请稍后重试');
      }
      seen.add(url.href);
      const res = await this.request(url.href);
      if (!res.headers.get('content-type')?.includes('json')) {
        throw new Error('eLearning 未返回接口数据，请重新登录后同步');
      }
      const data: unknown = await res.json();
      if (path === '/users/self') {
        if (!data || typeof data !== 'object' || !('id' in data) || !data.id) throw new Error('无法确认 eLearning 登录身份');
        return data as T;
      }
      if (!Array.isArray(data)) throw new Error('eLearning 返回的数据格式不正确');
      rows.push(...data);
      const next: string | undefined = res.headers.get('link')?.split(/,(?=\s*<)/)
        .find((part) => /;\s*rel="?next"?(?:\s*;|\s*$)/i.test(part))?.match(/<([^>]+)>/)?.[1];
      url = next ? new URL(next, url) : undefined;
    }
    return rows as T;
  }

  async ping(): Promise<boolean> {
    try {
      await this.get('/users/self');
      return true;
    } catch (e) {
      if (e instanceof NeedLoginError) return false;
      throw e;
    }
  }

  async listCourses(): Promise<CanvasCourse[]> {
    type Raw = {
      id: number; name: string; course_code: string; term?: { name: string };
      teachers?: { display_name: string; email?: string }[];
    };
    const raw = await this.get<Raw[]>('/courses', {
      enrollment_state: 'active',
      'include[]': ['term', 'teachers'],
    });
    const courses: CanvasCourse[] = [];
    for (const c of raw) {
      const teachers: CanvasCourse['teachers'] = (c.teachers ?? []).map((t) => ({ name: t.display_name, email: t.email, role: 'teacher' }));
      // 部分课程不允许学生查看名册；权限不足不妨碍同步课程和作业。
      for (const role of ['teacher', 'ta'] as const) {
        try {
          const staff = await this.get<{ name: string; email?: string }[]>(`/courses/${c.id}/users`, { 'enrollment_type[]': [role] });
          for (const person of staff) {
            const existing = teachers.find((t) => t.role === role && t.name === person.name);
            if (existing) existing.email = person.email ?? existing.email;
            else teachers.push({ name: person.name, email: person.email, role });
          }
        } catch (error) {
          if (![403, 404].includes((error as { status?: number }).status ?? 0)) throw error;
        }
      }
      courses.push({ id: String(c.id), name: c.name, courseCode: c.course_code, term: c.term?.name, teachers });
    }
    return courses;
  }

  /** 「待办 / 计划」里被勾选为完成的作业 ID（一次同步内缓存 1 分钟，避免每门课重复请求） */
  private plannerMarks?: { at: number; ids: Promise<Set<string>> };

  private markedInPlanner(): Promise<Set<string>> {
    if (!this.plannerMarks || Date.now() - this.plannerMarks.at > 60_000) {
      type Override = { plannable_type: string; plannable_id: number | string; marked_complete?: boolean };
      const ids = this.get<Override[]>('/planner/overrides')
        .then((rows) => new Set(rows.filter((o) => o.plannable_type === 'assignment' && o.marked_complete).map((o) => String(o.plannable_id))))
        // 计划功能未开放或无权限时，不影响作业同步
        .catch((error) => {
          if ([403, 404].includes((error as { status?: number }).status ?? 0)) return new Set<string>();
          throw error;
        });
      this.plannerMarks = { at: Date.now(), ids };
    }
    return this.plannerMarks.ids;
  }

  /** 单元（模块）里要求「标记为完成」且已完成的作业 ID */
  private async markedInModules(courseId: string): Promise<Set<string>> {
    type Module = { items?: { type: string; content_id?: number | string; completion_requirement?: { type: string; completed?: boolean } }[] };
    try {
      const modules = await this.get<Module[]>(`/courses/${courseId}/modules`, { 'include[]': ['items'] });
      return new Set(modules.flatMap((m) => m.items ?? [])
        .filter((i) => i.type === 'Assignment' && i.content_id != null && i.completion_requirement?.type === 'must_mark_done' && i.completion_requirement.completed)
        .map((i) => String(i.content_id)));
    } catch (error) {
      if ([403, 404].includes((error as { status?: number }).status ?? 0)) return new Set<string>();
      throw error;
    }
  }

  async listAssignments(courseId: string): Promise<CanvasAssignment[]> {
    type Raw = {
      id: number; course_id: number; name: string; description?: string; due_at?: string;
      html_url: string; submission_types: string[]; updated_at?: string;
      submission?: { workflow_state: string; submitted_at?: string; excused?: boolean };
    };
    const raw = await this.get<Raw[]>(`/courses/${courseId}/assignments`, { 'include[]': ['submission'] });
    const [planner, modules] = await Promise.all([this.markedInPlanner(), this.markedInModules(courseId)]);
    return raw.map((a) => ({
      id: String(a.id),
      courseId: String(a.course_id),
      name: a.name,
      description: a.description,
      dueAt: a.due_at ?? undefined,
      htmlUrl: a.html_url,
      submissionTypes: a.submission_types,
      submitted: !!a.submission && ['submitted', 'graded', 'pending_review'].includes(a.submission.workflow_state),
      submittedAt: a.submission?.submitted_at,
      updatedAt: a.updated_at,
      markedDone: planner.has(String(a.id)) || modules.has(String(a.id)) || a.submission?.excused === true,
    }));
  }

  async listAnnouncements(courseIds: string[], since?: string): Promise<CanvasAnnouncement[]> {
    if (courseIds.length === 0) return [];
    type Raw = { id: number; context_code: string; title: string; message: string; posted_at: string; html_url: string };
    const params: Record<string, string | string[]> = { 'context_codes[]': courseIds.map((id) => `course_${id}`) };
    if (since) params.start_date = since;
    const raw = await this.get<Raw[]>('/announcements', params);
    return raw.map((a) => ({
      id: String(a.id),
      courseId: a.context_code.replace('course_', ''),
      title: a.title,
      message: a.message,
      postedAt: a.posted_at,
      htmlUrl: a.html_url,
    }));
  }
}
