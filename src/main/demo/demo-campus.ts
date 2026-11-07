import type { Repo } from '../db/repo';
import type { LibraryStatus } from '../sources/campus-life';

/** 演示模式：考试安排、图书馆人数、校园卡余额（虚构数据） */

/** 演示考试：每门课的期末考 + 一场 5 天后的小测，用来展示考前提醒 */
export function demoExams(repo: Repo, now: Date): { exams: number; added: number } {
  let added = 0;
  const courses = repo.listCourses();
  const quizCourse = courses.find((c) => c.code.startsWith('PHYS')) ?? courses[0];
  const rows: { courseId?: string; course: string; at: string; location: string }[] = [];
  if (quizCourse) {
    const d = new Date(now.getTime() + 5 * 86_400_000);
    d.setHours(10, 0, 0, 0);
    rows.push({ courseId: quizCourse.id, course: `${quizCourse.name}（期中测验）`, at: d.toISOString(), location: 'H3208（演示）' });
  }
  for (const c of courses) {
    for (const a of c.assessments ?? []) {
      if (a.kind !== 'final') continue;
      rows.push({ courseId: c.id, course: c.name, at: new Date(a.date).toISOString(), location: 'HGX 待定（演示）' });
    }
  }
  for (const r of rows) {
    const { created } = repo.upsertItem({
      source: 'jwfw', kind: 'exam', sourceId: `demo|${r.course}|${r.at.slice(0, 10)}`, title: `${r.course} 考试`,
      body: [new Date(r.at).toLocaleString('zh-CN', { hour12: false }), r.location].join('\n'),
      publishedAt: now.toISOString(), dueAt: r.at, courseId: r.courseId, done: false,
    });
    if (created) added++;
  }
  repo.setKv('exam_meta', { exams: rows.length, updatedAt: now.toISOString() });
  return { exams: rows.length, added };
}

export function demoLibrary(): LibraryStatus[] {
  return [
    { name: '文科馆（演示）', inside: 452, remaining: 748, openTime: '8:00~22:00' },
    { name: '理科馆（演示）', inside: 281, remaining: 619, openTime: '8:00~23:00' },
    { name: '江湾馆（演示）', inside: 325, remaining: 475, openTime: '8:00~22:00' },
  ];
}

export function demoCardBalance(): number {
  return 23.5;
}
