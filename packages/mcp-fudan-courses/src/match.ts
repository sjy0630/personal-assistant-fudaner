/**
 * 课程总表的跨平台匹配规则（PRD §7.4）。纯函数，便于测试。
 *
 * 1. 课程代码 + 教学班完全一致 → auto
 * 2. 只有课程名 + 教师一致 → pending（需用户确认）
 * 3. 都不一致 → 不关联
 */

export interface CourseKey {
  code?: string;     // 如 COMP130004.01 或 COMP130004
  section?: string;  // 教学班，如 01
  name: string;
  teachers: string[];
}

export type MatchResult = 'auto' | 'pending' | 'none';

/** 拆分 "COMP130004.01" → { base: "COMP130004", section: "01" } */
export function parseCourseCode(code?: string): { base?: string; section?: string } {
  if (!code) return {};
  const m = code.trim().toUpperCase().match(/^([A-Z]{2,6}\d{5,6})(?:\.(\d{1,3}))?/);
  if (!m) return { base: code.trim().toUpperCase() };
  return { base: m[1], section: m[2] };
}

const norm = (s: string) => s.replace(/[\s（）()·\-—_]/g, '').toLowerCase();

export function matchCourse(a: CourseKey, b: CourseKey): MatchResult {
  const ca = parseCourseCode(a.code);
  const cb = parseCourseCode(b.code);
  const secA = a.section ?? ca.section;
  const secB = b.section ?? cb.section;
  if (ca.base && cb.base && ca.base === cb.base && secA && secB && secA === secB) return 'auto';

  const sameName = norm(a.name) === norm(b.name) || norm(a.name).includes(norm(b.name)) || norm(b.name).includes(norm(a.name));
  const sharedTeacher = a.teachers.some((t) => b.teachers.map(norm).includes(norm(t)));
  if (sameName && sharedTeacher) return 'pending';
  // 代码相同但教学班未知：也交给用户确认
  if (ca.base && cb.base && ca.base === cb.base && (!secA || !secB)) return 'pending';
  return 'none';
}

/** 在候选列表里找最佳匹配：auto 优先，其次 pending。 */
export function findBestMatch<T extends CourseKey>(target: CourseKey, candidates: T[]): { item: T; result: MatchResult } | null {
  let pending: T | null = null;
  for (const c of candidates) {
    const r = matchCourse(target, c);
    if (r === 'auto') return { item: c, result: 'auto' };
    if (r === 'pending' && !pending) pending = c;
  }
  return pending ? { item: pending, result: 'pending' } : null;
}

/** 判断邮件发件人是否为某门课的教师或助教（邮件 → 课程关联的规则部分） */
export function senderBelongsToCourse(senderEmail: string, staffEmails: string[]): boolean {
  const e = senderEmail.trim().toLowerCase();
  return staffEmails.some((s) => s.trim().toLowerCase() === e);
}
