/** 本地小模型查询的日期边界与展示时间由程序提供，原始 ISO 字段仍保留。 */
export const shanghaiTime = (iso: string) => new Date(iso).toLocaleString('sv-SE', { timeZone: 'Asia/Shanghai', hour12: false });

export function courseState(time: string | undefined, date: string, nowIso: string): string | undefined {
  const now = shanghaiTime(nowIso);
  const range = time?.match(/^(\d{2}:\d{2})\s*[–—-]\s*(\d{2}:\d{2})$/);
  if (!range || !now.startsWith(date)) return;
  const clock = now.slice(11, 16);
  return clock >= range[2] ? '已结束' : clock >= range[1] ? '正在上课' : '尚未开始';
}

export function queryRange(text: string, nowIso: string): { from: string; to: string } | undefined {
  const now = new Date(nowIso);
  if (/未来\s*[7七]\s*天|接下来\s*[7七]\s*天/u.test(text)) return { from: now.toISOString(), to: new Date(now.getTime() + 7 * 86_400_000).toISOString() };
  // 跟随本项目校历：周日到周六。提及其他日期/周时交回模型，不猜范围。
  if (!/本周|这周/u.test(text) || /下周|上周|明天|后天|\d{4}-\d{2}-\d{2}|\d{1,2}月\d{1,2}/u.test(text)) return;
  const date = new Date(shanghaiTime(nowIso).slice(0, 10) + 'T00:00:00Z');
  const start = date.getTime() - date.getUTCDay() * 86_400_000 - 8 * 3_600_000;
  return { from: new Date(start).toISOString(), to: new Date(start + 7 * 86_400_000 - 1).toISOString() };
}

export function queryArguments(text: string, name: string, args: Record<string, unknown>, nowIso: string): Record<string, unknown> {
  if (name === 'fudaner_local__get_today' && /今天/u.test(text) && !/明天|后天|昨天|\d{4}-\d{2}-\d{2}/u.test(text)) return { ...args, date: shanghaiTime(nowIso).slice(0, 10) };
  if (name !== 'fudaner_local__list_deadlines') return args;
  return { ...args, ...queryRange(text, nowIso), ...(/未完成|没交|未交|待交/u.test(text) ? { pending_only: true } : {}) };
}

export function queryResultContext(text: string, nowIso: string): string {
  try {
    const decorate = (value: unknown): unknown => {
      if (Array.isArray(value)) return value.map(decorate);
      if (!value || typeof value !== 'object') return value;
      const record = value as Record<string, unknown>;
      const output: Record<string, unknown> = Object.fromEntries(Object.entries(record).map(([key, item]) => [key, decorate(item)]));
      if (typeof record.dueAt === 'string' && Number.isFinite(Date.parse(record.dueAt))) output.dueAtShanghai = shanghaiTime(record.dueAt) + '（Asia/Shanghai）';
      if (typeof record.date === 'string' && Array.isArray(record.courses)) output.courses = record.courses.map(course => ({ ...course, state: courseState(course.time, record.date as string, nowIso) }));
      return output;
    };
    return JSON.stringify(decorate(JSON.parse(text)));
  } catch { return text; }
}
