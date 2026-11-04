import type { Decision, Profile, SemesterPhase } from '../../shared/types';

/** 每种写回方式的注意力成本（PRD §5.7） */
export const ATTENTION_COST: Record<Decision, number> = {
  chat_notify: 3,
  chat: 1.5,
  card: 0.5,
  suggest_ticket: 0.5,
  digest: 0.2,
  record: 0,
};

const BASE_BUDGET: Record<Profile['proactivity'], number> = { low: 6, medium: 10, high: 15 };

/** 学期节奏：平时偏少，DDL 密集期和考试周前放宽，假期收紧 */
const PHASE_FACTOR: Record<SemesterPhase, number> = {
  regular: 1, course_selection: 1.2, midterm: 1.3, pre_exam: 1.5, exam: 1.2, holiday: 0.4,
};

export function dailyBudget(proactivity: Profile['proactivity'], phase: SemesterPhase): number {
  return Math.round(BASE_BUDGET[proactivity] * PHASE_FACTOR[phase] * 10) / 10;
}

/** 研判价值的门槛：价值需要高于（成本 × 系数）才值得打扰 */
const VALUE_PER_COST = 0.22;

/** 降级链：通知 → 对话 → 动态 → 早安消息 → 只记录 */
const DOWNGRADE: Decision[] = ['chat_notify', 'chat', 'card', 'digest', 'record'];

/**
 * 根据研判建议、价值和剩余预算，给出最终决定。
 * 返回最终决定和是否发生了降级（降级理由会写入决策记录）。
 */
export function applyBudget(
  proposed: Decision,
  value: number,
  remaining: number,
  phase: SemesterPhase,
): { decision: Decision; downgraded: boolean; note?: string } {
  if (proposed === 'suggest_ticket') {
    return ATTENTION_COST.suggest_ticket <= remaining
      ? { decision: 'suggest_ticket', downgraded: false }
      : { decision: 'digest', downgraded: true, note: '预算不足，建议改为并入早安消息' };
  }
  const factor = phase === 'pre_exam' || phase === 'midterm' ? 0.85 : phase === 'holiday' ? 1.3 : 1;
  let idx = Math.max(0, DOWNGRADE.indexOf(proposed));
  let note: string | undefined;
  while (idx < DOWNGRADE.length - 1) {
    const d = DOWNGRADE[idx];
    const cost = ATTENTION_COST[d];
    const worth = value >= cost * VALUE_PER_COST * factor;
    // 并入早安消息不占用今天的注意力（攒到明天早上一起说），预算用完时它是最后一道兜底
    const affordable = d === 'digest' || cost <= remaining;
    if (worth && affordable) break;
    note = !affordable ? '今日注意力预算不足，已降级' : '价值不足以打扰，已降级';
    idx++;
  }
  const decision = DOWNGRADE[idx];
  return { decision, downgraded: decision !== proposed, note };
}
