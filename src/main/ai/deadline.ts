import type { Item } from '../../shared/types';

const pad = (n: number) => String(n).padStart(2, '0');
const DAY = 86_400_000;

/** Extract only dates with deadline evidence; event start times are not deadlines. */
export function extractDeadline(mail: Pick<Item, 'title' | 'body' | 'publishedAt'>, now = new Date()): string | undefined {
  const sent = Date.parse(mail.publishedAt);
  const anchor = new Date((Number.isFinite(sent) ? sent : now.getTime()) + 8 * 3_600_000);
  const months = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
  const text = `${mail.title}\n${mail.body}`
    .replace(/\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2})(?:st|nd|rd|th)?(?:,\s*|\s+)(20\d{2})\b/gi,
      (_all, name: string, day: string, year: string) => `${year}-${pad(months.indexOf(name.toLowerCase()) + 1)}-${pad(Number(day))}`)
    .replace(/(\d)\s*([年月日号])/g, '$1$2').replace(/([年月])\s*(?=\d)/g, '$1');
  const dates = /(?:(20\d{2})[-/年])?(\d{1,2})[-/月](\d{1,2})(?:日|号)?|今天|明天|后天|今晚|(?:本周|这周|下周|周|星期)[一二三四五六日天]/g;
  for (const match of text.matchAll(dates)) {
    const index = match.index!;
    const before = text.slice(Math.max(0, index - 45), index);
    const after = text.slice(index + match[0].length, index + match[0].length + 45);
    const preceding = /(?:截止(?:时间)?(?:为|是|至|到)?|截至|最晚(?:于|在)?|不迟于|请于|须于|需于|务必在|due(?:\s+date)?(?:\s+(?:is|on|by))?|deadline(?:\s+(?:is|on))?|(?:submit|upload|send|reply|complete)\b.{0,30}\bby)\s*[:：]?\s*$/i.test(before);
    const following = /^\s*(?:(?:上午|下午|晚上)?\s*\d{1,2}(?::\d{2}(?::\d{2})?|点|时)(?:\d{2}分?)?\s*)?(?:之前|前|截止|截至)/.test(after);
    if (!preceding && !following) continue;
    // “截至某日已有...” is a statistic; “请于某日参加...” is an event invitation.
    if (/^[\s，,]*(?:已有|已经|累计|统计|共计)/.test(after)) continue;
    if (/(?:请于|须于|需于|务必在)\s*$/.test(before) && !following &&
      (!/提交|上传|确认|填写|回复|报名|完成|缴费|打卡/.test(after) || /参加|举行|召开|举办|开讲/.test(after))) continue;
    let year = Number(match[1] || anchor.getUTCFullYear());
    let month = Number(match[2]);
    let day = Number(match[3]);
    if (!match[2]) {
      let offset = match[0] === '明天' ? 1 : match[0] === '后天' ? 2 : 0;
      const weekday = match[0].match(/(?:本周|这周|下周|周|星期)([一二三四五六日天])/);
      if (weekday) {
        const target = '一二三四五六日'.indexOf(weekday[1] === '天' ? '日' : weekday[1]);
        offset = target - ((anchor.getUTCDay() + 6) % 7) + (match[0].startsWith('下周') ? 7 : 0);
      }
      const date = new Date(Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth(), anchor.getUTCDate()) + offset * DAY);
      year = date.getUTCFullYear(); month = date.getUTCMonth() + 1; day = date.getUTCDate();
    }
    const valid = new Date(Date.UTC(year, month - 1, day));
    if (valid.getUTCFullYear() !== year || valid.getUTCMonth() + 1 !== month || valid.getUTCDate() !== day) continue;
    const explicit = after.match(/^[T ](\d{2}:\d{2}(?::\d{2})?)(Z|[+-]\d{2}:\d{2})/);
    if (explicit) {
      const value = `${year}-${pad(month)}-${pad(day)}T${explicit[1]}${explicit[2]}`;
      if (Number.isFinite(Date.parse(value))) return new Date(value).toISOString();
      continue;
    }
    const time = after.match(/^(?:[T\s，,]*)(上午|下午|晚上)?\s*(\d{1,2})(?::|点|时)(\d{2})?/);
    let hour = time ? Number(time[2]) : 23;
    const minute = time ? Number(time[3] || 0) : 59;
    if (time && /下午|晚上/.test(time[1] || '') && hour < 12) hour += 12;
    if (hour > 23 || minute > 59) continue;
    return `${year}-${pad(month)}-${pad(day)}T${pad(hour)}:${pad(minute)}:00+08:00`;
  }
  return undefined;
}
