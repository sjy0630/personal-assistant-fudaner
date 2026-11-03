import type { TodayOverview } from '../shared/types';
import type { Repo } from './db/repo';
import { localDate, weekNo } from './engine/calendar';
import { currentPhase } from './engine/clock';

/** 今日概况：右侧「今天」边栏、早安消息、对话上下文共用 */
export function buildToday(repo: Repo, now = new Date()): TodayOverview {
  const date = localDate(now);
  const cal = repo.calendarDay(date);
  const in7d = new Date(now.getTime() + 7 * 86_400_000).toISOString();
  const deadlines = repo
    .listItems({ kind: 'assignment', dueAfter: now.toISOString(), dueBefore: in7d, limit: 30 })
    .map((i) => ({ itemId: i.id, title: i.title, course: i.courseId ? repo.getCourse(i.courseId)?.name : undefined, dueAt: i.dueAt!, done: i.done }));
  const weekStart = new Date(now);
  weekStart.setDate(now.getDate() - ((now.getDay() + 6) % 7));
  weekStart.setHours(0, 0, 0, 0);
  const weekEnd = new Date(weekStart.getTime() + 7 * 86_400_000);
  const weekTasks = repo.listTasks({ dueBefore: weekEnd.toISOString() }).filter((t) => t.dueAt && t.dueAt >= weekStart.toISOString());
  return {
    date,
    weekNo: cal?.weekNo ?? weekNo(date),
    phase: currentPhase(repo, date),
    // TODO(D)：课表导入后填充今日课程
    courses: [],
    deadlines,
    mailToReply: repo.listItems({ kind: 'email', category: 'reply', done: false, limit: 50 }).length,
    weekProgress: { done: weekTasks.filter((t) => t.status === 'done').length, total: weekTasks.length },
  };
}
