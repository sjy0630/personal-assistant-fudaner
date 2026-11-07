/**
 * 复旦图书馆文献检索（资源发现系统 Primo 的匿名接口，不需要登录）。
 *
 * 接口用法参考 LvDAO/fudan-library-mcp（MIT 协议，https://github.com/LvDAO/fudan-library-mcp），
 * 这里用 TypeScript 重写为 Fudaner 内置功能，用户不需要另外安装任何东西。
 * 只返回题录、摘要和原文入口，不下载、不阅读出版社全文。
 */
export const PRIMO_ORIGIN = 'https://fudan-primo.hosted.exlibrisgroup.com.cn';
const REST = '/primo_library/libweb/webservices/rest';

const SCOPES = { articles: ['digital_tab', 'article_scope'], all: ['default_tab', 'default_scope'], books: ['book_journal', 'book_journal'] } as const;
const FIELDS = { all: 'any', title: 'title', author: 'creator', subject: 'sub', fulltext: 'ftext' } as const;

export type LibraryScope = keyof typeof SCOPES;
export type LibraryField = keyof typeof FIELDS;

export interface LiteratureQuery {
  query: string;
  scope?: LibraryScope;
  field?: LibraryField;
  limit?: number;
  offset?: number;
  yearFrom?: number;
  yearTo?: number;
  sort?: 'relevance' | 'newest';
  peerReviewedOnly?: boolean;
  fullTextOnly?: boolean;
}

export interface LiteratureRecord {
  recordId: string;
  context: 'PC' | 'L';
  title: string;
  authors: string[];
  year?: number;
  journal?: string;
  type?: string;
  doi?: string;
  abstract?: string;
  peerReviewed?: boolean;
  fullTextAvailable?: boolean;
  /** 图书馆里的详情页（可以从这里找全文入口、馆藏位置） */
  url: string;
}

export type GetJson = (url: string, headers: Record<string, string>) => Promise<{ status: number; text: string }>;

export class LibraryError extends Error {
  constructor(message: string) { super(message); this.name = 'LibraryError'; }
}

function clean(s: string): string {
  return s.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s+/g, ' ').trim();
}
const list = (v: unknown): string[] => (Array.isArray(v) ? v : [v]).filter((x): x is string => typeof x === 'string').map(clean).filter(Boolean);
const first = (v: unknown) => list(v)[0];

/** 一条 PNX 记录 → 精简的文献信息 */
export function normalizeRecord(raw: unknown): LiteratureRecord | undefined {
  const r = raw as { pnx?: Record<string, Record<string, unknown>>; context?: string; delivery?: { availability?: unknown } };
  const pnx = r?.pnx;
  if (!pnx || typeof pnx !== 'object') return undefined;
  const display = pnx.display ?? {};
  const addata = pnx.addata ?? {};
  const search = pnx.search ?? {};
  const control = pnx.control ?? {};
  const facets = pnx.facets ?? {};
  const recordId = first(control.recordid);
  const title = first(display.title) ?? first(addata.atitle);
  if (!recordId || !title) return undefined;
  const context = r.context === 'PC' || r.context === 'L' ? r.context : recordId.startsWith('TN_') ? 'PC' : 'L';
  const date = first(addata.date) ?? first(pnx.sort?.creationdate);
  const year = date?.match(/\d{4}/)?.[0];
  const doi = first(addata.doi) ?? list(display.identifier).find((x) => x.startsWith('DOI:'))?.slice(4).trim();
  const levels = list(facets.toplevel);
  const availability = [...list(r.delivery?.availability), ...list(pnx.delivery?.fulltext)];
  const abstract = list(addata.abstract).join('\n\n') || list(display.description).join('\n\n') || undefined;
  const params = new URLSearchParams({ docid: recordId, context, vid: 'fdu', lang: 'zh_CN', adaptor: context === 'PC' ? 'primo_central_multiple_fe' : 'Local Search Engine' });
  return {
    recordId, context, title,
    authors: (list(addata.au).length ? list(addata.au) : list(search.creator).length ? list(search.creator) : list(display.creator)).slice(0, 8),
    year: year ? Number(year) : undefined, journal: first(addata.jtitle), type: first(display.type), doi,
    abstract: abstract?.slice(0, 3000),
    peerReviewed: levels.includes('peer_reviewed') || undefined,
    fullTextAvailable: availability.includes('fulltext') || levels.includes('online_resources') ? true : availability.some((a) => a.startsWith('no_fulltext')) ? false : undefined,
    url: `${PRIMO_ORIGIN}/primo-explore/fulldisplay?${params}`,
  };
}

