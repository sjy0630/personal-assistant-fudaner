/**
 * 读取文章：公众号文章页、普通网页，以及 RSS / Atom 订阅源。
 *
 * 只读取公开页面，不登录微信、不调用微信的私有接口。
 * 批量跟踪公众号时，由用户自己选择把公众号转成 RSS 的工具（见 docs/TRIAL.md），应用只读 RSS。
 */

export interface Article {
  url: string;
  title: string;
  /** 公众号名 / 网站名 */
  sourceName?: string;
  publishedAt?: string;
  /** 正文纯文本 */
  text: string;
}

export interface FeedEntry {
  /** guid / id，没有时用链接 */
  id: string;
  title: string;
  link?: string;
  publishedAt?: string;
  /** 订阅源里自带的正文（HTML），足够长时就不用再打开原文 */
  html?: string;
}

export function isWechatArticle(url: string): boolean {
  try {
    const u = new URL(url);
    return u.hostname === 'mp.weixin.qq.com' && (u.pathname.startsWith('/s') || u.pathname.startsWith('/mp/appmsg'));
  } catch {
    return false;
  }
}

/** 微信在访问太频繁时会返回「环境异常 / 完成验证」页面，这时没有正文 */
export function isWechatVerifyPage(html: string): boolean {
  return /环境异常|完成验证后即可继续访问|当前环境异常/.test(html) && !/id="js_content"/.test(html);
}

/** 文章已被删除、违规或过期 */
export function isWechatUnavailable(html: string): boolean {
  return /该内容已被发布者删除|此内容因违规无法查看|该公众号已迁移|内容已过期/.test(html) && !/id="js_content"/.test(html);
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'", ldquo: '“', rdquo: '”', mdash: '—', hellip: '…', middot: '·' };

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+\d*);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

