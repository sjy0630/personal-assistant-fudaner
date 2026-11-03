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
  submitted: boolean;
  submittedAt?: string;
  updatedAt?: string;
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

  private async get<T>(path: string, params: Record<string, string | string[]> = {}): Promise<T> {
    const url = new URL(`/api/v1${path}`, this.base);
    for (const [k, v] of Object.entries(params)) {
      for (const one of Array.isArray(v) ? v : [v]) url.searchParams.append(k, one);
    }
    url.searchParams.set('per_page', '100');
    const res = await this.auth.fetch('elearning', url.toString(), { headers: { Accept: 'application/json' } });
    if (res.status === 401 || isUisLoginUrl(res.url)) throw new NeedLoginError('elearning');
    if (!res.ok) throw new Error(`eLearning API ${path} 返回 ${res.status}`);
    // TODO(B)：处理 Link 头分页（课程或作业超过 100 条时）
    return (await res.json()) as T;
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
      teachers?: { display_name: string }[];
    };
    const raw = await this.get<Raw[]>('/courses', {
      enrollment_state: 'active',
      'include[]': ['term', 'teachers'],
    });
    // TODO(B)：助教邮箱需要 /courses/:id/users?enrollment_type[]=ta 获取，待实测权限
    return raw.map((c) => ({
      id: String(c.id),
      name: c.name,
      courseCode: c.course_code,
      term: c.term?.name,
      teachers: (c.teachers ?? []).map((t) => ({ name: t.display_name, role: 'teacher' as const })),
    }));
  }

  async listAssignments(courseId: string): Promise<CanvasAssignment[]> {
    type Raw = {
      id: number; course_id: number; name: string; description?: string; due_at?: string;
      html_url: string; submission_types: string[]; updated_at?: string;
      submission?: { workflow_state: string; submitted_at?: string };
    };
    const raw = await this.get<Raw[]>(`/courses/${courseId}/assignments`, { 'include[]': ['submission'] });
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
