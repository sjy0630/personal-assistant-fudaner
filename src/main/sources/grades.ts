import { load } from 'cheerio';
import type { CampusReader } from './timetable-sync';
import { parseSemesterPage, UNDERGRAD_TABLE_URL, TimetableFormatError } from './timetable';

/**
 * 成绩与绩点（本科教务系统，只读）。
 *
 * - 学生编号：课表接口 print-data 里的 studentTableVms[0].id（教务系统内部编号，不是学号）。
 * - 成绩：/student/for-std/grade/sheet/info/{编号}?semester={学期}，返回 semesterId2studentGrades。
 * - 绩点排名：先读 /grade/my-gpa/search-index/{编号} 页面里的年级和院系，再查 /grade/my-gpa/search。
 *   排名接口返回整个年级院系的列表（含其他同学的学号姓名）：这里只取出本人那一条和总人数，其余不保存、不交给模型。
 */
const JW = 'https://fdjwgl.fudan.edu.cn/student/for-std';

export interface CourseGrade {
  course: string;
  code?: string;
  credits?: number;
  /** 等级，如 A、B+、P */
  grade: string;
  /** 绩点；P/NP 课程没有 */
  gp?: number;
  type?: string;
  semester: string;
}

export interface GradeReport {
  semesters: { id: string; name: string; courses: CourseGrade[] }[];
  /** 按学分加权计算的绩点（不含 P/NP 等没有绩点的课程） */
  gpa?: number;
  credits: number;
  updatedAt: string;
}

export interface GpaRank { gpa?: number; credits?: number; ranking?: number; total: number; major?: string; department?: string; grade?: string }

const num = (v: unknown) => (typeof v === 'number' ? v : typeof v === 'string' && v.trim() && Number.isFinite(Number(v)) ? Number(v) : undefined);

export function parseGradeSheet(body: string, semesterNames: Map<string, string>): { id: string; name: string; courses: CourseGrade[] }[] {
  let data: { semesterId2studentGrades?: Record<string, unknown[]> };
  try { data = JSON.parse(body); } catch { throw new TimetableFormatError('教务系统返回的成绩格式和预期不同，学校页面可能更新了。'); }
  const map = data?.semesterId2studentGrades;
  if (!map || typeof map !== 'object') throw new TimetableFormatError('教务系统返回的成绩格式和预期不同，学校页面可能更新了。');
  return Object.entries(map).map(([id, rows]) => {
    const name = semesterNames.get(id) ?? `学期 ${id}`;
    const courses = (Array.isArray(rows) ? rows : []).flatMap((x) => {
      const r = x as Record<string, unknown>;
      const course = (typeof r.courseName === 'string' && r.courseName) || (typeof r.courseNameEn === 'string' && r.courseNameEn) || '';
      const grade = typeof r.gaGrade === 'string' ? r.gaGrade : r.gaGrade == null ? '' : String(r.gaGrade);
      if (!course) return [];
      return [{
        course, code: (typeof r.lessonCode === 'string' && r.lessonCode) || (typeof r.courseCode === 'string' && r.courseCode) || undefined,
        credits: num(r.credits) ?? num(r.credit), grade: grade || '未出', gp: num(r.gp),
        type: (typeof r.courseModuleTypeName === 'string' && r.courseModuleTypeName) || (typeof r.courseType === 'string' && r.courseType) || undefined,
        semester: name,
      } satisfies CourseGrade];
    });
    return { id, name, courses };
  });
}

/** 学分加权绩点：只算有绩点和学分的课程 */
export function weightedGpa(courses: CourseGrade[]): { gpa?: number; credits: number } {
  const counted = courses.filter((c) => c.gp !== undefined && c.credits && c.credits > 0);
  const credits = counted.reduce((n, c) => n + c.credits!, 0);
  if (!credits) return { credits: courses.reduce((n, c) => n + (c.credits ?? 0), 0) };
  return { gpa: Math.round((counted.reduce((n, c) => n + c.gp! * c.credits!, 0) / credits) * 100) / 100, credits: courses.reduce((n, c) => n + (c.credits ?? 0), 0) };
}

/** 本人在年级院系里的绩点排名。只返回本人一条和总人数 */
export function parseGpaRank(body: string, studentNumber: string | undefined): GpaRank | undefined {
  let data: { data?: unknown[] };
  try { data = JSON.parse(body); } catch { return undefined; }
  const rows = Array.isArray(data?.data) ? data.data as Record<string, unknown>[] : [];
  const me = studentNumber ? rows.find((r) => String(r.code ?? '') === studentNumber) : undefined;
  if (!me) return { total: rows.length };
  return {
    gpa: num(me.gpa), credits: num(me.credit), ranking: num(me.ranking), total: rows.length,
    major: typeof me.major === 'string' ? me.major : undefined, department: typeof me.department === 'string' ? me.department : undefined,
    grade: me.grade == null ? undefined : String(me.grade),
  };
}

/** 教务系统内部的学生编号（课表数据里带着） */
export async function readStudentId(reader: CampusReader): Promise<{ studentId: string; semesters: { id: string; name: string }[]; currentId?: string }> {
  const page = await reader.getText(UNDERGRAD_TABLE_URL);
  const { semesters, currentId } = parseSemesterPage(page.text);
  const id = currentId ?? semesters[0]?.id;
  const data = await reader.getText(`${UNDERGRAD_TABLE_URL}/semester/${id}/print-data`);
  let studentId: unknown;
  try { studentId = (JSON.parse(data.text) as { studentTableVms?: { id?: unknown }[] }).studentTableVms?.[0]?.id; } catch { /* 下面报错 */ }
  if (studentId === undefined || studentId === null) throw new TimetableFormatError('没有从教务系统读到学生信息。');
  return { studentId: String(studentId), semesters, currentId };
}

/** 读全部已出的成绩：先不带学期一次读全部；读不到再按学期逐个读（最近 12 个学期） */
export async function readGrades(reader: CampusReader): Promise<GradeReport & { studentId: string }> {
  const { studentId, semesters } = await readStudentId(reader);
  const names = new Map(semesters.map((s) => [s.id, s.name]));
  let result = parseGradeSheet((await reader.getText(`${JW}/grade/sheet/info/${studentId}?semester=`)).text, names).filter((s) => s.courses.length);
  if (!result.length) {
    result = [];
    for (const s of semesters.slice(0, 12)) {
      const one = parseGradeSheet((await reader.getText(`${JW}/grade/sheet/info/${studentId}?semester=${s.id}`)).text, names);
      result.push(...one.filter((x) => x.courses.length));
    }
  }
  result.sort((a, b) => Number(b.id) - Number(a.id));
  const all = result.flatMap((s) => s.courses);
  return { studentId, semesters: result, ...weightedGpa(all), updatedAt: new Date().toISOString() };
}

export async function readGpaRank(reader: CampusReader, studentId: string, studentNumber?: string): Promise<GpaRank | undefined> {
  const index = await reader.getText(`${JW}/grade/my-gpa/search-index/${studentId}`);
  const $ = load(index.text);
  const grade = $('input[name="grade"]').attr('value');
  const dept = $('input[name="departmentAssoc"]').attr('value');
  if (!grade || !dept) return undefined;
  const res = await reader.getText(`${JW}/grade/my-gpa/search?studentAssoc=${encodeURIComponent(studentId)}&grade=${encodeURIComponent(grade)}&departmentAssoc=${encodeURIComponent(dept)}&majorAssoc=`);
  return parseGpaRank(res.text, studentNumber);
}