/** HTML → 保留段落的纯文本 */
export function htmlToText(html: string): string {
  return decodeEntities(html
    .replace(/<(script|style|noscript|svg|template)[\s\S]*?<\/\1>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|section|h[1-6]|li|tr|blockquote)>/gi, '\n')
    .replace(/<li[^>]*>/gi, '· ')
    .replace(/<[^>]+>/g, ''))
    .replace(/[ \t 　]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function meta(html: string, key: string): string | undefined {
  const re = new RegExp(`<meta[^>]+(?:property|name)=["']${key}["'][^>]*>`, 'i');
  const tag = html.match(re)?.[0];
  const content = tag?.match(/content=["']([^"']*)["']/i)?.[1];
  return content ? decodeEntities(content).trim() || undefined : undefined;
}

/** 取 id="..." 元素的内部 HTML（按同名标签计数找到配对的结束标签） */
function elementById(html: string, id: string): string | undefined {
  const open = new RegExp(`<([a-z0-9]+)[^>]*\\bid=["']${id}["'][^>]*>`, 'i').exec(html);
  if (!open) return undefined;
  const tag = open[1].toLowerCase();
  const re = new RegExp(`<(/?)${tag}\\b[^>]*>`, 'gi');
  re.lastIndex = open.index + open[0].length;
  let depth = 1;
  for (let m = re.exec(html); m; m = re.exec(html)) {
    depth += m[1] ? -1 : m[0].endsWith('/>') ? 0 : 1;
    if (depth === 0) return html.slice(open.index + open[0].length, m.index);
  }
  return html.slice(open.index + open[0].length);
}

function jsVar(html: string, name: string): string | undefined {
  const m = html.match(new RegExp(`var\\s+${name}\\s*=\\s*(?:htmlDecode\\()?\\s*(["'])((?:\\\\.|(?!\\1).)*)\\1`));
  return m ? decodeEntities(m[2].replace(/\\x([0-9a-f]{2})/gi, (_, h: string) => String.fromCharCode(parseInt(h, 16))).replace(/\\(.)/g, '$1')).trim() || undefined : undefined;
}

/** 解析一篇文章。公众号文章取 #js_content，其他网页取 article / main / 正文最长的块 */
export function parseArticle(html: string, url: string): Article {
  if (isWechatArticle(url) || /id=["']js_content["']/.test(html)) {
    const title = meta(html, 'og:title') || jsVar(html, 'msg_title') || htmlToText(elementById(html, 'activity-name') ?? '');
    const sourceName = jsVar(html, 'nickname') || htmlToText(elementById(html, 'js_name') ?? '') || meta(html, 'og:article:author');
    const ct = html.match(/var\s+ct\s*=\s*["']?(\d{10})["']?/)?.[1] ?? html.match(/create_time\s*[:=]\s*["']?(\d{10})/)?.[1];
    const createTime = jsVar(html, 'createTime');
    const publishedAt = ct ? new Date(Number(ct) * 1000).toISOString() : createTime ? toIso(createTime) : undefined;
    return { url, title: title || '公众号文章', sourceName: sourceName || undefined, publishedAt, text: htmlToText(elementById(html, 'js_content') ?? '') };
  }
  const title = meta(html, 'og:title') || htmlToText(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? '');
  const body = html.match(/<article[\s\S]*?<\/article>/i)?.[0]
    ?? html.match(/<main[\s\S]*?<\/main>/i)?.[0]
    ?? longestBlock(html)
    ?? html;
  const published = meta(html, 'article:published_time') ?? html.match(/发布(?:时间|日期)[:：\s]*(\d{4}[-/.年]\d{1,2}[-/.月]\d{1,2})/)?.[1];
  return { url, title: title || url, sourceName: meta(html, 'og:site_name'), publishedAt: published ? toIso(published) : undefined, text: htmlToText(body) };
}

/** 学校网站常见的正文容器 */
function longestBlock(html: string): string | undefined {
  const candidates = ['v_news_content', 'wp_articlecontent', 'article-content', 'content'];
  for (const c of candidates) {
    const re = new RegExp(`<div[^>]+(?:class|id)=["'][^"']*\\b${c}\\b[^"']*["'][^>]*>`, 'i');
    const m = re.exec(html);
    if (m) {
      const id = `__fudaner_${c}`;
      const marked = html.slice(0, m.index) + m[0].replace(/^<div/i, `<div id="${id}"`) + html.slice(m.index + m[0].length);
      const inner = elementById(marked, id);
      if (inner && htmlToText(inner).length > 30) return inner;
    }
  }
  return undefined;
}

function toIso(s: string): string | undefined {
  const m = s.match(/(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})日?(?:\s+(\d{1,2}):(\d{2}))?/);
  if (!m) {
    const t = Date.parse(s);
    return Number.isFinite(t) ? new Date(t).toISOString() : undefined;
  }
  const [, y, mo, d, h = '0', mi = '0'] = m;
  return shanghai(Number(y), Number(mo), Number(d), Number(h), Number(mi));
}

/** 上海时间 → ISO（UTC） */
export function shanghai(y: number, mo: number, d: number, h = 0, mi = 0): string {
  return new Date(Date.UTC(y, mo - 1, d, h - 8, mi)).toISOString();
}

/** 解析 RSS 2.0 / Atom（够用的轻量实现，不执行任何外部实体） */
export function parseFeed(xml: string): { title?: string; entries: FeedEntry[] } {
  const text = (s?: string) => (s ? decodeEntities(s.replace(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/, '$1')).trim() : undefined);
  const raw = (s?: string) => s?.replace(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/, '$1');
  const tag = (block: string, name: string) => block.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'i'))?.[1];
  const isAtom = /<feed[\s>]/i.test(xml) && !/<rss[\s>]/i.test(xml);
  const blocks = xml.match(isAtom ? /<entry[\s>][\s\S]*?<\/entry>/gi : /<item[\s>][\s\S]*?<\/item>/gi) ?? [];
  const head = xml.slice(0, xml.search(isAtom ? /<entry[\s>]/i : /<item[\s>]/i) >>> 0);
  const entries = blocks.map((b): FeedEntry => {
    const link = isAtom
      ? (b.match(/<link[^>]*rel=["']alternate["'][^>]*>/i)?.[0] ?? b.match(/<link[^>]*>/i)?.[0])?.match(/href=["']([^"']+)["']/i)?.[1]
      : text(tag(b, 'link'));
    const date = text(tag(b, isAtom ? 'published' : 'pubDate')) ?? text(tag(b, 'updated')) ?? text(tag(b, 'dc:date'));
    const parsed = date ? Date.parse(date) : NaN;
    const html = raw(tag(b, 'content:encoded')) ?? raw(tag(b, 'content')) ?? raw(tag(b, isAtom ? 'summary' : 'description'));
    const id = text(tag(b, isAtom ? 'id' : 'guid')) ?? link ?? text(tag(b, 'title')) ?? '';
    return {
      id, title: htmlToText(text(tag(b, 'title')) ?? '') || '（无标题）', link: link ? decodeEntities(link) : undefined,
      publishedAt: Number.isFinite(parsed) ? new Date(parsed).toISOString() : undefined,
      html: html ? decodeEntities(html) : undefined,
    };
  }).filter((e) => e.id);
  return { title: text(tag(head, 'title')), entries };
}

/** 只允许访问公网的 http(s) 地址，不访问本机和内网 */
export function checkPublicUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error('请提供完整的链接，例如 https://mp.weixin.qq.com/s/……');
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('请提供 http 或 https 开头的公开链接。');
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  const privateHost = host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host === '::1' || host === '0.0.0.0'
    || /^(127|10)\./.test(host) || /^192\.168\./.test(host) || /^169\.254\./.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host)
    || /^f[cd][0-9a-f]{2}:/.test(host) || /^fe80:/.test(host);
  if (privateHost) throw new Error('不能读取本机或内网地址。');
  return url;
}
