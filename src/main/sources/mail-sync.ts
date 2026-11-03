import type { MailClient } from '@fudaner/mcp-fudan-mail';
import type { Item } from '../../shared/types';
import type { Repo } from '../db/repo';
import type { ModelRouter } from '../ai/llm';
import { classifyMails } from '../ai/mail';
import { linkMail } from '../courses/registry';

const RECENT_MS = 48 * 3_600_000;

/**
 * 学生邮箱同步（来源 → 事件）：拉取 → 本地模型分类 → 关联课程 / 作业 → 生成事件。
 * 首次同步只为最近 48 小时的邮件生成事件。
 */
export async function syncMail(client: MailClient, repo: Repo, router: ModelRouter, now = new Date()): Promise<{ fetched: number; triggers: number }> {
  const last = repo.getKv<string | null>('mail_last_sync', null);
  const since = last ? new Date(Date.parse(last) - 3_600_000) : new Date(now.getTime() - 14 * 86_400_000);
  const msgs = await client.fetchSince(since);
  const fresh: Item[] = [];
  for (const m of msgs) {
    const { item, created } = repo.upsertItem({
      source: 'mail', kind: 'email', sourceId: m.messageId ?? m.uid, title: m.subject, body: m.text, publishedAt: m.date,
      sender: m.from.name ? `${m.from.name} <${m.from.address}>` : m.from.address, done: false,
    });
    if (created) fresh.push(item);
  }

  const { results, model } = await classifyMails(fresh, router.for('mail_classify'));
  let triggers = 0;
  for (const item of fresh) {
    const ai = results.get(item.id)!;
    repo.setItemAi(item.id, { category: ai.category, summary: ai.summary, action: ai.action, model });
    const link = linkMail(repo, item, ai.courseHint);
    const category = link.assignment || (link.course && ai.category === 'other') ? 'course' : ai.category;
    if (category !== ai.category) repo.setItemAi(item.id, { category, summary: ai.summary, action: ai.action, model });
    if (last || now.getTime() - Date.parse(item.publishedAt) < RECENT_MS) {
      const ok = repo.addTrigger({
        source: 'mail', kind: 'mail_new', sourceRef: item.sourceId,
        threadKey: link.assignment ? `course:${link.course!.code}` : link.course ? `course:${link.course.code}` : `mail:${item.sourceId}`,
        payload: {
          itemId: item.id, from: item.sender?.replace(/<.*>/, '').trim(), subject: item.title, summary: ai.summary, category,
          linkedItemId: link.assignment?.id, linkedTitle: link.assignment?.title, course: link.course?.name,
        },
        occurredAt: item.publishedAt,
      });
      if (ok) triggers++;
    }
  }
  repo.setKv('mail_last_sync', now.toISOString());
  return { fetched: msgs.length, triggers };
}
