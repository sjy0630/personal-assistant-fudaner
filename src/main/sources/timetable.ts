import { load } from 'cheerio';
import type { CourseSlot } from '../../shared/types';
import { shanghai } from '../activities/article';

/**
 * 真实课表和考试安排（教务系统，只读）。
 *
 * - 本科：fdjwgl.fudan.edu.cn「我的课表」页里有学期列表，课表数据在 /semester/{id}/print-data（JSON）。
 * - 研究生：yjsxk.fudan.edu.cn 选课系统的课表接口（JSON，周次是 0/1 字符串）。
 * - 考试：fdjwgl.fudan.edu.cn「考试安排」页的表格。
 * 都复用统一身份认证的登录会话。
 */
export const UNDERGRAD_TABLE_URL = 'https://fdjwgl.fudan.edu.cn/student/for-std/course-table';
export const POSTGRAD_TABLE_URL = 'https://yjsxk.fudan.edu.cn/yjsxkapp/sys/xsxkappfudan/xsxkCourse/loadKbxx.do';
export const EXAM_URL = 'https://fdjwgl.fudan.edu.cn/student/for-std/exam-arrange';

/** 复旦作息：第 1–15 节的开始时间，每节 45 分钟 */
export const PERIOD_STARTS = ['08:00', '08:55', '09:55', '10:50', '11:45', '13:30', '14:25', '15:25', '16:20', '17:15', '18:30', '19:25', '20:20', '21:15', '22:10'];

export function periodTime(start: number, end: number): { start: string; end: string } {
  const s = PERIOD_STARTS[Math.max(1, Math.min(15, start)) - 1];
  const e = PERIOD_STARTS[Math.max(1, Math.min(15, end)) - 1];
  const [h, m] = e.split(':').map(Number);
  const endMin = h * 60 + m + 45;
  return { start: s, end: `${String(Math.floor(endMin / 60)).padStart(2, '0')}:${String(endMin % 60).padStart(2, '0')}` };
}

export interface TimetableEntry {
  course: string;
  teachers: string[];
  location?: string;
  /** 1 = 周一 … 7 = 周日 */
  weekday: number;
  startPeriod: number;
  endPeriod: number;
  /** 上课的教学周（1 起） */
  weeks: number[];
}

export interface Semester { id: string; name: string; startDate?: string }

export class TimetableFormatError extends Error {
  constructor(message = '教务系统返回的课表格式和预期不同，学校页面可能更新了。') { super(message); this.name = 'TimetableFormatError'; }
}