export class LibrarySearch {
  private token?: { value: string; until: number };
  private last = 0;
  constructor(private readonly getJson: GetJson, private readonly now = () => Date.now()) {}

  /** 两次请求之间至少间隔 1 秒，不给图书馆系统添负担 */
  private async request(path: string, params: Record<string, string>, token?: string): Promise<{ status: number; text: string }> {
    const wait = 1000 - (this.now() - this.last);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    this.last = this.now();
    const url = `${PRIMO_ORIGIN}${path}?${new URLSearchParams(params)}`;
    return this.getJson(url, { Accept: 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) });
  }

  private async guestToken(force = false): Promise<string> {
    if (!force && this.token && this.now() < this.token.until) return this.token.value;
    const res = await this.request(`${REST}/v1/guestJwt/FDU`, { vid: 'fdu', lang: 'zh_CN' });
    if (res.status >= 400) throw new LibraryError(`图书馆检索系统暂时不可用（${res.status}），请稍后再试。`);
    const value = res.text.trim().replace(/^"|"$/g, '');
    if (!/^[\w-]+\.[\w-]+\.[\w-]+$/.test(value)) throw new LibraryError('图书馆检索系统没有返回可用的访客令牌，请稍后再试。');
    this.token = { value, until: this.now() + 10 * 60_000 };
    return value;
  }

  private async getData(path: string, params: Record<string, string>): Promise<unknown> {
    let res = await this.request(path, params, await this.guestToken());
    if (res.status === 401 || res.status === 403) res = await this.request(path, params, await this.guestToken(true));
    if (res.status === 404) throw new LibraryError('没有找到这条文献，请用最新检索结果里的 record_id。');
    if (res.status === 429 || res.status >= 500) throw new LibraryError('图书馆检索系统暂时繁忙，请稍后再试。');
    if (res.status >= 400) throw new LibraryError(`图书馆检索系统返回 ${res.status}。`);
    try { return JSON.parse(res.text); } catch { throw new LibraryError('图书馆检索系统返回的格式和预期不同。'); }
  }

  async search(q: LiteratureQuery): Promise<{ total: number; records: LiteratureRecord[]; searchUrl: string }> {
    const query = q.query.replace(/[;,]/g, ' ').replace(/\s+/g, ' ').trim();
    if (!query) throw new LibraryError('请提供检索词。');
    const [tab, scope] = SCOPES[q.scope ?? 'articles'];
    const clauses = [`${FIELDS[q.field ?? 'all']},contains,${query}`];
    if (q.yearFrom || q.yearTo) clauses.push(`dr_s,exact,${q.yearFrom ?? 1000}0101`, `dr_e,exact,${q.yearTo ?? 2100}1231`);
    const includes = [q.peerReviewedOnly && 'facet_tlevel,exact,peer_reviewed', q.fullTextOnly && 'facet_tlevel,exact,online_resources'].filter(Boolean) as string[];
    const data = await this.getData(`${REST}/primo-explore/v1/pnxs`, {
      vid: 'fdu', inst: 'FDU', tab, scope, lang: 'zh_CN', q: clauses.join(';'), qInclude: includes.join('|,|'),
      offset: String(q.offset ?? 0), limit: String(Math.min(20, Math.max(1, q.limit ?? 8))), sort: q.sort === 'newest' ? 'date' : 'rank',
      pcAvailability: String(!q.fullTextOnly),
    }) as { info?: { total?: number }; docs?: unknown[] };
    const records = (data.docs ?? []).map(normalizeRecord).filter((x): x is LiteratureRecord => !!x);
    this.remember(records);
    const searchUrl = `${PRIMO_ORIGIN}/primo-explore/search?${new URLSearchParams({ query: clauses[0], vid: 'fdu', tab, search_scope: scope, lang: 'zh_CN' })}`;
    return { total: Number(data.info?.total ?? records.length), records, searchUrl };
  }

  /** 最近检索到的文献（按 record_id 取完整摘要，不再请求图书馆） */
  private recent = new Map<string, LiteratureRecord>();

  remember(records: LiteratureRecord[]): void {
    for (const r of records) this.recent.set(r.recordId, r);
    while (this.recent.size > 200) this.recent.delete(this.recent.keys().next().value!);
  }

  document(recordId: string): LiteratureRecord | undefined {
    return this.recent.get(recordId);
  }
}
