import { load, type CheerioAPI } from 'cheerio';
import type { Element } from 'domhandler';

/**
 * 学校和院系官网「通知公告」列表页的通用解析。
 *
 * 不为每个网站单独写规则：找出页面里每一行「一个链接 + 一个日期」的条目。
 * 学校网站大多用同一套建站系统，行一般是 li / tr / dd，日期写成 2026-11-05、2026.11.05、
 * 2026年11月5日，或者把「日」和「年-月」拆在两个元素里（05 / 2026-11）。
 */
export interface NoticeLink {
  url: string;
  title: string;
  /** YYYY-MM-DD；列表上没有日期时省略 */
  date?: string;
}

const ROW = 'li, tr, dd, dl, article, .news, .item, .list-item, .news_list > div, .list > div';
const FILE = /\.(pdf|docx?|xlsx?|pptx?|zip|rar|jpe?g|png|gif)(\?|$)/i;

function validDate(y: number, m: number, d: number): string | undefined {
  if (y < 2000 || y > 2100 || m < 1 || m > 12 || d < 1 || d > 31) return undefined;
  const iso = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  return new Date(`${iso}T00:00:00Z`).toISOString().startsWith(iso) ? iso : undefined;
}

/** 一段文字里的日期；有多个不同日期时认为不是单条通知（返回 null） */
export function findDate(text: string): string | undefined | null {
  const full = new Set<string>();
  for (const m of text.matchAll(/(?<!\d)(20\d{2})\s*[-/.年]\s*(\d{1,2})\s*[-/.月]\s*(\d{1,2})\s*日?(?!\d)/g)) {
    const d = validDate(+m[1], +m[2], +m[3]);
    if (d) full.add(d);
  }
  if (full.size === 1) return [...full][0];
  if (full.size > 1) return null;
  // 「05 2026-11」「2026-11 05」这种拆开的写法
  const ym = text.match(/(?<!\d)(20\d{2})\s*[-/.年]\s*(\d{1,2})(?![\d-/.])/);
  const rest = ym ? text.replace(ym[0], ' ') : '';
  const day = ym ? rest.match(/(?<!\d)(\d{1,2})(?!\d)/) : null;
  if (ym && day) return validDate(+ym[1], +ym[2], +day[1]) ?? undefined;
  return undefined;
}

