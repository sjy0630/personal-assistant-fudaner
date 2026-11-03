import { useEffect, useState } from 'react';
import type { EvalRecord } from '../../../shared/types';
import { api, fmtTime } from '../api';

/* 负责人：F2（副页面与视觉）。设置页（F1）只负责把它放进「主动决策」标签。 */

const DECISION: Record<EvalRecord['decision'], string> = { chat_notify: '🔔 对话 + 通知', chat: '💬 对话', card: '📰 动态', digest: '☀️ 并入早安', suggest_ticket: '🤝 建议工单', record: '📋 只记录' };

/** 主动决策记录（PRD §5.7 第 8 步）：「今天 N 个事件，只打扰了你 M 次」 */
export function DecisionsTab() {
  const [data, setData] = useState<{ evals: EvalRecord[]; budget: { budget: number; spent: number; phase: string } } | null>(null);
  useEffect(() => void api.decisions(200).then(setData), []);
  if (!data) return null;
  const todayStr = new Date().toDateString();
  const today = data.evals.filter((e) => new Date(e.createdAt).toDateString() === todayStr);
  const events = today.reduce((n, e) => n + e.triggerIds.length, 0);
  const interrupts = today.filter((e) => e.decision === 'chat_notify' || e.decision === 'chat').length;
  return (
    <>
      <section className="card-box stats">
        <div><strong>{events}</strong><span>今天的事件</span></div>
        <div><strong>{interrupts}</strong><span>打扰你的次数</span></div>
        <div><strong>{today.filter((e) => e.decision === 'card').length}</strong><span>放进动态</span></div>
        <div><strong>{data.budget.spent.toFixed(1)}/{data.budget.budget}</strong><span>注意力预算</span></div>
      </section>
      {data.evals.map((e) => (
        <div key={e.id} className="eval">
          <div className="row"><span>{DECISION[e.decision]}</span><span className="muted">{fmtTime(e.createdAt)} · {e.threadKey} · {e.modelUsed}{e.ruleMode === 'observe' ? ' · 观察模式' : ''}</span></div>
          <div>{e.reason}</div>
          {e.assessment && <div className="muted small">价值 {e.assessment.value.toFixed(2)} · 紧急 {e.assessment.urgency.toFixed(2)} · 成本 {e.attentionCost}{e.assessment.messageDraft ? ` · 「${e.assessment.messageDraft.slice(0, 50)}」` : ''}</div>}
          {e.gate.some((g) => !g.pass || g.rule) && <div className="muted small">准入：{e.gate.map((g) => g.note ?? (g.pass ? '通过' : g.rule)).join('；')}</div>}
        </div>
      ))}
    </>
  );
}

