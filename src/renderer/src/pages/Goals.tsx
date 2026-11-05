import { useCallback, useEffect, useRef, useState } from 'react';
import type { CardRef, Goal, Task } from '../../../shared/types';
import { api, fmtTime } from '../api';

const LEVELS: { level: Goal['level']; title: string }[] = [
  { level: 'long_term', title: '🌟 长期目标' },
  { level: 'course', title: '📘 本学期课程' },
  { level: 'week', title: '📅 本周' },
];
const SOURCE: Record<Task['source'], string> = { elearning: 'eLearning', assistant: '助理拆解', user: '自己创建' };
function dateKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}
function sortedTasks(tasks: Task[]): Task[] {
  const rank = { todo: 0, done: 1, skipped: 2 };
  return [...tasks].sort((a, b) => rank[a.status] - rank[b.status] || (a.dueAt ? Date.parse(a.dueAt) : Infinity) - (b.dueAt ? Date.parse(b.dueAt) : Infinity));
}

/** F2：长期目标、课程目标，以及按本地日期分组的本周任务。 */
export function GoalsPage({ quote }: { quote: (r: CardRef) => void }) {
  const [data, setData] = useState<{ goals: Goal[]; tasks: Task[] }>({ goals: [], tasks: [] });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [pending, setPending] = useState<string[]>([]);
  const pendingRef = useRef(new Set<string>());
  const requestRef = useRef(0);
  const [now, setNow] = useState(() => new Date());
  const load = useCallback(async () => {
    const request = ++requestRef.current;
    setError('');
    try {
      const result = await api.goals.list();
      if (request === requestRef.current) setData(result);
    } catch {
      if (request === requestRef.current) setError('目标暂时未能加载，请点击重试。');
    } finally {
      if (request === requestRef.current) setLoading(false);
    }
  }, []);
  useEffect(() => { void load(); return api.on('goals:changed', () => { void load(); }); }, [load]);
  useEffect(() => { const timer = setInterval(() => setNow(new Date()), 60_000); return () => clearInterval(timer); }, []);
  const toggle = async (task: Task) => {
    if (pendingRef.current.has(task.id) || task.status === 'skipped') return;
    pendingRef.current.add(task.id);
    setPending([...pendingRef.current]);
    setError('');
    try { await api.goals.setTaskStatus(task.id, task.status === 'done' ? 'todo' : 'done'); await load(); }
    catch { setError('未能更新任务状态，请稍后重试。'); }
    finally { pendingRef.current.delete(task.id); setPending([...pendingRef.current]); }
  };
  const weekStart = new Date(now);
  weekStart.setDate(now.getDate() - ((now.getDay() + 6) % 7));
  weekStart.setHours(0, 0, 0, 0);
  const weekEnd = new Date(weekStart); weekEnd.setDate(weekStart.getDate() + 7);
  const weekTasks = data.tasks.filter((t) => {
    const due = t.dueAt ? Date.parse(t.dueAt) : NaN;
    return due >= weekStart.getTime() && due < weekEnd.getTime();
  });
  const groups = new Map<string, Task[]>();
  for (const task of weekTasks) {
    const key = dateKey(new Date(task.dueAt!));
    groups.set(key, [...(groups.get(key) ?? []), task]);
  }
  const goalTitles = new Map(data.goals.map((g) => [g.id, g.title]));
  const unscheduled = data.tasks.filter((t) => !t.dueAt && data.goals.some((g) => g.id === t.goalId && g.level === 'week'));
  const listProps = { toggle, pending, now };
  return <div className="page goals-page">
    <header className="page-header"><h1>目标</h1><span className="muted">在对话里说「帮我规划……」，旦旦会创建目标并拆解成任务</span></header>
    {error && <div className="goal-error" role="alert"><span>{error}</span><button onClick={() => void load()}>重试加载</button></div>}
    {loading ? <div className="empty" role="status">正在加载目标和任务…</div> : LEVELS.map(({ level, title }) => <section key={level} className="goal-section">
      <h2>{title}</h2>
      {level === 'week' ? <>
        <p className="muted small">本周一至周日 · {weekTasks.length} 项有截止时间的任务，已完成 {weekTasks.filter((t) => t.status === 'done').length} 项</p>
        {[...groups.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([date, tasks]) => {
          const due = new Date(tasks[0].dueAt!);
          return <section className="week-day" key={date}>
            <h3>{date === dateKey(now) && <span className="tag today-tag">今天</span>}{due.getMonth() + 1}月{due.getDate()}日 · 周{'日一二三四五六'[due.getDay()]}<span className="muted small">{tasks.filter((t) => t.status === 'todo').length} 项待办</span></h3>
            <TaskList tasks={tasks} {...listProps} goalTitles={goalTitles} />
          </section>;
        })}
        {!weekTasks.length && <div className="empty small">本周没有有截止时间的任务。长期目标和课程中的本周任务会自动汇总到这里。</div>}
        {unscheduled.length > 0 && <section className="week-day"><h3>本周目标 · 待安排日期</h3><TaskList tasks={unscheduled} {...listProps} goalTitles={goalTitles} /></section>}
      </> : <>
        {data.goals.filter((g) => g.level === level).map((g) => {
          const tasks = data.tasks.filter((t) => t.goalId === g.id);
          const active = tasks.filter((t) => t.status !== 'skipped');
          const done = active.filter((t) => t.status === 'done').length;
          const progress = active.length ? Math.round(done / active.length * 100) : 0;
          return <article key={g.id} className="goal goal-detail">
            <div className="goal-head"><strong>{g.title}</strong><div className="goal-badges">{g.createdBy === 'assistant' && <span className="tag">助理创建</span>}{g.status !== 'active' && <span className="tag">{g.status === 'done' ? '目标已完成' : '已归档'}</span>}</div><button className="ghost" onClick={() => quote({ type: 'goal', id: g.id, title: g.title })}>引用到对话</button></div>
            {g.description && <p className="goal-description muted">{g.description}</p>}
            <div className="goal-progress-label"><span>{done}/{active.length} 项已完成{tasks.length > active.length ? ` · ${tasks.length - active.length} 项已跳过` : ''}</span><span>{g.dueAt ? `目标截止 ${fmtTime(g.dueAt)}` : '目标未设截止时间'}</span></div>
            <div className="progress" role="progressbar" aria-label={`${g.title}任务完成比例`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress}><div style={{ width: `${progress}%` }} /></div>
            <TaskList tasks={tasks} {...listProps} />
          </article>;
        })}
        {!data.goals.some((g) => g.level === level) && <div className="empty small">{level === 'long_term' ? '还没有长期目标。可以对旦旦说「我想申请明年春季交换」。' : '还没有课程目标，同步 eLearning 后会显示在这里。'}</div>}
      </>}
    </section>)}
  </div>;
}