/** 「我的课表」页：学期列表和当前选中的学期 */
export function parseSemesterPage(html: string): { semesters: Semester[]; currentId?: string } {
  const literal = html.match(/semesters\s*=\s*JSON\.parse\(\s*(['"])((?:\\.|(?!\1).)*)\1\s*\)/s);
  if (!literal) throw new TimetableFormatError();
  // 页面里是 JS 字符串字面量，先还原成 JSON 文本
  const jsonText = literal[2]
    .replace(/\\x([0-9a-f]{2})/gi, (_m, h: string) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\\u([0-9a-f]{4})/gi, (_m, h: string) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\\(["'\\/])/g, '$1');
  let rows: unknown;
  try { rows = JSON.parse(jsonText); } catch { throw new TimetableFormatError(); }
  if (!Array.isArray(rows) || !rows.length) throw new TimetableFormatError();
  const semesters = rows.flatMap((r: { id?: unknown; name?: unknown; startDate?: unknown }) =>
    r && /^\d+$/.test(String(r.id)) && typeof r.name === 'string'
      ? [{ id: String(r.id), name: r.name, startDate: typeof r.startDate === 'string' ? r.startDate.slice(0, 10) : undefined }]
      : []);
  const $ = load(html);
  const currentId = $('#allSemesters option[selected]').attr('value') ?? $('#allSemesters option').first().attr('value') ?? semesters[0]?.id;
  return { semesters, currentId };
}

const int = (v: unknown) => (typeof v === 'number' || (typeof v === 'string' && v.trim() !== '') ? Number(v) : NaN);

/** 本科 print-data：studentTableVms[0].activities */
export function parseUndergradTable(body: string): TimetableEntry[] {
  let data: { studentTableVms?: { activities?: unknown[] }[] };
  try { data = JSON.parse(body); } catch { throw new TimetableFormatError(); }
  const activities = data?.studentTableVms?.[0]?.activities;
  if (!Array.isArray(activities)) throw new TimetableFormatError();
  return activities.flatMap((a) => {
    const r = a as Record<string, unknown>;
    const weekday = int(r.weekday);
    const startPeriod = int(r.startUnit);
    const endPeriod = int(r.endUnit);
    if (typeof r.courseName !== 'string' || !(weekday >= 1 && weekday <= 7) || !(startPeriod >= 1 && endPeriod >= startPeriod && endPeriod <= 15)) return [];
    const weeks = Array.isArray(r.weekIndexes) ? [...new Set(r.weekIndexes.map(int).filter((w) => w >= 1 && w <= 30))].sort((x, y) => x - y) : [];
    return [{
      course: r.courseName.trim(), weekday, startPeriod, endPeriod, weeks,
      teachers: Array.isArray(r.teachers) ? r.teachers.filter((t): t is string => typeof t === 'string') : [],
      location: typeof r.room === 'string' && r.room.trim() ? r.room.trim() : undefined,
    }];
  });
}

/** 研究生课表：results[]，KCMC 课程名、XQ 星期、KSJCDM/JSJCDM 起止节次、ZCBH 周次位串、JASMC 教室、JSXM 教师 */
export function parsePostgradTable(body: string): TimetableEntry[] {
  let data: { results?: unknown[] };
  try { data = JSON.parse(body); } catch { throw new TimetableFormatError(); }
  if (!Array.isArray(data?.results)) throw new TimetableFormatError();
  const rows = data.results.flatMap((x) => {
    const r = x as Record<string, unknown>;
    const weekday = int(r.XQ);
    const startPeriod = int(r.KSJCDM);
    const endPeriod = r.JSJCDM == null ? startPeriod : int(r.JSJCDM);
    if (typeof r.KCMC !== 'string' || !(weekday >= 1 && weekday <= 7) || !(startPeriod >= 1 && endPeriod >= startPeriod && endPeriod <= 15)) return [];
    const bits = typeof r.ZCBH === 'string' ? r.ZCBH : '';
    return [{
      course: r.KCMC.trim(), weekday, startPeriod, endPeriod,
      weeks: [...bits].flatMap((b, i) => (b === '1' ? [i + 1] : [])),
      teachers: typeof r.JSXM === 'string' && r.JSXM.trim() ? [r.JSXM.trim()] : [],
      location: typeof r.JASMC === 'string' && r.JASMC.trim() ? r.JASMC.trim() : undefined,
    }];
  });
  // 研究生接口按单节返回，相邻的节次合并成一段
  const merged: TimetableEntry[] = [];
  for (const e of rows.sort((a, b) => a.weekday - b.weekday || a.startPeriod - b.startPeriod)) {
    const prev = merged.find((m) => m.course === e.course && m.weekday === e.weekday && m.location === e.location
      && m.endPeriod + 1 === e.startPeriod && m.weeks.join() === e.weeks.join());
    if (prev) prev.endPeriod = e.endPeriod;
    else merged.push({ ...e });
  }
  return merged;
}

/** 课表条目 → 每门课的上课时段 */
export function toCourseSlots(entries: TimetableEntry[]): Map<string, CourseSlot[]> {
  const out = new Map<string, CourseSlot[]>();
  for (const e of entries) {
    const t = periodTime(e.startPeriod, e.endPeriod);
    const slots = out.get(e.course) ?? [];
    slots.push({ weekday: e.weekday, start: t.start, end: t.end, location: e.location, weeks: e.weeks.length ? e.weeks : undefined });
    out.set(e.course, slots);
  }
  return out;
}

export interface Exam {
  course: string;
  /** ISO（UTC） */
  startsAt: string;
  endsAt?: string;
  location?: string;
  /** 原文，例如「2027-01-05 08:30~10:30」 */
  timeText: string;
}

const EXAM_DATE = /(20\d{2})\s*[-/.年]\s*(\d{1,2})\s*[-/.月]\s*(\d{1,2})/;

/** 「考试安排」页：每行一场考试，课程名、日期、起止时间、考场 */
export function parseExamPage(html: string): Exam[] {
  const $ = load(html);
  const exams = new Map<string, Exam>();
  $('tr').each((_i, tr) => {
    const cells = $(tr).find('td').map((_j, td) => $(td).text().replace(/\s+/g, ' ').trim()).get().filter(Boolean);
    if (cells.length < 2) return;
    const joined = cells.join(' ');
    const date = EXAM_DATE.exec(joined);
    const times = [...joined.matchAll(/(?<!\d)([01]?\d|2[0-3])[:：]([0-5]\d)(?!\d)/g)];
    if (!date || !times.length) return;
    const [y, mo, d] = [+date[1], +date[2], +date[3]];
    const at = (m: RegExpMatchArray) => shanghai(y, mo, d, +m[1], +m[2]);
    const course = cells.find((c) => !/^\d+$/.test(c) && !EXAM_DATE.test(c) && !/\d{1,2}[:：]\d{2}/.test(c)
      && !/考场|地点|教室|座位|校区|楼|室|闭卷|开卷|笔试|已安排|未安排|期末|期中/.test(c) && c.length >= 2) ?? cells[0];
    const location = cells.find((c) => /考场|教室|校区|楼|室|HGX|H\d/.test(c) && !EXAM_DATE.test(c));
    const exam: Exam = { course, startsAt: at(times[0]), endsAt: times[1] ? at(times[1]) : undefined, location, timeText: `${date[0]} ${times.map((t) => t[0]).join('~')}` };
    exams.set(`${course}|${exam.startsAt}`, exam);
  });
  return [...exams.values()].sort((a, b) => a.startsAt.localeCompare(b.startsAt));
}
