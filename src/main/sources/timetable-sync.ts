import { createHash } from 'node:crypto';
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
  render?(url: string, ready: (html: string) => boolean): Promise<string>;
}

export interface TimetableResult { kind: 'undergraduate' | 'postgraduate'; semester?: string; courses: number; entries: number }

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
    const page = await reader.getText(UNDERGRAD_TABLE_URL);
    if (page.status >= 400) throw new Error(`教务系统返回 ${page.status}`);
    const { semesters, currentId } = parseSemesterPage(page.text);
    const current = semesters.find((s) => s.id === currentId) ?? semesters[0];
    if (!current) throw new TimetableFormatError();
    semester = current.name;
    const data = await reader.getText(`${UNDERGRAD_TABLE_URL}/semester/${current.id}/print-data`);
    if (data.status >= 400) throw new Error(`教务系统返回 ${data.status}`);
    entries = parseUndergradTable(data.text);
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
  let html = (await reader.getText(EXAM_URL)).text;
  if (!looksLoaded(html) && reader.render) html = await reader.render(EXAM_URL, looksLoaded);
  const exams = parseExamPage(html);
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
