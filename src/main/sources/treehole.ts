import { isWebvpnLogin, toWebvpnUrl } from './webvpn';

/**
 * 复旦树洞（旦挞）与旦克课程评价，只读。
 *
 * - 接口地址：forum / auth / danke.fduhole.com（与 DanXi 客户端相同的公开服务）。
 * - 网络：先试直连（校园网内可以直接访问）；连不上时改走 WebVPN，WebVPN 登录复用复旦统一身份认证。
 * - 账号：树洞账号（邮箱 + 密码）只在登录时用一次，换成令牌后加密保存在本机；不保存密码。
 *   令牌过期时用刷新令牌自动续期，刷新也失败时请用户重新登录。
 * - 只调用查询接口，不发帖、不回复、不点赞。
 */
export const FORUM = 'https://forum.fduhole.com/api';
export const AUTH = 'https://auth.fduhole.com/api';
export const DANKE = 'https://danke.fduhole.com/api';

export interface HoleTokens { access: string; refresh: string }
export interface RawResponse { status: number; url: string; contentType: string; text: string }
export type RawFetch = (url: string, init: { method?: string; headers?: Record<string, string>; body?: string; timeoutMs?: number }) => Promise<RawResponse>;

export class TreeholeLoginError extends Error {
  constructor(message = '需要登录树洞账号：到「设置 → 复旦账号 → 树洞与旦克」登录一次。') { super(message); this.name = 'TreeholeLoginError'; }
}
export class TreeholeError extends Error {
  constructor(message: string) { super(message); this.name = 'TreeholeError'; }
}

export interface TreeholeDeps {
  fetch: RawFetch;
  /** 建立 WebVPN 会话（复旦账号登录过期时抛出 NeedLoginError） */
  ensureWebvpn: () => Promise<void>;
  tokens: { get(): HoleTokens | null; set(t: HoleTokens | null): void };
  now?: () => number;
}

const clean = (s: unknown, max = 600) => (typeof s === 'string' ? s : '')
  .replace(/!\[[^\]]*\]\([^)]*\)/g, '[图片]').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);

/** 对话工具用到的接口（真实客户端和演示实现都满足） */
export interface TreeholeApi {
  searchFloors(keyword: string, opts?: { limit?: number; accurate?: boolean; withinDays?: number }): Promise<unknown[]>;
  hole(holeId: number, opts?: { start?: number; length?: number }): Promise<unknown>;
  latest(opts?: { divisionId?: number; length?: number; tag?: string }): Promise<unknown[]>;
  searchCourses(keyword: string, limit?: number): Promise<unknown[]>;
  courseReviews(groupId: number, maxReviews?: number): Promise<unknown>;
}

export class TreeholeClient implements TreeholeApi {
  private route?: { via: 'direct' | 'webvpn'; until: number };
  constructor(private readonly deps: TreeholeDeps) {}
  private now() { return this.deps.now?.() ?? Date.now(); }

  /** 校园网内直连，否则走 WebVPN（结果缓存 10 分钟） */
  private async via(): Promise<'direct' | 'webvpn'> {
    if (this.route && this.now() < this.route.until) return this.route.via;
    let via: 'direct' | 'webvpn' = 'webvpn';
    try {
      const res = await this.deps.fetch(`${FORUM}/divisions`, { timeoutMs: 3000 });
      if (res.status > 0 && /json/.test(res.contentType)) via = 'direct';
    } catch { /* 连不上：校外 */ }
    this.route = { via, until: this.now() + 10 * 60_000 };
    return via;
  }

