import { load } from 'cheerio';
import type { CampusReader } from './timetable-sync';

/**
 * 校园生活小工具：图书馆在馆人数（公开接口，不需要登录）、校园卡余额（复用统一身份认证会话，只读）。
 */
export const LIBRARY_URL = 'https://mlibrary.fudan.edu.cn/api/common/h5/getspaceseat';
export const CARD_URL = 'https://ecard.fudan.edu.cn/epay/myepay/index';

/** inside：在馆人数；remaining：还能进入的人数 */
export interface LibraryStatus { name: string; inside: number | null; remaining: number | null; openTime?: string }

/** 图书馆接口：{ code: '1', data: [{ campusName, inNum 在馆人数, canInNumb 还能进入的人数, libraryOpenTime }] } */
export function parseLibrary(body: string): LibraryStatus[] {
  let data: { code?: unknown; data?: unknown };
  try { data = JSON.parse(body); } catch { throw new Error('图书馆接口返回的格式和预期不同。'); }
  if (String(data?.code) !== '1' || !Array.isArray(data.data)) throw new Error('图书馆人数暂时查不到，请稍后再试。');
  const num = (v: unknown) => (typeof v === 'number' || (typeof v === 'string' && /^\d+$/.test(v.trim())) ? Number(v) : null);
  return data.data.flatMap((x) => {
    const r = x as Record<string, unknown>;
    const name = typeof r.campusName === 'string' ? r.campusName.trim() : '';
    if (!name) return [];
    return [{ name, inside: num(r.inNum), remaining: num(r.canInNumb), openTime: typeof r.libraryOpenTime === 'string' && r.libraryOpenTime.trim() ? r.libraryOpenTime.trim() : undefined }];
  });
}

export async function readLibrary(post: (url: string) => Promise<{ status: number; text: string }>): Promise<LibraryStatus[]> {
  const res = await post(LIBRARY_URL);
  if (res.status >= 400) throw new Error(`图书馆接口返回 ${res.status}`);
  return parseLibrary(res.text);
}

/** 校园卡页面：余额在「支付方式」卡片里，形如「¥ 123.45」 */
export function parseCardBalance(html: string): number {
  const $ = load(html);
  const candidates = [
    $('.payway-box-bottom-item p').first().text(),
    $('[class*="balance"]').first().text(),
  ].map((t) => t.replace(/\s/g, ''));
  for (const text of candidates) {
    const m = /^(?:[¥￥]|CNY|RMB|余额[:：]?)?(-?\d{1,3}(?:,\d{3})*(?:\.\d{1,2})?|-?\d+(?:\.\d{1,2})?)元?$/i.exec(text);
    if (m) return Number(m[1].replace(/,/g, ''));
  }
  throw new Error('没有在校园卡页面上找到余额，学校页面可能更新了。');
}

export async function readCardBalance(reader: CampusReader): Promise<number> {
  const ready = (html: string) => /payway-box-bottom-item|balance/.test(html);
  let html = (await reader.getText(CARD_URL)).text;
  if (!ready(html) && reader.render) html = await reader.render(CARD_URL, ready);
  return parseCardBalance(html);
}