function cleanText(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

export function parseNoticeList(html: string, pageUrl: string, opts: { allowNoDate?: boolean } = {}): NoticeLink[] {
  const $ = load(html);
  const base = new URL(pageUrl);
  const found = new Map<string, NoticeLink>();
  $('a[href]').each((_, el) => {
    const a = $(el);
    const row = a.closest(ROW);
    if (!row.length || row.is('body, html')) return;
    // 一行只能指向一篇文章（导航菜单、分页一行有很多链接）
    const hrefs = new Set(row.find('a[href]').map((_i, x) => $(x).attr('href')).get());
    if (hrefs.size !== 1) return;
    let url: URL;
    try {
      url = new URL(a.attr('href')!, base);
    } catch {
      return;
    }
    const sameSite = url.hostname === base.hostname || url.hostname.endsWith('.fudan.edu.cn');
    if (!/^https?:$/.test(url.protocol) || !sameSite || url.username || url.password || FILE.test(url.pathname)) return;
    if (url.href.replace(/#.*$/, '') === base.href.replace(/#.*$/, '')) return;
    url.hash = '';
    const title = cleanText(a.attr('title') || a.find('[title]').attr('title') || rowTitle($, a));
    if (title.length < 4 || /^(更多|more|首页|上一页|下一页|尾页)/i.test(title)) return;
    const date = rowDate($, row, title);
    if (date === null) return;
    if (!date && !opts.allowNoDate) return;
    if (!found.has(url.href)) found.set(url.href, { url: url.href, title, date: date || undefined });
  });
  return [...found.values()].sort((x, y) => (y.date ?? '').localeCompare(x.date ?? ''));
}

/** 元素文字，相邻元素之间加空格（避免「12」「2026.10」拼成「122026.10」） */
function spaced($: CheerioAPI, el: ReturnType<CheerioAPI>): string {
  const copy = el.clone();
  copy.find('*').each((_i, x) => { $(x).prepend(' ').append(' '); });
  return cleanText(copy.text());
}

const DATE_ONLY = /^[\s\d年月日\-/.:：]+$/;

/**
 * 行里的发布日期：先找 class 带 date / time 的元素或 <time>，再找只写着日期的元素，
 * 最后才看整行文字（去掉标题，标题里常有「2026/11/06 更新」）。
 */
function rowDate($: CheerioAPI, row: ReturnType<CheerioAPI>, title: string): string | undefined | null {
  const marked = row.find('time, [class*="date"], [class*="time"], [class*="Date"]').first();
  if (marked.length) {
    const d = findDate(`${spaced($, marked)} ${marked.attr('datetime') ?? ''}`);
    if (d) return d;
  }
  const only = row.find('span, div, p, em, i, td, font').filter((_i, x) => {
    const t = cleanText($(x).text());
    return t.length >= 4 && DATE_ONLY.test(t) && /20\d{2}/.test(t);
  }).first();
  if (only.length) {
    const parent = only.parent();
    const d = findDate(spaced($, parent.is(row) ? only : parent));
    if (d) return d;
  }
  return findDate(spaced($, row).split(title).join(' '));
}

/** 链接文字里常混着日期、摘要；优先取标题样式的子元素，不取只有日期的元素 */
function rowTitle($: CheerioAPI, a: ReturnType<CheerioAPI>): string {
  const candidates = a.find('.title, .tit, [class*="tt"], h3, h4, p, span')
    .map((_i, x) => cleanText($(x).text())).get()
    .filter((t) => t.length >= 6 && !DATE_ONLY.test(t));
  const text = candidates[0] ?? cleanText(a.text());
  return text.replace(/(?<!\d)20\d{2}\s*[-/.年]\s*\d{1,2}\s*[-/.月]\s*\d{1,2}\s*日?/g, '');
}

export interface NoticeDetail {
  title?: string;
  date?: string;
  text: string;
  attachments: { name: string; url: string }[];
}

const BODY = ['.wp_articlecontent', '.v_news_content', '#vsb_content', '.article-content', '.article_content', '.content-con', '.TRS_Editor', '.entry-content', 'article', '.article', '.content', '#content'];

/** 通知详情页：正文、发布日期、附件 */
export function parseNoticeDetail(html: string, pageUrl: string): NoticeDetail {
  const $ = load(html);
  $('script, style, noscript, nav, header, footer').remove();
  const hasContent = (x: Element) => cleanText($(x).text()).length > 30 || $(x).find('[pdfsrc], iframe[src], embed[src], img').length > 0;
  let body: ReturnType<CheerioAPI> | undefined;
  for (const sel of BODY) {
    const el = $(sel).filter((_i, x) => hasContent(x as Element)).first();
    if (el.length) { body = el; break; }
  }
  if (!body) {
    // 兜底：文字最多、且不是导航（链接文字占比低）的块
    let best: Element | undefined;
    let bestLen = 0;
    $('div, td, section').each((_i, x) => {
      const own = $(x).clone();
      own.children('div, section, table, ul').remove();
      const len = cleanText(own.text()).length;
      const linkLen = cleanText(own.find('a').text()).length;
      if (len > bestLen && linkLen < len / 2) { best = x as Element; bestLen = len; }
    });
    body = best ? $(best) : $('body');
  }
  const base = new URL(pageUrl);
  const attachments: NoticeDetail['attachments'] = [];
  const addFile = (raw: string | undefined, name: string) => {
    if (!raw) return;
    try {
      const url = new URL(raw, base);
      if (FILE.test(url.pathname) && !attachments.some((f) => f.url === url.href)) {
        attachments.push({ name: name || decodeURIComponent(url.pathname.split('/').pop() ?? '附件'), url: url.href });
      }
    } catch { /* 忽略坏链接 */ }
  };
  body.find('a[href]').each((_i, x) => addFile($(x).attr('href'), cleanText($(x).text())));
  // 学校建站系统把 PDF 正文嵌在页面里（pdfsrc / iframe）
  body.find('[pdfsrc]').each((_i, x) => addFile($(x).attr('pdfsrc'), /['"]title['"]\s*:\s*['"]([^'"]+)['"]/.exec($(x).attr('sudyfile-attr') ?? '')?.[1] ?? ''));
  body.find('iframe[src], embed[src]').each((_i, x) => addFile($(x).attr('src'), ''));
  if (!attachments.length) $('[pdfsrc], iframe[src], embed[src]').each((_i, x) => addFile($(x).attr('pdfsrc') ?? $(x).attr('src'), ''));
  body.find('br').replaceWith('\n');
  body.find('p, div, li, tr, h1, h2, h3, h4').each((_i, x) => { $(x).append('\n'); });
  const text = body.text().replace(/[ \t 　]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  const meta = cleanText($('.arti_metas, .article-info, .info, .time, .date, .news_meta, .arti-metas, .view-info').first().text());
  const labeled = cleanText($('body').text()).match(/(?:发布(?:日期|时间)|日期|时间)\s*[:：]\s*(20\d{2}\s*[-/.年]\s*\d{1,2}\s*[-/.月]\s*\d{1,2})/)?.[1];
  const title = cleanText($('.arti_title, .article-title, .news_title, .view-title, .art-tit h3, h1').first().text()) || cleanText($('title').text()).replace(/\s*[-|_].*$/, '');
  return { title: title || undefined, date: findDate(meta) || (labeled ? findDate(labeled) : undefined) || undefined, text, attachments };
}
