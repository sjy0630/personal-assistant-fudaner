import type { SemesterPhase } from '../../shared/types';

/**
 * 学期校历（PRD §5.6、学期节奏感知）。
 *
 * 依据：《复旦大学 2026—2027 学年校历》。校历的规则：
 * - 每周从**周日**开始，第 0 周是报到 / 入学教育 / 补考注册周，第 1 周起上课；
 * - 每学期共 18 个教学周（含考试），第 16 周安排通识教育课程考试，第 17、18 周为停课考试周。
 *
 * 校历没有写明、按惯例取值的（标了「按惯例」或 tentative）：
 * - 期中：校历未规定期中周，按惯例取第 8–9 周，各课以课程安排为准；
 * - 节假日：校历写明「以学校办通知为准」，这里先按公历节日日期录入，学校办通知后再修正。
 */
export interface Semester {
  name: string;
  /** 第 0 周的周日 */
  week0Sunday: string;
  /** 学期最后一天（第 18 周周六） */
  end: string;
  /** 第一天上课 */
  classStart: string;
  phases: { weeks: number[]; phase: SemesterPhase; note?: string }[];
  holidays: { from: string; to: string; note: string; tentative?: boolean }[];
}

export const SEMESTERS: Semester[] = [
  {
    name: '2026–2027 学年第一学期',
    week0Sunday: '2026-08-30',
    end: '2027-01-09',
    classStart: '2026-09-07',
    phases: [
      { weeks: [0], phase: 'course_selection', note: '报到、入学教育、补考与注册' },
      { weeks: [1, 2], phase: 'course_selection', note: '开学初（按惯例为选课调整期）' },
      { weeks: [8, 9], phase: 'midterm', note: '期中（按惯例）' },
      { weeks: [15], phase: 'pre_exam' },
      { weeks: [16], phase: 'pre_exam', note: '通识教育课程考试' },
      { weeks: [17, 18], phase: 'exam', note: '停课考试周' },
    ],
    holidays: [
      { from: '2026-09-25', to: '2026-09-25', note: '中秋节（以学校办通知为准）', tentative: true },
      { from: '2026-10-01', to: '2026-10-07', note: '国庆节（以学校办通知为准）', tentative: true },
      { from: '2027-01-01', to: '2027-01-01', note: '元旦（以学校办通知为准）', tentative: true },
    ],
  },
  {
    name: '2026–2027 学年第二学期',
    week0Sunday: '2027-02-14',
    end: '2027-06-26',
    classStart: '2027-02-22',
    phases: [
      { weeks: [0], phase: 'course_selection', note: '补考与注册' },
      { weeks: [1, 2], phase: 'course_selection', note: '开学初（按惯例为选课调整期）' },
      { weeks: [8, 9], phase: 'midterm', note: '期中（按惯例）' },
      { weeks: [15], phase: 'pre_exam' },
      { weeks: [16], phase: 'pre_exam', note: '通识教育课程考试' },
      { weeks: [17, 18], phase: 'exam', note: '停课考试周' },
    ],
    holidays: [
      { from: '2027-04-05', to: '2027-04-05', note: '清明节（以学校办通知为准）', tentative: true },
      { from: '2027-05-01', to: '2027-05-05', note: '劳动节（以学校办通知为准）', tentative: true },
      { from: '2027-05-14', to: '2027-05-14', note: '第 65 届校田径运动会，停课一天' },
      { from: '2027-06-09', to: '2027-06-09', note: '端午节（以学校办通知为准）', tentative: true },
    ],
  },
];

const DAY = 86_400_000;

export function localDate(d: Date): string {
  const z = new Date(d.getTime() - d.getTimezoneOffset() * 60_000);
  return z.toISOString().slice(0, 10);
}

/** 日期所在的学期（不在任何学期内 = 寒暑假） */
export function semesterOf(date: string): Semester | undefined {
  return SEMESTERS.find((s) => date >= s.week0Sunday && date <= s.end);
}

/** 校历周次（0–18，周日为一周的第一天）；寒暑假返回 undefined */
export function weekNo(date: string): number | undefined {
  const s = semesterOf(date);
  if (!s) return undefined;
  return Math.floor((Date.parse(date) - Date.parse(s.week0Sunday)) / DAY / 7);
}

function holidayOf(date: string): Semester['holidays'][number] | undefined {
  return semesterOf(date)?.holidays.find((h) => date >= h.from && date <= h.to);
}

export function phaseFor(date: string): SemesterPhase {
  const s = semesterOf(date);
  if (!s || holidayOf(date)) return 'holiday';
  const w = weekNo(date)!;
  return s.phases.find((p) => p.weeks.includes(w))?.phase ?? 'regular';
}

/** 生成两个学期的全部日历行，启动时写入 calendar 表（寒暑假不写入，查不到即视为假期） */
export function buildCalendar(): { date: string; weekNo?: number; phase: SemesterPhase; note?: string }[] {
  const out = [];
  for (const s of SEMESTERS) {
    for (let t = Date.parse(s.week0Sunday); t <= Date.parse(s.end); t += DAY) {
      const date = new Date(t).toISOString().slice(0, 10);
      const w = weekNo(date)!;
      const note = holidayOf(date)?.note ?? s.phases.find((p) => p.weeks.includes(w))?.note;
      out.push({ date, weekNo: w, phase: phaseFor(date), note });
    }
  }
  return out;
}

export const PHASE_LABEL: Record<SemesterPhase, string> = {
  regular: '平时', course_selection: '开学初', midterm: '期中', pre_exam: '考试周前', exam: '考试周', holiday: '假期',
};
