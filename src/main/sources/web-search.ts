import { load } from 'cheerio';

/**
 * 联网搜索（必应网页搜索，不需要 API Key；国内用 cn.bing.com）。
 * 给「动态」找用户可能感兴趣的资讯用。只发送检索词，不发送用户的其他信息。
 */
export interface WebResult { title: string; url: string; snippet: string; date?: string; site?: string }

export type FetchPage = (url: string, headers: Record<string, string>) => Promise<{ status: number; url: string; text: string }>;

/** 必应结果链接有时是跳转地址（/ck/a?...&u=a1<base64>），还原成原文地址 */
export function unwrapBingUrl(href: string): string {
  try {
    const u = new URL(href, 'https://cn.bing.com');
    if (u.hostname.endsWith('bing.com') && u.pathname.startsWith('/ck/')) {
      const encoded = u.searchParams.get('u');
      if (encoded?.startsWith('a1')) {
        const b64 = encoded.slice(2).replace(/-/g, '+').replace(/_/g, '/');
        const decoded = Buffer.from(b64 + '='.repeat((4 - (b64.length % 4)) % 4), 'base64').toString('utf8');
        if (/^https?:\/\//.test(decoded)) return decoded;
      }
    }
    return u.href;
  } catch {
    return href;
  }
}

export function parseBingResults(html: string): WebResult[] {
  const $ = load(html);
  const out: WebResult[] = [];
  $('li.b_algo').each((_i, li) => {
    const a = $(li).find('h2 a').first();
    const href = a.attr('href');
    const title = a.text().replace(/\s+/g, ' ').trim();
    if (!href || !title) return;
    const url = unwrapBingUrl(href);
    if (!/^https?:\/\//.test(url) || /bing\.com|microsoft\.com\/.*bing/.test(new URL(url).hostname)) return;
    const caption = $(li).find('.b_caption p, p[class*="b_lineclamp"], .b_algoSlug, .b_paractl').first().text().replace(/\s+/g, ' ').trim();
    const date = caption.match(/^(\d{4}年\d{1,2}月\d{1,2}日|\d{4}-\d{1,2}-\d{1,2}|\d+\s*(?:天|小时|分钟)前)/)?.[1];
    const snippet = caption.replace(/^(\d{4}年\d{1,2}月\d{1,2}日|\d{4}-\d{1,2}-\d{1,2}|\d+\s*(?:天|小时|分钟)前)\s*[·・\-—]\s*/, '');
    const site = $(li).find('.tptt, .b_attribution cite').first().text().trim() || new URL(url).hostname;
    if (!out.some((r) => r.url === url)) out.push({ title, url, snippet: snippet.slice(0, 300), date, site: site.slice(0, 40) });
  });
  return out;
}

/** 搜索；recentDays 限定最近一周 / 一个月（必应的时间筛选） */
export async function webSearch(fetchPage: FetchPage, query: string, opts: { recent?: 'week' | 'month'; host?: string } = {}): Promise<WebResult[]> {
  const host = opts.host ?? 'cn.bing.com';
  const params = new URLSearchParams({ q: query, setlang: 'zh-hans', cc: 'cn' });
  if (opts.recent) params.set('filters', `ex1:"${opts.recent === 'week' ? 'ez2' : 'ez3'}"`);
  const res = await fetchPage(`https://${host}/search?${params}`, { 'Accept-Language': 'zh-CN,zh;q=0.9' });
  if (res.status >= 400) throw new Error(`搜索服务返回 ${res.status}`);
  // 搜索引擎把请求当成机器人时会返回不相关的结果：至少要提到检索词里的一个词才保留
  const terms = query.split(/\s+/).map((t) => t.replace(/["'“”]/g, '')).filter((t) => t.length >= 2);
  const results = parseBingResults(res.text).filter((r) => !terms.length || terms.some((t) => `${r.title} ${r.snippet}`.toLowerCase().includes(t.toLowerCase())));
  // 国外网络访问 cn.bing.com 会被转到首页，换 www.bing.com 再试一次
  if (!results.length && host === 'cn.bing.com' && !/b_algo/.test(res.text)) return webSearch(fetchPage, query, { ...opts, host: 'www.bing.com' });
  return results;
}