function TaskList({ tasks, toggle, pending, now, goalTitles }: { tasks: Task[]; toggle: (t: Task) => Promise<void>; pending: string[]; now: Date; goalTitles?: Map<string, string> }) {
  if (!tasks.length) return <div className="muted small goal-no-tasks">暂无拆解任务，可在对话中请旦旦继续拆解。</div>;
  return <ul className="tasks goal-tasks">{sortedTasks(tasks).map((t) => {
    const overdue = t.status === 'todo' && !!t.dueAt && Date.parse(t.dueAt) < now.getTime();
    return <li key={t.id} className={`goal-task ${t.status}`}>
      <input type="checkbox" aria-label={`${t.status === 'done' ? '标记未完成' : '标记完成'}：${t.title}`} checked={t.status === 'done'} disabled={pending.includes(t.id) || t.status === 'skipped'} onChange={() => void toggle(t)} />
      <div className="goal-task-body"><span className="goal-task-title">{t.title}</span><div className="goal-task-meta"><span className={overdue ? 'goal-overdue' : ''}>{t.dueAt ? `${overdue ? '已逾期 · ' : '截止 '}${fmtTime(t.dueAt)}` : '未设截止时间'}</span>{t.goalId && goalTitles?.get(t.goalId) && <span>{goalTitles.get(t.goalId)}</span>}<span>{SOURCE[t.source]}</span>{t.status === 'done' && <span>已完成</span>}{t.status === 'skipped' && <span>已跳过</span>}{pending.includes(t.id) && <span role="status">保存中…</span>}</div></div>
    </li>;
  })}</ul>;
}
