import { senderBelongsToCourse, type CourseRegistryData } from '@fudaner/mcp-fudan-courses';
import type { Course, Item } from '../../shared/types';
import type { Repo } from '../db/repo';

/**
 * 课程总表（PRD §7.4）：把邮件挂到课程和作业上。
 * 规则优先（发件人、课程名、作业名），判断不出来的留给本地模型（TODO(C)：ai/link.ts）。
 */
export function linkMail(repo: Repo, mail: Item, courseHint?: string): { course?: Course; assignment?: Item; reason?: string } {
  const courses = repo.listCourses();
  const addr = (mail.sender?.match(/<([^>]+)>/)?.[1] ?? mail.sender ?? '').trim();
  let course = courses.find((c) => senderBelongsToCourse(addr, c.teachers.map((t) => t.email ?? '').filter(Boolean)));
  let reason = course ? `发件人是「${course.name}」的${course.teachers.find((t) => t.email === addr)?.role === 'ta' ? '助教' : '老师'}` : undefined;
  if (!course) {
    const text = `${mail.title} ${courseHint ?? ''}`;
    course = courses.find((c) => text.includes(c.name) || text.toUpperCase().includes(c.code.split('.')[0]));
    if (course) reason = `邮件主题提到「${course.name}」`;
  }
  if (!course) return {};
  repo.setItemCourse(mail.id, course.id);

  const text = `${mail.title}\n${mail.body.slice(0, 1000)}`.toLowerCase();
  const assignment = repo
    .listItems({ kind: 'assignment', courseId: course.id, limit: 50 })
    .find((a) => text.includes(a.title.toLowerCase()) || keyToken(a.title).some((k) => text.includes(k)));
  if (assignment) {
    repo.addLink(mail.id, assignment.id, `${reason}，并提到「${assignment.title}」`, 0.85);
    return { course, assignment, reason };
  }
  return { course, reason };
}

/** "Lab 5：链表" → ["lab 5", "lab5"] */
function keyToken(title: string): string[] {
  const m = title.toLowerCase().match(/(lab|hw|作业|习题|project|实验)\s*(\d+)/);
  return m ? [`${m[1]} ${m[2]}`, `${m[1]}${m[2]}`] : [];
}

/** fudan-courses MCP 服务的数据实现 */
export function courseRegistryData(repo: Repo): CourseRegistryData {
  return {
    async list() {
      return repo.listCourses().map((c) => ({ code: c.code, name: c.name, teachers: c.teachers, elearningId: c.elearningId, icourseId: c.icourseId, matchStatus: c.matchStatus }));
    },
    async get(code: string) {
      const c = repo.findCourse(code);
      if (!c) return null;
      const items = repo.listItems({ courseId: c.id, limit: 100 });
      return {
        course: { code: c.code, name: c.name, teachers: c.teachers, assessments: c.assessments },
        assignments: items.filter((i) => i.kind === 'assignment').map((i) => ({ id: i.id, title: i.title, dueAt: i.dueAt, submitted: i.done })),
        announcements: items.filter((i) => i.kind === 'announcement').map((i) => ({ id: i.id, title: i.title, at: i.publishedAt })),
        mails: items.filter((i) => i.kind === 'email').map((i) => ({ id: i.id, subject: i.title, from: i.sender, summary: i.aiSummary })),
        replays: items.filter((i) => i.kind === 'replay').map((i) => ({ id: i.id, title: i.title })),
      };
    },
  };
}
