import type { GateResult, Item, Settings, Task, Trigger } from '../../shared/types';

/** 准入需要的上下文：全部是确定性的数据，不调用模型 */
export interface GateContext {
  now: Date;
  settings: Settings;
  item?: Item;
  task?: Task;
  /** 该提醒是否已经发过（任务的 reminders_sent） */
  alreadyReminded: boolean;
  /** 用户关掉的事件类型 */
  mutedKinds: string[];
}

/** 是否处于静默时段（支持跨零点，如 23:30–07:30） */
export function inQuietHours(now: Date, q: { start: string; end: string }): boolean {
  const mins = now.getHours() * 60 + now.getMinutes();
  const toMin = (s: string) => { const [h, m] = s.split(':').map(Number); return h * 60 + m; };
  const s = toMin(q.start);
  const e = toMin(q.end);
  return s <= e ? mins >= s && mins < e : mins >= s || mins < e;
}

/**
 * 准入（PRD §5.7 第 2 步，参考 dsh-superagent 的 Gate）。
 * 返回 pass=false 的事件只记录，不进入研判；
 * pass=true 但 rule='quiet_hours' 的事件会被强制并入早安消息。
 */
export function gate(t: Trigger, ctx: GateContext): GateResult {
  if (ctx.mutedKinds.includes(t.kind)) return { pass: false, rule: 'muted', note: '用户关闭了这类提醒' };

  const isDeadline = t.kind.startsWith('deadline_');
  if (isDeadline && ctx.item?.done) return { pass: false, rule: 'already_submitted', note: '作业已提交，不再提醒' };
  if (isDeadline && ctx.task?.status === 'done') return { pass: false, rule: 'task_done', note: '任务已完成' };
  if (isDeadline && ctx.alreadyReminded) return { pass: false, rule: 'duplicate', note: '同一提醒已发过' };
  if (t.kind === 'assignment_changed' && !t.payload.dueChanged) return { pass: false, rule: 'trivial_change', note: '变更不影响截止时间' };

  const urgent = t.kind === 'deadline_3h' || t.kind === 'morning';
  if (!urgent && inQuietHours(ctx.now, ctx.settings.quietHours)) {
    return { pass: true, rule: 'quiet_hours', note: '静默时段，并入早安消息' };
  }
  return { pass: true };
}
