import { useCallback, useEffect, useState } from 'react';
import type { EvalRecord } from '../../../shared/types';
import { api, fmtTime } from '../api';

const ROUTES: Record<EvalRecord['decision'], { icon: string; label: string }> = {
  chat_notify: { icon: '🔔', label: '对话 + 通知' }, chat: { icon: '💬', label: '放进对话' },
  card: { icon: '📰', label: '放进动态' }, digest: { icon: '☀️', label: '并入早安' },
  suggest_ticket: { icon: '🤝', label: '建议工单' }, record: { icon: '📋', label: '只记录' },
};
const PHASE: Record<string, string> = { regular: '平时', course_selection: '选课期', midterm: '期中', pre_exam: '考试周前', exam: '考试周', holiday: '假期' };
type DecisionData = Awaited<ReturnType<typeof api.decisions>>;

/** F2：主动决策的去向、理由与注意力成本。 */
export function DecisionsTab() {
  const [data, setData] = useState<DecisionData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [period, setPeriod] = useState<'today' | 'recent'>('today');
  const [route, setRoute] = useState<EvalRecord['decision'] | ''>('');
  const load = useCallback(async () => {
    setLoading(true); setError('');
    try { setData(await api.decisions(200)); }
    catch { setError('暂时无法读取决策记录，请重试。'); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { void load(); }, [load]);
  const today = (data?.evals ?? []).filter((e) => new Date(e.createdAt).toDateString() === new Date().toDateString());
  const events = new Set(today.flatMap((e) => e.triggerIds)).size;
  const interrupts = today.filter((e) => e.decision === 'chat_notify' || e.decision === 'chat').length;
  const spent = data?.budget.spent ?? 0;
  const budget = data?.budget.budget ?? 0;
  const used = budget > 0 ? Math.min(100, Math.max(0, spent / budget * 100)) : 0;
  const records = (period === 'today' ? today : data?.evals ?? []).filter((e) => !route || e.decision === route).slice().sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  return <div className="decisions">
    <div className="decision-heading"><div><h2>把注意力留给重要的事</h2><p className="muted">每一次提醒都有理由，每一次安静也有依据。</p></div><button disabled={loading} onClick={() => void load()}>{loading ? '读取中…' : '刷新记录'}</button></div>
    {error && <p className="feedback-error" role="alert">{error}</p>}
    {loading && !data && <div className="empty" role="status">正在读取主动决策…</div>}
    {data && <>
      <section className="decision-summary" aria-label="今日主动决策统计">
        <span className="decision-eyebrow">今日概览</span><h3>收到 {events} 个事件，主动提醒 {interrupts} 次</h3>
        <p className="muted">{today.length - interrupts} 条决策通过动态、早安、工单建议或记录处理。</p>
        <div className="decision-metrics">
          <div><strong>{events}</strong><span>事件数</span></div><div><strong>{interrupts}</strong><span>打扰次数</span></div>
          <div><strong>{today.filter((e) => e.decision === 'card').length}</strong><span>放进动态</span></div><div><strong>{today.filter((e) => e.ruleMode === 'observe').length}</strong><span>观察模式</span></div>
        </div>
        <div className="decision-budget"><div className="decision-heading"><span>注意力预算 · {PHASE[data.budget.phase] ?? data.budget.phase}</span><strong>{spent.toFixed(1)} / {budget.toFixed(1)} 点</strong></div>
          <div className="progress" role="progressbar" aria-label="今日注意力预算使用比例" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(used)}><div style={{ width: `${used}%` }} /></div>
          <span className="muted small">剩余 {Math.max(0, budget - spent).toFixed(1)} 点 · 预算随学期阶段调整</span>
        </div>
      </section>
      <section className="decision-routes" aria-label="今日决策去向">{Object.entries(ROUTES).map(([key, info]) => <div className="decision-route" key={key}><span aria-hidden="true">{info.icon}</span><span>{info.label}</span><strong>{today.filter((e) => e.decision === key).length}</strong></div>)}</section>
      <div className="decision-toolbar"><div className="filters">{(['today', 'recent'] as const).map((p) => <button key={p} className={`chip ${period === p ? 'active' : ''}`} aria-pressed={period === p} onClick={() => setPeriod(p)}>{p === 'today' ? '今天' : '最近记录'}</button>)}</div><label>决策去向 <select value={route} onChange={(e) => setRoute(e.target.value as typeof route)}><option value="">全部</option>{Object.entries(ROUTES).map(([key, info]) => <option key={key} value={key}>{info.label}</option>)}</select></label></div>
      <p className="muted small">展示 {records.length} 条决策 · 统计基于最近 200 条记录；事件可能合并研判，事件数与决策数不一定相同。</p>
      {!records.length && <div className="empty">暂无符合条件的决策。可切换筛选，或触发演示事件后刷新记录。</div>}
      {records.map((e) => <DecisionEntry key={e.id} record={e} />)}
    </>}
  </div>;
}

function DecisionEntry({ record: e }: { record: EvalRecord }) {
  const info = ROUTES[e.decision];
  const adjusted = e.assessment && e.assessment.action !== e.decision;
  return <article className={`decision-entry route-${e.decision}`}>
    <div className="decision-icon" aria-hidden="true">{info.icon}</div>
    <div className="decision-content">
      <div className="decision-entry-head"><strong>{info.label}</strong><span className="muted small">{fmtTime(e.createdAt)}</span></div>
      {e.ruleMode === 'observe' && <span className="tag">观察模式</span>}{adjusted && <span className="tag">处理方式已调整</span>}
      <p className="decision-reason">{e.reason || '暂无判断理由'}</p>
      <div className="decision-facts"><span>注意力成本 <strong>{e.attentionCost.toFixed(1)} 点</strong></span><span>关联事件 {e.triggerIds.length} 个</span>{e.assessment && <><span>价值 {Math.round(e.assessment.value * 100)}%</span><span>紧急度 {Math.round(e.assessment.urgency * 100)}%</span></>}</div>
      <details className="decision-details"><summary>查看判断详情</summary>
        <dl><dt>关联线程</dt><dd>{e.threadKey}</dd><dt>研判方式</dt><dd>{e.modelUsed || '未记录'}</dd>{adjusted && <><dt>原始建议</dt><dd>{ROUTES[e.assessment!.action].label}</dd></>}</dl>
        {e.gate.length > 0 && <><h3>准入检查</h3><ul>{e.gate.map((g, i) => <li key={i}>{g.pass ? '✓' : '−'} {g.note || g.rule || (g.pass ? '通过' : '未通过')}</li>)}</ul></>}
        {e.assessment?.messageDraft && <><h3>消息草稿</h3><p className="decision-draft">{e.assessment.messageDraft}</p></>}
      </details>
    </div>
  </article>;
}
