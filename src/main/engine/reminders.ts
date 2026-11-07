import type { Reminder, ReminderRepeat } from '../../shared/types';

/**
 * 定时提醒的时间计算（按本机时区，即用户所在的上海时间）。
 * weekdays：1 = 周一 … 7 = 周日。
 */
const hhmm = /^([01]?\d|2[0-3]):([0-5]\d)$/;

export function validateRepeat(r: ReminderRepeat): string | undefined {
  if (r.type === 'once') return Number.isFinite(Date.parse(r.at)) ? undefined : '一次性提醒需要一个合法的时间。';
  if (!hhmm.test(r.time)) return '时间要写成 HH:MM，例如 22:00。';
  if (r.type === 'weekly' && (!r.weekdays.length || r.weekdays.some((d) => !Number.isInteger(d) || d < 1 || d > 7))) return '每周提醒需要选择星期几（1 = 周一 … 7 = 周日）。';
  return undefined;
}

/** after 之后（不含）的下一次触发时间；一次性提醒已过期时返回 undefined */
export function nextOccurrence(r: ReminderRepeat, after: Date): Date | undefined {
  if (r.type === 'once') {
    const at = new Date(r.at);
    return at.getTime() > after.getTime() ? at : undefined;
  }
  const [h, m] = r.time.split(':').map(Number);
  for (let i = 0; i <= 7; i++) {
    const d = new Date(after);
    d.setDate(after.getDate() + i);
    d.setHours(h, m, 0, 0);
    if (d.getTime() <= after.getTime()) continue;
    const weekday = ((d.getDay() + 6) % 7) + 1;
    if (r.type === 'weekly' && !r.weekdays.includes(weekday)) continue;
    return d;
  }
  return undefined;
}

const WD = ['', '一', '二', '三', '四', '五', '六', '日'];

/** 给人看的重复规则，例如「每天 22:00」「每周一、三 08:00」「11月8日 23:00」 */
export function describeRepeat(r: ReminderRepeat): string {
  if (r.type === 'once') {
    const d = new Date(r.at);
    return `${d.getMonth() + 1}月${d.getDate()}日 ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  }
  if (r.type === 'daily') return `每天 ${r.time}`;
  const days = [...r.weekdays].sort();
  if (days.join() === '1,2,3,4,5') return `工作日 ${r.time}`;
  if (days.join() === '6,7') return `周末 ${r.time}`;
  return `每周${days.map((d) => WD[d]).join('、')} ${r.time}`;
}

/** 错过太久（电脑关机、睡眠）的不再补发 */
export const MAX_LATE_MS = 12 * 3_600_000;

export function isStale(reminder: Pick<Reminder, 'nextAt'>, now: Date): boolean {
  return !!reminder.nextAt && now.getTime() - Date.parse(reminder.nextAt) > MAX_LATE_MS;
}
