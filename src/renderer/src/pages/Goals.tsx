import { useEffect, useState } from 'react';
import type { CardRef, Goal, Task } from '../../../shared/types';
import { api, fmtTime } from '../api';

const LEVELS: { level: Goal['level']; title: string }[] = [
  { level: 'long_term', title: '🌟 长期目标' },
  { level: 'course', title: '📘 本学期课程' },
  { level: 'week', title: '📅 本周' },
];

/** 目标（PRD §5.3）：长期目标 / 本学期课程 / 本周三层 */
export function GoalsPage({ quote }: { quote: (r: CardRef) => void }) {
  const [data, setData] = useState<{ goals: Goal[]; tasks: Task[] }>({ goals: [], tasks: [] });
  const load = () => void api.goals.list().then(setData);
  useEffect(() => { load(); return api.on('goals:changed', load); }, []);

  const toggle = async (t: Task) => { await api.goals.setTaskStatus(t.id, t.status === 'done' ? 'todo' : 'done'); load(); };

  // 本周：所有目标下本周截止的任务
  const now = new Date();
  const weekStart = new Date(now); weekStart.setDate(now.getDate() - ((now.getDay() + 6) % 7)); weekStart.setHours(0, 0, 0, 0);
  const weekEnd = new Date(weekStart.getTime() + 7 * 86_400_000);
  const weekTasks = data.tasks.filter((t) => t.dueAt && t.dueAt >= weekStart.toISOString() && t.dueAt < weekEnd.toISOString());

  return (
    <div className="page">
      <header className="page-header"><h1>目标</h1><span className="muted">在对话里说「帮我规划……」，旦旦会创建目标并拆解成任务</span></header>
      {LEVELS.map(({ level, title }) => (
        <section key={level} className="goal-section">
          <h2>{title}</h2>
          {level === 'week' ? (
            <TaskList tasks={weekTasks} toggle={toggle} />
          ) : (
            data.goals.filter((g) => g.level === level).map((g) => {
              const tasks = data.tasks.filter((t) => t.goalId === g.id);
              const done = tasks.filter((t) => t.status === 'done').length;
              return (
                <div key={g.id} className="goal">
                  <div className="goal-head">
                    <strong>{g.title}</strong>
                    <span className="muted">{done}/{tasks.length}{g.dueAt ? ` · 截止 ${fmtTime(g.dueAt)}` : ''}</span>
                    <button className="ghost" onClick={() => quote({ type: 'goal', id: g.id, title: g.title })}>引用到对话</button>
                  </div>
                  <div className="progress"><div style={{ width: `${tasks.length ? (done / tasks.length) * 100 : 0}%` }} /></div>
                  <TaskList tasks={tasks.filter((t) => t.status !== 'done' || level === 'long_term')} toggle={toggle} />
                </div>
              );
            })
          )}
          {level === 'long_term' && data.goals.every((g) => g.level !== 'long_term') && <div className="empty small">还没有长期目标。可以对旦旦说「我想申请明年春季交换」。</div>}
        </section>
      ))}
    </div>
  );
}

function TaskList({ tasks, toggle }: { tasks: Task[]; toggle: (t: Task) => void }) {
  if (tasks.length === 0) return <div className="muted small">（没有待办）</div>;
  return (
    <ul className="tasks">
      {tasks.map((t) => (
        <li key={t.id} className={t.status === 'done' ? 'done' : ''}>
          <input type="checkbox" checked={t.status === 'done'} onChange={() => toggle(t)} />
          <span>{t.title}</span>
          {t.dueAt && <span className="muted">{fmtTime(t.dueAt)}</span>}
          {t.source === 'elearning' && <span className="tag">eLearning</span>}
        </li>
      ))}
    </ul>
  );
}
