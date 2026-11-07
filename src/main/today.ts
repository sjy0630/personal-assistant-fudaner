import type { Course, TodayOverview } from '../shared/types';
import type { Repo } from './db/repo';
import { localDate, phaseFor, weekNo } from './engine/calendar';
import { currentPhase } from './engine/clock';

/** 今日概况：右侧「今天」边栏、早安消息、对话上下文共用 */
export function buildToday(repo: Repo, now = new Date()): TodayOverview {
  const date = localDate(now);
  const cal = repo.calendarDay(date);
  const in7d = new Date(now.getTime() + 7 * 86_400_000).toISOString();
  const deadlines = repo
    .listItems({ kind: 'assignment', dueAfter: now.toISOString(), dueBefore: in7d, limit: 30 })
    // 完成 = 平台上已完成，或用户在本地把对应任务标记为完成（如组作业由组长提交）
    .map((i) => ({ itemId: i.id, title: i.title, course: i.courseId ? repo.getCourse(i.courseId)?.name : undefined, dueAt: i.dueAt!, done: i.done || repo.taskForItem(i.id)?.status === 'done' }));
  const weekStart = new Date(now);
  weekStart.setDate(now.getDate() - ((now.getDay() + 6) % 7));
  weekStart.setHours(0, 0, 0, 0);
  const weekEnd = new Date(weekStart.getTime() + 7 * 86_400_000);
  const weekTasks = repo.listTasks({ dueBefore: weekEnd.toISOString() }).filter((t) => t.dueAt && t.dueAt >= weekStart.toISOString());
  const courses = coursesOn(repo.listCourses(), now);
  const exams = repo.listItems({ kind: 'exam', dueAfter: now.toISOString(), dueBefore: new Date(now.getTime() + 14 * 86_400_000).toISOString(), limit: 10 })
    .map((i) => ({ itemId: i.id, course: i.title.replace(/ 考试$/, ''), startsAt: i.dueAt!, location: i.body.split('\n')[1] || undefined }));
  return {
    date,
    weekNo: cal?.weekNo ?? weekNo(date),
    phase: currentPhase(repo, date),
    courses: courses.map((c) => ({ name: c.name, time: `${c.start}–${c.end}`, location: c.location })),
    freeSlots: freeSlots(courses),
    deadlines,
    mailToReply: repo.listItems({ kind: 'email', category: 'reply', done: false, limit: 50 }).length,
    weekProgress: { done: weekTasks.filter((t) => t.status === 'done').length, total: weekTasks.length },
    ...(exams.length ? { exams } : {}),
  };
}

/**
 * 某天要上的课，按开始时间排序。课表来自 courses.schedule（导入的真实课表或演示数据）。
 * 真实课表带教学周：只排这一周要上的课；节假日和寒暑假没有课。
 */
export function coursesOn(courses: Course[], day: Date): { name: string; start: string; end: string; location?: string }[] {
  const weekday = ((day.getDay() + 6) % 7) + 1; // 1 = 周一
  const date = localDate(day);
  const week = weekNo(date);
  const hasRealWeeks = courses.some((c) => c.schedule?.some((s) => s.weeks?.length));
  if (hasRealWeeks && (week === undefined || phaseFor(date) === 'holiday')) return [];
  return courses
    .flatMap((c) => (c.schedule ?? [])
      .filter((s) => s.weekday === weekday && (!s.weeks?.length || (week !== undefined && s.weeks.includes(week))))
      .map((s) => ({ name: c.name, start: s.start, end: s.end, location: s.location })))
    .sort((a, b) => a.start.localeCompare(b.start));
}

/** 08:00–22:00 之间、扣掉上课时间后，不少于 60 分钟的空闲时段 */
export function freeSlots(busy: { start: string; end: string }[], from = '08:00', to = '22:00', minMinutes = 60): { start: string; end: string }[] {
  const m = (s: string) => { const [h, mm] = s.split(':').map(Number); return h * 60 + mm; };
  const hhmm = (n: number) => `${String(Math.floor(n / 60)).padStart(2, '0')}:${String(n % 60).padStart(2, '0')}`;
  const out: { start: string; end: string }[] = [];
  let cursor = m(from);
  for (const b of [...busy].sort((x, y) => m(x.start) - m(y.start))) {
    if (m(b.start) - cursor >= minMinutes) out.push({ start: hhmm(cursor), end: b.start });
    cursor = Math.max(cursor, m(b.end));
  }
  if (m(to) - cursor >= minMinutes) out.push({ start: hhmm(cursor), end: to });
  return out;
}
