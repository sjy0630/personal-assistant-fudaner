import { parseCourseCode, } from '@fudaner/mcp-fudan-courses';
import type { ElearningClient } from '@fudaner/mcp-fudan-elearning';
import type { Repo } from '../db/repo';
import { fmt } from '../engine/engine';

const RECENT_MS = 48 * 3_600_000;

/**
 * eLearning 同步（来源 → 事件）。只读。
 * 首次同步时，只为最近 48 小时内发布的作业和公告生成事件，避免一次性冒出整个学期的历史。
 */
export async function syncElearning(client: ElearningClient, repo: Repo, now = new Date()): Promise<{ courses: number; triggers: number }> {
  const firstSync = !repo.getKv<string | null>('elearning_last_sync', null);
  const lastSync = repo.getKv<string | null>('elearning_last_sync', null);
  const isRecent = (iso?: string) => !!iso && now.getTime() - Date.parse(iso) < RECENT_MS;
  let triggers = 0;
  const add = (t: Parameters<Repo['addTrigger']>[0]) => { if (repo.addTrigger(t)) triggers++; };

  const courses = await client.listCourses();
  for (const c of courses) {
    const { base, section } = parseCourseCode(c.courseCode);
    const course = repo.upsertCourse({
      code: base ? `${base}${section ? '.' + section : ''}` : c.courseCode, section, name: c.name, term: c.term,
      teachers: c.teachers, elearningId: c.id, matchStatus: 'auto',
    });
    let goal = repo.courseGoal(course.id);
    if (!goal) goal = repo.addGoal({ level: 'course', title: course.name, courseId: course.id, createdBy: 'system' });
    const thread = `course:${course.code}`;

    for (const a of await client.listAssignments(c.id)) {
      const { item, created, changedFields } = repo.upsertItem({
        source: 'elearning', kind: 'assignment', sourceId: a.id, title: a.name, body: stripHtml(a.description ?? ''),
        url: a.htmlUrl, publishedAt: a.updatedAt ?? now.toISOString(), dueAt: a.dueAt, courseId: course.id, done: a.submitted,
      });
      repo.upsertTaskForItem({ goalId: goal.id, itemId: item.id, title: a.name, dueAt: a.dueAt, done: a.submitted, verify: { type: 'assignment_submitted', itemId: item.id } });
      const payload = { itemId: item.id, title: a.name, course: course.name, dueAt: a.dueAt, dueText: a.dueAt ? fmt(a.dueAt) : '未定' };
      if (created && (!firstSync || isRecent(a.updatedAt))) {
        add({ source: 'elearning', kind: 'assignment_new', sourceRef: a.id, threadKey: thread, payload });
      }
      if (!created && changedFields.includes('dueAt')) {
        add({ source: 'elearning', kind: 'assignment_changed', sourceRef: `${a.id}:${a.dueAt}`, threadKey: thread, payload: { ...payload, dueChanged: true } });
      }
      if (!created && changedFields.includes('done') && a.submitted) {
        add({ source: 'elearning', kind: 'assignment_submitted', sourceRef: a.id, threadKey: thread, payload });
      }
    }
  }

  const byElearningId = new Map(repo.listCourses().map((c) => [c.elearningId, c]));
  const anns = await client.listAnnouncements(courses.map((c) => c.id), lastSync ?? new Date(now.getTime() - 14 * 86_400_000).toISOString());
  for (const a of anns) {
    const course = byElearningId.get(a.courseId);
    const { item, created } = repo.upsertItem({
      source: 'elearning', kind: 'announcement', sourceId: a.id, title: a.title, body: stripHtml(a.message), url: a.htmlUrl,
      publishedAt: a.postedAt, courseId: course?.id, done: false,
    });
    if (created && (!firstSync || isRecent(a.postedAt))) {
      add({ source: 'elearning', kind: 'announcement_new', sourceRef: a.id, threadKey: `course:${course?.code ?? 'unknown'}`, payload: { itemId: item.id, title: a.title, course: course?.name } });
    }
  }

  repo.setKv('elearning_last_sync', now.toISOString());
  return { courses: courses.length, triggers };
}

export function stripHtml(html: string): string {
  return html.replace(/<br\s*\/?>/gi, '\n').replace(/<\/p>/gi, '\n').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/\n{3,}/g, '\n\n').trim();
}
