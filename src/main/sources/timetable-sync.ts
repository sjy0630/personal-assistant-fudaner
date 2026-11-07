import { createHash } from 'node:crypto';
import { NeedLoginError } from '@fudaner/fudan-auth';
import type { Repo } from '../db/repo';
import { phaseFor, localDate } from '../engine/calendar';
import {
  EXAM_URL, POSTGRAD_TABLE_URL, UNDERGRAD_TABLE_URL, parseExamPage, parsePostgradTable, parseSemesterPage, parseUndergradTable,
  toCourseSlots, TimetableFormatError, type TimetableEntry,
} from './timetable';

/** 用登录会话读教务系统；被带到登录页时抛出 NeedLoginError */
export interface CampusReader {
  getText(url: string): Promise<{ url: string; status: number; text: string }>;
  /** 页面靠脚本加载内容时，在隐藏窗口里渲染后再读（测试里可以不提供） */
  render?(url: string, ready: (html: string, url: string) => boolean): Promise<string>;
}

export interface TimetableResult { kind: 'undergraduate' | 'postgraduate'; semester?: string; courses: number; entries: number }

/**
 * 「我的课表」页。刚登录时第一次访问可能停在单点登录的跳转页，读不到学期列表就再读一次；
 * 被带到登录页时按「需要重新登录」处理，而不是「格式变了」。
 */
async function readSemesterPage(reader: CampusReader): Promise<ReturnType<typeof parseSemesterPage>> {
  for (let attempt = 0; ; attempt++) {
    const page = await reader.getText(UNDERGRAD_TABLE_URL);
    if (page.status >= 400) throw new Error(`教务系统返回 ${page.status}`);
    try {
      return parseSemesterPage(page.text);
    } catch (error) {
      if (/id\.fudan\.edu\.cn|uis\.fudan\.edu\.cn|authserver|统一身份认证/.test(page.url + page.text.slice(0, 3000))) throw new NeedLoginError('jwfw');
      if (attempt >= 1) throw error;
    }
  }
}

/** 导入课表：写入每门课的上课时间；在 eLearning 上找得到同名课程时写到那门课上 */
export async function importTimetable(repo: Repo, reader: CampusReader): Promise<TimetableResult> {
  const degree = repo.getProfile().degree;
  const kind = degree === '硕士' || degree === '博士' ? 'postgraduate' : 'undergraduate';
  let entries: TimetableEntry[];
  let semester: string | undefined;
  if (kind === 'postgraduate') {
    const res = await reader.getText(`${POSTGRAD_TABLE_URL}?_=${Date.now()}`);
    if (res.status >= 400) throw new Error(`研究生选课系统返回 ${res.status}`);
    entries = parsePostgradTable(res.text);
  } else {
    const { semesters, currentId } = await readSemesterPage(reader);
    const current = semesters.find((s) => s.id === currentId) ?? semesters[0];
    if (!current) throw new TimetableFormatError();
    semester = current.name;
    const data = await reader.getText(`${UNDERGRAD_TABLE_URL}/semester/${current.id}/print-data`);
    if (data.status >= 400) throw new Error(`教务系统返回 ${data.status}`);
    entries = parseUndergradTable(data.text);
    // 教务系统内部的学生编号，考试安排、成绩接口要用
    try {
      const id = (JSON.parse(data.text) as { studentTableVms?: { id?: unknown }[] }).studentTableVms?.[0]?.id;
      if (id !== undefined && id !== null) repo.setKv('jw_student_id', String(id));
    } catch { /* 课表已经解析成功，编号拿不到不影响 */ }
  }
  const slots = toCourseSlots(entries);
  const applied: string[] = [];
  repo.db.tx(() => {
    for (const [name, courseSlots] of slots) {
      const teachers = [...new Set(entries.filter((e) => e.course === name).flatMap((e) => e.teachers))];
      const course = repo.listCourses().find((c) => c.name === name)
        ?? repo.listCourses().find((c) => c.name.includes(name) || name.includes(c.name))
        ?? repo.upsertCourse({ id: `tt-${createHash('sha1').update(name).digest('hex').slice(0, 12)}`, code: name, name, teachers: teachers.map((t) => ({ name: t, role: 'teacher' as const })), matchStatus: 'auto' });
      repo.setCourseExtras(course.id, { schedule: courseSlots });
      applied.push(course.id);
    }
    // 上次导入过、这次课表里已经没有的课（退课等），清掉上课时间
    for (const id of repo.getKv<string[]>('timetable_courses', [])) {
      if (!applied.includes(id) && repo.getCourse(id)) repo.setCourseExtras(id, { schedule: [] });
    }
    repo.setKv('timetable_courses', applied);
    repo.setKv('timetable_meta', { kind, semester, courses: slots.size, entries: entries.length, updatedAt: new Date().toISOString() });
  });
  return { kind, semester, courses: slots.size, entries: entries.length };
}

/** 导入考试安排：每场考试是一个「考试」事项（有时间、考场），考前会提醒 */
export async function importExams(repo: Repo, reader: CampusReader): Promise<{ exams: number; added: number }> {
  const looksLoaded = (html: string) => /<td[^>]*>[\s\S]*?20\d{2}\s*[-/.年]\s*\d{1,2}/.test(html) || /暂无|没有.*考试|无考试安排/.test(html);
  // 知道学生编号时直接读考试安排的数据页，否则读入口页（可能需要渲染）
  const studentId = repo.getKv<string | null>('jw_student_id', null);
  let html = (await reader.getText(studentId ? `${EXAM_URL}/info/${studentId}` : EXAM_URL)).text;
  if (studentId && !looksLoaded(html)) html = (await reader.getText(EXAM_URL)).text;
  if (!looksLoaded(html) && reader.render) html = await reader.render(EXAM_URL, looksLoaded);
  // 一个月以前考完的不再导入（考试安排页会列出往届记录）
  const exams = parseExamPage(html).filter((e) => Date.parse(e.endsAt ?? e.startsAt) > Date.now() - 30 * 86_400_000);
  let added = 0;
  repo.db.tx(() => {
    for (const e of exams) {
      const course = repo.listCourses().find((c) => c.name === e.course) ?? repo.findCourse(e.course);
      const { created } = repo.upsertItem({
        source: 'jwfw', kind: 'exam', sourceId: `${e.course}|${e.startsAt}`, title: `${e.course} 考试`,
        body: [e.timeText, e.location].filter(Boolean).join('\n'), publishedAt: new Date().toISOString(), dueAt: e.startsAt,
        courseId: course?.id, done: false,
      });
      if (created) added++;
      if (course) {
        const kind = phaseFor(localDate(new Date(e.startsAt))) === 'exam' ? 'final' as const : 'midterm' as const;
        const others = (course.assessments ?? []).filter((a) => a.date !== e.startsAt.slice(0, 10));
        repo.setCourseExtras(course.id, { assessments: [...others, { kind, date: e.startsAt.slice(0, 10) }] });
      }
    }
    repo.setKv('exam_meta', { exams: exams.length, updatedAt: new Date().toISOString() });
  });
  return { exams: exams.length, added };
}
