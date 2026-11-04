import type { SemesterPhase } from '../../shared/types';
import type { Repo } from '../db/repo';
import { PHASE_LABEL, localDate, phaseFor } from './calendar';

/** 当前学期阶段：演示时可以用 phase_override 手动切换（设置 → 开发者） */
export function currentPhase(repo: Repo, date: string): SemesterPhase {
  return repo.getKv<SemesterPhase | null>('phase_override', null) ?? repo.calendarDay(date)?.phase ?? phaseFor(date);
}

const H = 3_600_000;
const THRESHOLDS = [
  { kind: 'deadline_3h', ms: 3 * H },
  { kind: 'deadline_24h', ms: 24 * H },
  { kind: 'deadline_72h', ms: 72 * H },
] as const;

/**
 * 时钟来源（参考 dsh-superagent：需要等待的条件本身就是一个 Source）。
 * 每次 tick 检查一遍，生成到点的事件；事件按 sourceRef 去重，重复调用是安全的。
 */
export function emitClockTriggers(repo: Repo, now: Date, opts: { morningAt?: string; morningUntil?: string } = {}): void {
  const date = localDate(now);
  const toMin = (s: string) => { const [h, m] = s.split(':').map(Number); return h * 60 + m; };
  const mins = now.getHours() * 60 + now.getMinutes();
  // 早安只在早上到中午之间发：下午或深夜第一次打开电脑时不说「早安」，当天重点看右侧「今天」栏
  if (mins >= toMin(opts.morningAt ?? '07:30') && mins < toMin(opts.morningUntil ?? '14:00')) {
    repo.addTrigger({ source: 'clock', kind: 'morning', sourceRef: date, threadKey: 'daily', payload: { date } });
  }

  if (now.getDay() === 1 && now.getHours() >= 8) {
    repo.addTrigger({ source: 'clock', kind: 'weekly_plan', sourceRef: date, threadKey: 'daily', payload: { date } });
  }

  // DDL：只生成当前最紧的那一档，避免刚启动时一次性冒出三条
  const horizon = new Date(now.getTime() + 72 * H).toISOString();
  for (const item of repo.listItems({ kind: 'assignment', done: false, dueAfter: now.toISOString(), dueBefore: horizon, limit: 200 })) {
    const left = Date.parse(item.dueAt!) - now.getTime();
    const th = THRESHOLDS.find((x) => left <= x.ms);
    if (!th) continue;
    const course = item.courseId ? repo.getCourse(item.courseId) : undefined;
    repo.addTrigger({
      source: 'clock', kind: th.kind, sourceRef: item.id, threadKey: `course:${course?.code ?? 'unknown'}`,
      payload: { itemId: item.id, title: item.title, course: course?.name, dueAt: item.dueAt },
    });
  }

  for (const f of repo.dueFollowups(now.toISOString())) {
    repo.addTrigger({ source: 'clock', kind: 'followup_due', sourceRef: f.id, threadKey: f.itemId ? `item:${f.itemId}` : `followup:${f.id}`, payload: { followupId: f.id, topic: f.topic, itemId: f.itemId } });
    repo.setFollowupStatus(f.id, 'done');
  }

  const phase = currentPhase(repo, date);
  const last = repo.getKv<string | null>('last_phase', null);
  if (last !== phase) {
    if (last !== null) {
      repo.addTrigger({ source: 'clock', kind: 'phase_change', sourceRef: `${date}:${phase}`, threadKey: 'semester', payload: { phase, label: PHASE_LABEL[phase] } });
    }
    repo.setKv('last_phase', phase);
  }
}
