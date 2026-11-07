import { useEffect, useState } from 'react';
import type { Reminder, ReminderRepeat } from '../../../../shared/types';
import { api } from '../../api';
import { Feedback, useTask, type PanelProps } from './support';
import styles from './Settings.module.css';

const WD = ['', '一', '二', '三', '四', '五', '六', '日'];
function describe(r: ReminderRepeat): string {
  if (r.type === 'once') return new Date(r.at).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  if (r.type === 'daily') return `每天 ${r.time}`;
  const d = [...r.weekdays].sort().join();
  if (d === '1,2,3,4,5') return `工作日 ${r.time}`;
  return `每周${[...r.weekdays].sort().map((x) => WD[x]).join('、')} ${r.time}`;
}
const when = (iso?: string) => (iso ? new Date(iso).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', weekday: 'short', hour: '2-digit', minute: '2-digit' }) : '');

/** 设置 → 助理：定时提醒和定时任务 */
export function RemindersPanel({ onBusy }: Pick<PanelProps, 'onBusy'>) {
  const task = useTask(onBusy);
  const [list, setList] = useState<Reminder[]>([]);
  const [draft, setDraft] = useState({ title: '', kind: 'remind' as Reminder['kind'], prompt: '', repeat: 'daily' as 'once' | 'daily' | 'weekdays' | 'weekly', time: '22:00', date: '', weekdays: [1] as number[] });
  const load = async () => setList(await api.reminders.list());
  useEffect(() => { void load().catch(() => undefined); }, []);

  const repeatOf = (): ReminderRepeat => draft.repeat === 'once' ? { type: 'once', at: new Date(`${draft.date}T${draft.time}:00`).toISOString() }
    : draft.repeat === 'daily' ? { type: 'daily', time: draft.time }
    : { type: 'weekly', time: draft.time, weekdays: draft.repeat === 'weekdays' ? [1, 2, 3, 4, 5] : draft.weekdays };
  const valid = draft.title.trim() && /^\d{2}:\d{2}$/.test(draft.time) && (draft.repeat !== 'once' || draft.date) && (draft.repeat !== 'weekly' || draft.weekdays.length) && (draft.kind === 'remind' || draft.prompt.trim());

  return (
    <section className={styles.section}>
      <h2>定时提醒</h2>
      <p className={styles.hint}>
        到点弹通知提醒你，或让旦旦到点自动做一件事（例如每周一早上汇总通知和 DDL），结果发到对话里。也可以直接在对话里说「每天 22:00 提醒我背单词」。应用需要开着（关掉窗口后在托盘里运行也可以）；电脑睡眠错过超过 12 小时的会跳过。
      </p>
      {list.length > 0 && (
        <div className={styles.statusRows}>
          {list.map((r) => (
            <div className={styles.statusRow} key={r.id}>
              <div>
                <strong>{r.kind === 'task' ? '🤖 ' : '⏰ '}{r.title}</strong>
                <p className={styles.hint}>
                  {describe(r.repeat)}{r.enabled && r.nextAt ? ` · 下次 ${when(r.nextAt)}` : r.enabled ? '' : ' · 已暂停'}
                  {r.prompt ? ` · ${r.prompt.slice(0, 60)}` : ''}
                </p>
              </div>
              <div className={styles.actions}>
                <button type="button" onClick={() => void task.run('toggle', async () => { await api.reminders.setEnabled(r.id, !r.enabled); await load(); }, r.enabled ? '已暂停。' : '已恢复。')}>{r.enabled ? '暂停' : '恢复'}</button>
                <button type="button" onClick={() => void task.run('remove', async () => { await api.reminders.remove(r.id); await load(); }, '已删除。')}>删除</button>
              </div>
            </div>
          ))}
        </div>
      )}
      <div className={styles.grid}>
        <label>标题<input value={draft.title} placeholder="例如：背单词" onChange={(e) => setDraft({ ...draft, title: e.target.value })} /></label>
        <label>类型
          <select value={draft.kind} onChange={(e) => setDraft({ ...draft, kind: e.target.value as Reminder['kind'] })}>
            <option value="remind">提醒我</option>
            <option value="task">让旦旦去做（需要模型）</option>
          </select>
        </label>
        <label>重复
          <select value={draft.repeat} onChange={(e) => setDraft({ ...draft, repeat: e.target.value as typeof draft.repeat })}>
            <option value="once">只一次</option>
            <option value="daily">每天</option>
            <option value="weekdays">工作日</option>
            <option value="weekly">每周</option>
          </select>
        </label>
        <label>时间<input type="time" value={draft.time} onChange={(e) => setDraft({ ...draft, time: e.target.value })} /></label>
        {draft.repeat === 'once' && <label>日期<input type="date" value={draft.date} onChange={(e) => setDraft({ ...draft, date: e.target.value })} /></label>}
      </div>
      {draft.repeat === 'weekly' && (
        <div className={styles.checks}>
          {[1, 2, 3, 4, 5, 6, 7].map((d) => (
            <label key={d} className={styles.check}>
              <input type="checkbox" checked={draft.weekdays.includes(d)} onChange={() => setDraft({ ...draft, weekdays: draft.weekdays.includes(d) ? draft.weekdays.filter((x) => x !== d) : [...draft.weekdays, d] })} />
              周{WD[d]}
            </label>
          ))}
        </div>
      )}
      <label>
        {draft.kind === 'task' ? '要旦旦做的事' : '提醒的话（可选）'}
        <textarea rows={2} value={draft.prompt} placeholder={draft.kind === 'task' ? '例如：汇总上周新的学校通知、本周 DDL 和考试，给出本周安排建议' : '例如：该背单词啦，今天 50 个'} onChange={(e) => setDraft({ ...draft, prompt: e.target.value })} />
      </label>
      <div className={styles.actions}>
        <button type="button" className="primary" disabled={!valid || !!task.busy} onClick={() => void task.run('add', async () => {
          await api.reminders.add({ title: draft.title.trim(), kind: draft.kind, prompt: draft.prompt.trim() || undefined, repeat: repeatOf() });
          setDraft({ ...draft, title: '', prompt: '' });
          await load();
        }, '已添加。', '添加失败，请检查时间。')}>添加</button>
      </div>
      <Feedback notice={task.notice} error={task.error} clear={task.clear} />
    </section>
  );
}
