import { useEffect, useState } from 'react';
import { api } from '../../api';
import { Feedback, useTask, type PanelProps } from './support';
import styles from './Settings.module.css';

type Status = Awaited<ReturnType<typeof api.campus.status>>;
type Library = Awaited<ReturnType<typeof api.campus.library>>;

const when = (iso?: string) => (iso ? new Date(iso).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '');

/** 设置 → 复旦账号：课表与考试、校园卡与图书馆 */
export function CampusPanel({ onBusy, demo }: Pick<PanelProps, 'onBusy'> & { demo: boolean }) {
  const task = useTask(onBusy);
  const [status, setStatus] = useState<Status | null>(null);
  const [library, setLibrary] = useState<Library | null>(null);
  const [card, setCard] = useState<{ balance: number; at: string } | null>(null);
  const refresh = async () => setStatus(await api.campus.status());
  useEffect(() => { void refresh().catch(() => undefined); }, []);
  const problem = (key: string) => status?.problems?.[key];

  return (
    <>
      <section className={styles.section}>
        <h2>课表与考试</h2>
        <p className={styles.hint}>
          从教务系统读取本学期课表和考试安排（本科读教务系统，研究生读研究生选课系统，按「关于我」里的学历选择），之后每天自动更新。课表用来排计划、算空闲时间；考前 7 天和前一天会提醒。只读，不会改动选课。
        </p>
        <div className={styles.statusRows}>
          <div className={styles.statusRow}>
            <div>
              <strong>课表</strong>
              <p className={styles.hint}>{status?.timetable ? `${status.timetable.semester ?? '本学期'} · ${status.timetable.courses} 门课 · ${when(status.timetable.updatedAt)} 更新` : demo ? '演示模式使用内置课表。' : '还没有导入。'}{problem('timetable') ? ` 上次自动更新失败：${problem('timetable')}` : ''}</p>
            </div>
          </div>
          <div className={styles.statusRow}>
            <div>
              <strong>考试安排</strong>
              <p className={styles.hint}>{status?.exams ? `${status.exams.exams} 场 · ${when(status.exams.updatedAt)} 更新` : '还没有导入。'}{problem('exams') ? ` 上次自动更新失败：${problem('exams')}` : ''}</p>
            </div>
          </div>
        </div>
        <div className={styles.actions}>
          <button type="button" className="primary" onClick={() => void task.run('timetable', async () => {
            const r = await api.campus.importTimetable();
            await refresh();
            task.clear();
            if (!r.courses) throw new Error('请注意：教务系统里本学期还没有课表。');
          }, '课表已导入，右侧「今天」会显示当天的课。', '导入失败，请确认已登录复旦账号后重试。')}>
            {task.busy === 'timetable' ? '正在读取…' : '导入课表'}
          </button>
          <button type="button" onClick={() => void task.run('exams', async () => {
            const r = await api.campus.importExams();
            await refresh();
            if (!r.exams) throw new Error('请注意：教务系统里还没有考试安排，排考后会自动更新。');
          }, '考试安排已导入。', '导入失败，请确认已登录复旦账号后重试。')}>
            {task.busy === 'exams' ? '正在读取…' : '导入考试安排'}
          </button>
        </div>
      </section>

      <section className={styles.section}>
        <h2>校园卡与图书馆</h2>
        <p className={styles.hint}>图书馆人数来自图书馆公开接口；校园卡余额复用复旦账号登录状态读取，余额低于 30 元时提醒你充值。也可以直接问旦旦「哪个馆人少」「卡里还有多少钱」。</p>
        {library && (
          <div className={styles.statusRows}>
            {library.map((l) => (
              <div className={styles.statusRow} key={l.name}>
                <div><strong>{l.name}</strong><p className={styles.hint}>{l.openTime ? `开放 ${l.openTime}` : ''}</p></div>
                <span className={styles.badge}>在馆 {l.inside ?? '—'}{l.remaining != null ? ` · 还能进 ${l.remaining}` : ''}</span>
              </div>
            ))}
          </div>
        )}
        {card && <p className={styles.hint}>校园卡余额：<strong>¥{card.balance.toFixed(2)}</strong>（{when(card.at)}）</p>}
        {problem('card') && !card && <p className={styles.hint}>上次查询校园卡失败：{problem('card')}</p>}
        <div className={styles.actions}>
          <button type="button" onClick={() => void task.run('library', async () => { setLibrary(await api.campus.library()); }, '已更新图书馆人数。', '查询失败，请检查网络后重试。')}>
            {task.busy === 'library' ? '正在查询…' : '查看图书馆人数'}
          </button>
          <button type="button" onClick={() => void task.run('card', async () => { setCard(await api.campus.cardBalance()); }, '已查询校园卡余额。', '查询失败，请确认已登录复旦账号后重试。')}>
            {task.busy === 'card' ? '正在查询…' : '查询校园卡余额'}
          </button>
        </div>
        <Feedback notice={task.notice} error={task.error} clear={task.clear} />
      </section>
    </>
  );
}
