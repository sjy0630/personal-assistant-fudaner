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
  const [grades, setGrades] = useState<Awaited<ReturnType<typeof api.campus.grades>> | null>(null);
  const [power, setPower] = useState<Awaited<ReturnType<typeof api.campus.electricity>> | null>(null);
  const [hole, setHole] = useState<{ loggedIn: boolean; demo: boolean } | null>(null);
  const [holeForm, setHoleForm] = useState({ email: '', password: '' });
  const refresh = async () => setStatus(await api.campus.status());
  useEffect(() => { void refresh().catch(() => undefined); void api.treehole.status().then(setHole).catch(() => undefined); }, []);
  const problem = (key: string) => status?.problems?.[key];

  return (
    <>
      <section className={styles.section}>
        <h2>课表与考试</h2>
        <p className={styles.hint}>
          从教务系统读取本学期课表、考试安排和成绩（本科读教务系统，研究生课表读研究生选课系统，按「关于我」里的学历选择），之后每天自动更新。课表用来排计划、算空闲时间；考前 7 天和前一天会提醒；出新成绩时告诉你。成绩只存在本机，只有用本地模型或你在「设置 → 模型」允许发送敏感内容时，旦旦才会把成绩交给模型。只读，不会改动选课。
        </p>
        <div className={styles.statusRows}>
          <div className={styles.statusRow}>
            <div>
              <strong>课表</strong>
              <p className={styles.hint}>{status?.timetable ? `${status.timetable.semester ?? '本学期'} · ${status.timetable.courses} 门课 · ${when(status.timetable.updatedAt)} 更新` : demo ? '演示模式使用内置课表。' : '还没有导入。'}{problem('timetable') ? ` 上次自动更新失败：${problem('timetable')}` : ''}</p>
            </div>
          </div>
          {grades && (
            <div className={styles.statusRow}>
              <div>
                <strong>成绩与绩点</strong>
                <p className={styles.hint}>
                  {grades.gpa !== undefined ? `绩点 ${grades.gpa.toFixed(2)}（按学分加权，P/NP 不计）· ` : ''}{grades.credits} 学分 · {grades.courses} 门课
                  {grades.rank?.ranking ? ` · 本年级院系第 ${grades.rank.ranking} / ${grades.rank.total} 名` : grades.rank?.note ? ` · ${grades.rank.note}` : ''}
                </p>
              </div>
            </div>
          )}
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
          <button type="button" onClick={() => void task.run('grades', async () => { setGrades(await api.campus.grades()); }, '已读取成绩。', '读取失败，请确认已登录复旦账号后重试。')}>
            {task.busy === 'grades' ? '正在读取…' : '查看成绩与绩点'}
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
        <h2>树洞与旦克</h2>
        <p className={styles.hint}>
          登录后可以直接问旦旦「数据结构这门课口碑怎么样」「树洞里怎么说哪个食堂好吃」。校园网内直接连接，校外自动通过 WebVPN（用上面的复旦账号登录状态）。树洞密码只用来登录一次，换成令牌加密保存在本机，不保存密码；只读，不会发帖、回复或点赞。
        </p>
        {hole?.demo ? <p className={styles.hint}>演示模式使用虚构的树洞和课程评价。</p> : hole?.loggedIn ? (
          <div className={styles.actions}>
            <span className={styles.badge}>已登录树洞</span>
            <button type="button" onClick={() => void task.run('hole-out', async () => { await api.treehole.logout(); setHole(await api.treehole.status()); }, '已退出树洞账号，本机保存的令牌已删除。')}>退出</button>
          </div>
        ) : (
          <>
            <div className={styles.grid}>
              <label>树洞账号（邮箱）<input value={holeForm.email} placeholder="学号@m.fudan.edu.cn" autoComplete="off" onChange={(e) => setHoleForm({ ...holeForm, email: e.target.value })} /></label>
              <label>树洞密码<input type="password" value={holeForm.password} autoComplete="off" onChange={(e) => setHoleForm({ ...holeForm, password: e.target.value })} /></label>
            </div>
            <div className={styles.actions}>
              <button type="button" className="primary" disabled={!holeForm.email.trim() || !holeForm.password} onClick={() => void task.run('hole-in', async () => {
                await api.treehole.login(holeForm.email, holeForm.password);
                setHoleForm({ email: '', password: '' });
                setHole(await api.treehole.status());
              }, '树洞登录成功。', '登录失败，请检查账号密码；校外需要先登录上面的复旦账号。')}>{task.busy === 'hole-in' ? '正在登录…' : '登录树洞'}</button>
            </div>
            <p className={styles.hint}>还没有树洞账号的话，先在旦挞 App 里注册。</p>
          </>
        )}
      </section>

      <section className={styles.section}>
        <h2>校园卡、宿舍电量与图书馆</h2>
        <p className={styles.hint}>图书馆人数和文献检索用图书馆公开接口，不需要登录；校园卡余额和宿舍电量复用复旦账号登录状态读取，余额低于 30 元、电量低于 10 度时提醒你。也可以直接问旦旦「哪个馆人少」「卡里还有多少钱」「宿舍还剩多少电」「帮我在图书馆找图神经网络的文献」。</p>
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
        {power && <p className={styles.hint}>宿舍电量：<strong>{power.remainingKwh} 度</strong>{power.room ? `（${power.room}）` : ''}{power.updatedAt ? ` · 系统更新于 ${power.updatedAt}` : ''}</p>}
        {problem('card') && !card && <p className={styles.hint}>上次查询校园卡失败：{problem('card')}</p>}
        <div className={styles.actions}>
          <button type="button" onClick={() => void task.run('library', async () => { setLibrary(await api.campus.library()); }, '已更新图书馆人数。', '查询失败，请检查网络后重试。')}>
            {task.busy === 'library' ? '正在查询…' : '查看图书馆人数'}
          </button>
          <button type="button" onClick={() => void task.run('card', async () => { setCard(await api.campus.cardBalance()); }, '已查询校园卡余额。', '查询失败，请确认已登录复旦账号后重试。')}>
            {task.busy === 'card' ? '正在查询…' : '查询校园卡余额'}
          </button>
          <button type="button" onClick={() => void task.run('power', async () => { setPower(await api.campus.electricity()); }, '已查询宿舍电量。', '查询失败，请确认已登录复旦账号后重试。')}>
            {task.busy === 'power' ? '正在查询…' : '查询宿舍电量'}
          </button>
        </div>
        <Feedback notice={task.notice} error={task.error} clear={task.clear} />
      </section>
    </>
  );
}
