import { NeedLoginError, PLATFORM_URLS, isPermissionDenied, isUisLoginUrl, type FudanAuth } from '@fudaner/fudan-auth';

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

/** 课程文件（课件、讲义等） */
export interface CanvasFile {
  id: string;
  name: string;
  size?: number;
  contentType?: string;
  updatedAt?: string;
  /** 所在文件夹或单元，例如「课件」「第 5 讲」 */
  folder?: string;
}

/** 下载到内存的文件内容 */
export interface DownloadedFile { name: string; contentType?: string; data: Uint8Array }

/** 单个文件最大 200 MB，再大的请用户在网页上下载 */
export const MAX_DOWNLOAD_BYTES = 200 * 1024 * 1024;

/** 连接器的平台客户端接口。真实实现和演示实现都满足它。 */
export interface ElearningClient {
  listCourses(): Promise<CanvasCourse[]>;
  listAssignments(courseId: string): Promise<CanvasAssignment[]>;
  listAnnouncements(courseIds: string[], since?: string): Promise<CanvasAnnouncement[]>;
  /** 轻量检查会话是否有效 */
  ping(): Promise<boolean>;
  /** 课程文件列表（只读） */
  listFiles?(courseId: string, search?: string): Promise<CanvasFile[]>;
  /** 下载一个课程文件（只读） */
  downloadFile?(fileId: string): Promise<DownloadedFile>;
}

/** 通过 UIS 共享会话访问 Canvas REST API 的真实实现（只读）。 */
export class CanvasClient implements ElearningClient {
  private readonly base = PLATFORM_URLS.elearning.base;

  constructor(private readonly auth: FudanAuth) {}

  private async request(url: string): Promise<Response> {
    for (let attempt = 0; ; attempt++) {
      const res = await this.auth.fetch('elearning', url, { headers: { Accept: 'application/json' } });
      if (isUisLoginUrl(res.url)) throw new NeedLoginError('elearning');
      if (res.status === 401) {
        // 已登录但没有权限（例如课程花名册不对学生开放）按 403 处理，由调用方决定跳过，不当成登录过期。
        if (await isPermissionDenied(res)) throw Object.assign(new Error('没有权限查看这部分 eLearning 内容'), { status: 403 });
        throw new NeedLoginError('elearning');
      }
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

  /** 返回单个对象的接口（例如某个文件的信息） */
  private async getObject<T>(path: string): Promise<T> {
    const res = await this.request(new URL(`/api/v1${path}`, this.base).href);
    if (!res.headers.get('content-type')?.includes('json')) throw new Error('eLearning 未返回接口数据，请重新登录后同步');
    const data: unknown = await res.json();
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('eLearning 返回的数据格式不正确');
    return data as T;
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

  /**
   * 课程文件。先读「文件」栏目；老师把「文件」栏目隐藏时（没有权限），改从「单元」里找文件条目。
   */
  async listFiles(courseId: string, search?: string): Promise<CanvasFile[]> {
    type RawFile = { id: number; display_name?: string; filename?: string; size?: number; 'content-type'?: string; updated_at?: string; folder_id?: number; locked_for_user?: boolean; hidden_for_user?: boolean };
    const toFile = (f: RawFile, folder?: string): CanvasFile => ({
      id: String(f.id), name: f.display_name ?? f.filename ?? `文件 ${f.id}`, size: f.size, contentType: f['content-type'], updatedAt: f.updated_at, folder,
    });
    const term = search?.trim();
    try {
      const params: Record<string, string> = { sort: 'updated_at', order: 'desc' };
      if (term && term.length >= 2) params.search_term = term;
      const [files, folders] = await Promise.all([
        this.get<RawFile[]>(`/courses/${courseId}/files`, params),
        this.get<{ id: number; full_name?: string; name?: string }[]>(`/courses/${courseId}/folders`).catch(() => []),
      ]);
      const folderName = new Map(folders.map((f) => [f.id, (f.full_name ?? f.name ?? '').replace(/^course files\/?/, '')]));
      return files.filter((f) => !f.locked_for_user && !f.hidden_for_user).map((f) => toFile(f, folderName.get(f.folder_id ?? -1) || undefined));
    } catch (error) {
      if (![403, 404].includes((error as { status?: number }).status ?? 0)) throw error;
    }
    type Module = { name?: string; items?: { type: string; content_id?: number; title?: string }[] };
    const modules = await this.get<Module[]>(`/courses/${courseId}/modules`, { 'include[]': ['items'] });
    const out: CanvasFile[] = [];
    for (const m of modules) {
      for (const item of m.items ?? []) {
        if (item.type !== 'File' || item.content_id == null) continue;
        if (term && !(item.title ?? '').toLowerCase().includes(term.toLowerCase()) && !(m.name ?? '').toLowerCase().includes(term.toLowerCase())) continue;
        try {
          const f = await this.getObject<RawFile>(`/courses/${courseId}/files/${item.content_id}`);
          if (!f.locked_for_user) out.push(toFile(f, m.name));
        } catch (error) {
          if (![403, 404].includes((error as { status?: number }).status ?? 0)) throw error;
        }
      }
    }
    return out;
  }

  /** 下载课程文件：先读文件信息拿到带校验的下载地址，再用同一登录会话下载 */
  async downloadFile(fileId: string): Promise<DownloadedFile> {
    if (!/^\d+$/.test(fileId)) throw new Error('文件 id 不对，请用课件列表里返回的 id。');
    const info = await this.getObject<{ display_name?: string; filename?: string; size?: number; 'content-type'?: string; url?: string; locked_for_user?: boolean }>(`/files/${fileId}`);
    if (info.locked_for_user) throw new Error('这个文件还没开放，暂时不能下载。');
    if ((info.size ?? 0) > MAX_DOWNLOAD_BYTES) throw new Error('文件超过 200 MB，请在 eLearning 网页上下载。');
    if (!info.url) throw new Error('eLearning 没有返回这个文件的下载地址，可能需要在网页上下载。');
    const res = await this.auth.fetch('elearning', info.url);
    if (!res.ok) throw Object.assign(new Error(`下载失败（${res.status}）`), { status: res.status });
    const data = new Uint8Array(await res.arrayBuffer());
    if (data.byteLength > MAX_DOWNLOAD_BYTES) throw new Error('文件超过 200 MB，请在 eLearning 网页上下载。');
    return { name: info.display_name ?? info.filename ?? `文件 ${fileId}`, contentType: info['content-type'] ?? res.headers.get('content-type') ?? undefined, data };
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