  /** 发请求；WebVPN 会话失效时重新建立一次 */
  private async send(url: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<RawResponse> {
    const via = await this.via();
    if (via === 'direct') {
      const direct = await this.deps.fetch(url, init).catch(() => undefined);
      // 直连拿到的是网页（例如「请使用校园网访问」）或连不上：改走 WebVPN
      if (direct && (/json/.test(direct.contentType) || !/<html/i.test(direct.text))) return direct;
      this.route = { via: 'webvpn', until: this.now() + 10 * 60_000 };
    }
    const target = toWebvpnUrl(url);
    let res = await this.deps.fetch(target, init);
    if (vpnLoginPage(res)) {
      await this.deps.ensureWebvpn();
      res = await this.deps.fetch(target, init);
      if (vpnLoginPage(res)) throw new TreeholeError('WebVPN 登录没有成功：请先在「设置 → 复旦账号」重新登录复旦账号，再登录树洞。');
    }
    return res;
  }

  private parse<T>(res: RawResponse): T {
    if (!/json/.test(res.contentType)) {
      // 带上是哪个页面，方便排查（例如学校的提示页、WebVPN 的中间页）
      console.warn('[Fudaner 树洞] 返回的不是数据', res.status, res.url, pageTitle(res.text));
      throw new TreeholeError(`树洞服务返回的不是数据（${res.status}，${hostOf(res.url)}${pageTitle(res.text) ? `「${pageTitle(res.text)}」` : ''}），请稍后再试。`);
    }
    try { return JSON.parse(res.text) as T; } catch { throw new TreeholeError('树洞服务返回的格式和预期不同。'); }
  }

  /** 用树洞账号登录，换取令牌（密码不保存） */
  async login(email: string, password: string): Promise<void> {
    const res = await this.send(`${AUTH}/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) });
    const data = this.parse<{ access?: string; refresh?: string; message?: string }>(res);
    if (!data.access || !data.refresh) throw new TreeholeError(data.message ? `树洞登录失败：${data.message}` : '树洞登录失败，请检查邮箱和密码。');
    this.deps.tokens.set({ access: data.access, refresh: data.refresh });
  }

  logout(): void { this.deps.tokens.set(null); }
  loggedIn(): boolean { return !!this.deps.tokens.get(); }

  private async refresh(): Promise<boolean> {
    const t = this.deps.tokens.get();
    if (!t) return false;
    const res = await this.send(`${AUTH}/refresh`, { method: 'POST', headers: { Authorization: `Bearer ${t.refresh}` } });
    if (res.status >= 400) return false;
    const data = this.parse<{ access?: string; refresh?: string }>(res);
    if (!data.access) return false;
    this.deps.tokens.set({ access: data.access, refresh: data.refresh ?? t.refresh });
    return true;
  }

  /** 带令牌的 GET；令牌过期时刷新一次 */
  private async get<T>(url: string, params: Record<string, string | number | boolean | undefined> = {}): Promise<T> {
    const q = Object.entries(params).filter(([, v]) => v !== undefined && v !== '').map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`).join('&');
    const full = q ? `${url}?${q}` : url;
    for (let attempt = 0; attempt < 2; attempt++) {
      const t = this.deps.tokens.get();
      if (!t) throw new TreeholeLoginError();
      const res = await this.send(full, { headers: { Authorization: `Bearer ${t.access}`, Accept: 'application/json' } });
      if (res.status === 401) {
        if (attempt === 0 && await this.refresh()) continue;
        this.deps.tokens.set(null);
        throw new TreeholeLoginError('树洞登录已过期，请到「设置 → 复旦账号 → 树洞与旦克」重新登录。');
      }
      if (res.status === 404) throw new TreeholeError('没有找到（可能已被删除或隐藏）。');
      if (res.status >= 400) {
        const msg = (() => { try { return (JSON.parse(res.text) as { message?: string }).message; } catch { return undefined; } })();
        throw new TreeholeError(`树洞服务返回 ${res.status}${msg ? `：${msg}` : ''}`);
      }
      return this.parse<T>(res);
    }
    throw new TreeholeLoginError();
  }

  // ---------- 树洞 ----------
  async searchFloors(keyword: string, opts: { limit?: number; accurate?: boolean; withinDays?: number } = {}) {
    const now = Math.floor(this.now() / 1000);
    const floors = await this.get<RawFloor[]>(`${FORUM}/floors/search`, {
      search: keyword, offset: 0, size: Math.min(30, opts.limit ?? 15), accurate: opts.accurate ? 'true' : undefined,
      start_time: opts.withinDays ? now - opts.withinDays * 86400 : undefined, end_time: opts.withinDays ? now : undefined,
    });
    return (Array.isArray(floors) ? floors : []).map((f) => floorView(f, 300));
  }

  async hole(holeId: number, opts: { start?: number; length?: number } = {}) {
    const hole = await this.get<RawHole>(`${FORUM}/holes/${holeId}`);
    const floors = await this.get<RawFloor[]>(`${FORUM}/floors`, { hole_id: holeId, start_floor: opts.start ?? 0, length: Math.min(50, opts.length ?? 30) });
    return { ...holeView(hole), floors: (Array.isArray(floors) ? floors : []).map((f) => floorView(f, 600)) };
  }

  async latest(opts: { divisionId?: number; length?: number; tag?: string } = {}) {
    const holes = await this.get<RawHole[]>(`${FORUM}/holes`, { division_id: opts.divisionId ?? 1, length: Math.min(20, opts.length ?? 10), tag: opts.tag });
    return (Array.isArray(holes) ? holes : []).map(holeView);
  }

  async divisions() {
    const d = await this.get<{ division_id: number; name: string; description?: string }[]>(`${FORUM}/divisions`);
    return (Array.isArray(d) ? d : []).map((x) => ({ division_id: x.division_id, name: x.name, description: clean(x.description, 80) }));
  }

  // ---------- 旦克课程评价 ----------
  async searchCourses(keyword: string, limit = 10) {
    const r = await this.get<{ items?: RawCourseGroup[] } | RawCourseGroup[]>(`${DANKE}/v3/course_groups/search`, { query: keyword, page: 1, page_size: Math.min(20, limit) });
    const items = Array.isArray(r) ? r : r.items ?? [];
    return items.map((g) => ({ course_group_id: g.id, name: g.name, code: g.code, department: g.department, credits: g.credits, campus: g.campus_name, review_count: g.review_count, course_count: g.course_count }));
  }

  async courseReviews(groupId: number, maxReviews = 12) {
    const g = await this.get<RawCourseGroup & { course_list?: RawCourse[] }>(`${DANKE}/v3/course_groups/${groupId}`);
    const reviews = (g.course_list ?? []).flatMap((c) => (c.review_list ?? []).map((rv) => ({
      teachers: c.teachers, term: c.year ? `${c.year} 学年第 ${c.semester ?? '?'} 学期` : undefined,
      title: clean(rv.title, 80), content: clean(rv.content, 800), time: rv.time_created?.slice(0, 10),
      rating: rv.rank ? { overall: rv.rank.overall, content: rv.rank.content, workload: rv.rank.workload, assessment: rv.rank.assessment } : undefined,
      votes: rv.vote, remark: rv.remark,
    })));
    reviews.sort((a, b) => (b.remark ?? 0) - (a.remark ?? 0) || (b.votes ?? 0) - (a.votes ?? 0));
    return {
      name: g.name, code: g.code, department: g.department, credits: g.credits, review_count: g.review_count,
      teachers: [...new Set((g.course_list ?? []).map((c) => c.teachers).filter(Boolean))],
      reviews: reviews.slice(0, Math.min(30, maxReviews)),
    };
  }
}

interface RawFloor { floor_id?: number; hole_id?: number; ranking?: number; anonyname?: string; content?: string; time_created?: string; like?: number; reply_to?: number; special_tag?: string }
interface RawHole { hole_id?: number; division_id?: number; tags?: { name?: string }[]; reply?: number; view?: number; time_created?: string; floors?: { first_floor?: RawFloor; prefetch?: RawFloor[] } }
interface RawCourseGroup { id?: number; name?: string; code?: string; department?: string; credits?: number[] | number; campus_name?: string; review_count?: number; course_count?: number }
interface RawCourse { teachers?: string; year?: number; semester?: number; review_list?: { title?: string; content?: string; time_created?: string; rank?: Record<string, number>; vote?: number; remark?: number }[] }

/** WebVPN 的登录页：被重定向到 /login，或者直接返回了它的登录页面 */
function vpnLoginPage(r: RawResponse): boolean {
  if (isWebvpnLogin(r.url)) return true;
  if (/json/.test(r.contentType)) return false;
  return /<html/i.test(r.text) && (/cas_login|webvpn/i.test(r.text) || /资源访问|统一身份认证/.test(pageTitle(r.text)));
}
function pageTitle(html: string): string {
  return (html.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1] ?? '').trim().slice(0, 40);
}
function hostOf(url: string): string {
  try { return new URL(url).hostname; } catch { return '未知地址'; }
}

function floorView(f: RawFloor, max: number) {
  return { hole_id: f.hole_id, floor_id: f.floor_id, floor: f.ranking, who: f.anonyname, time: f.time_created?.slice(0, 16).replace('T', ' '), likes: f.like, reply_to: f.reply_to || undefined, content: clean(f.content, max) };
}
function holeView(h: RawHole) {
  const first = h.floors?.first_floor ?? h.floors?.prefetch?.[0];
  return { hole_id: h.hole_id, division_id: h.division_id, tags: (h.tags ?? []).map((t) => t.name).filter(Boolean), replies: h.reply, views: h.view, time: h.time_created?.slice(0, 16).replace('T', ' '), first_floor: clean(first?.content, 300) };
}
