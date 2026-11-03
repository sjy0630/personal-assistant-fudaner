import { describe, expect, it } from 'vitest';
import { applyBudget, dailyBudget } from '../src/main/engine/budget';
import { gate, inQuietHours } from '../src/main/engine/gate';
import { phaseFor, weekNo } from '../src/main/engine/calendar';
import type { Settings, Trigger } from '../src/shared/types';

const settings: Settings = { demoMode: true, quietHours: { start: '23:30', end: '07:30' } };
const trig = (kind: Trigger['kind'], payload: Record<string, unknown> = {}): Trigger => ({
  id: '1', source: 'clock', kind, sourceRef: 'x', threadKey: 't', payload, occurredAt: '', disposition: 'pending',
});

describe('准入规则（Gate）', () => {
  it('静默时段跨零点', () => {
    expect(inQuietHours(new Date('2026-11-04T23:45:00'), settings.quietHours)).toBe(true);
    expect(inQuietHours(new Date('2026-11-04T06:00:00'), settings.quietHours)).toBe(true);
    expect(inQuietHours(new Date('2026-11-04T12:00:00'), settings.quietHours)).toBe(false);
  });

  it('作业已提交 → 不再提醒', () => {
    const r = gate(trig('deadline_24h'), { now: new Date('2026-11-04T12:00:00'), settings, alreadyReminded: false, mutedKinds: [],
      item: { id: 'i', source: 'demo', kind: 'assignment', sourceId: 's', title: 'Lab', body: '', publishedAt: '', done: true } });
    expect(r).toMatchObject({ pass: false, rule: 'already_submitted' });
  });

  it('同一提醒只发一次', () => {
    expect(gate(trig('deadline_24h'), { now: new Date('2026-11-04T12:00:00'), settings, alreadyReminded: true, mutedKinds: [] }).pass).toBe(false);
  });

  it('静默时段内非紧急事件 → 通过但并入早安', () => {
    expect(gate(trig('mail_new'), { now: new Date('2026-11-04T23:50:00'), settings, alreadyReminded: false, mutedKinds: [] })).toMatchObject({ pass: true, rule: 'quiet_hours' });
  });

  it('3 小时内截止的提醒不受静默时段限制', () => {
    expect(gate(trig('deadline_3h'), { now: new Date('2026-11-04T23:50:00'), settings, alreadyReminded: false, mutedKinds: [] })).toEqual({ pass: true });
  });
});

describe('注意力预算', () => {
  it('学期节奏影响预算：考试周前放宽，假期收紧', () => {
    expect(dailyBudget('medium', 'pre_exam')).toBeGreaterThan(dailyBudget('medium', 'regular'));
    expect(dailyBudget('medium', 'holiday')).toBeLessThan(dailyBudget('medium', 'regular'));
  });

  it('价值足够且预算充足 → 保持原决定', () => {
    expect(applyBudget('chat_notify', 0.95, 10, 'regular')).toMatchObject({ decision: 'chat_notify', downgraded: false });
  });

  it('预算不足 → 逐级降级', () => {
    const r = applyBudget('chat_notify', 0.95, 1, 'regular');
    expect(r.decision).toBe('card');
    expect(r.downgraded).toBe(true);
  });

  it('价值太低 → 不打扰', () => {
    expect(applyBudget('chat', 0.05, 10, 'regular').decision).toBe('digest');
  });
});

describe('校历', () => {
  it('周次与阶段', () => {
    expect(weekNo('2026-09-07')).toBe(1);
    expect(phaseFor('2026-10-02')).toBe('holiday');
    expect(phaseFor('2026-12-22')).toBe('pre_exam');
  });
});
