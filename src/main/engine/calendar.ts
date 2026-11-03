import type { SemesterPhase } from '../../shared/types';

/**
 * 学期校历（PRD §5.6、学期节奏感知）。
 * ⚠️ 以下日期是示例，需按复旦教务处公布的 2026–2027 学年秋季校历修正（负责人：D）。
 */
export const SEMESTER = {
  name: '2026–2027 学年秋季学期',
  /** 第 1 周周一 */
  firstMonday: '2026-09-07',
  weeks: 18,
  /** 各周所处阶段 */
  phases: [
    { weeks: [1, 2], phase: 'course_selection' },
    { weeks: [8, 9], phase: 'midterm' },
    { weeks: [15, 16], phase: 'pre_exam' },
    { weeks: [17, 18], phase: 'exam' },
  ] as { weeks: number[]; phase: SemesterPhase }[],
  holidays: [{ from: '2026-10-01', to: '2026-10-07', note: '国庆假期' }],
};

const DAY = 86_400_000;

export function localDate(d: Date): string {
  const z = new Date(d.getTime() - d.getTimezoneOffset() * 60_000);
  return z.toISOString().slice(0, 10);
}

export function weekNo(date: string): number | undefined {
  const diff = Math.floor((Date.parse(date) - Date.parse(SEMESTER.firstMonday)) / DAY);
  const w = Math.floor(diff / 7) + 1;
  return w >= 1 && w <= SEMESTER.weeks ? w : undefined;
}

export function phaseFor(date: string): SemesterPhase {
  if (SEMESTER.holidays.some((h) => date >= h.from && date <= h.to)) return 'holiday';
  const w = weekNo(date);
  if (!w) return 'holiday';
  return SEMESTER.phases.find((p) => p.weeks.includes(w))?.phase ?? 'regular';
}

/** 生成整个学期的日历行，启动时写入 calendar 表 */
export function buildCalendar(): { date: string; weekNo?: number; phase: SemesterPhase; note?: string }[] {
  const out = [];
  const start = Date.parse(SEMESTER.firstMonday);
  for (let i = 0; i < SEMESTER.weeks * 7; i++) {
    const date = new Date(start + i * DAY).toISOString().slice(0, 10);
    out.push({ date, weekNo: weekNo(date), phase: phaseFor(date), note: SEMESTER.holidays.find((h) => date >= h.from && date <= h.to)?.note });
  }
  return out;
}

export const PHASE_LABEL: Record<SemesterPhase, string> = {
  regular: '平时', course_selection: '选课周', midterm: '期中', pre_exam: '考试周前', exam: '考试周', holiday: '假期',
};
