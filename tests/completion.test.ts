import { afterEach, describe, expect, it } from 'vitest';
import type { CanvasAssignment, CanvasCourse, ElearningClient } from '@fudaner/mcp-fudan-elearning';
import { AppContext } from '../src/main/app-context';
import { DemoMailClient } from '../src/main/demo/demo';
import type { Channels } from '../src/main/engine/channels';
import { buildToday } from '../src/main/today';
import type { ChatMessage } from '../src/shared/types';

/**
 * 「完成」与「已处理」（来自真实试用反馈）：
 * - 组作业只需组长提交：本人在 eLearning 上「标记为完成」也应算完成；
 * - 用户说「这封不用回了」：助理能在本地把邮件标记为已处理。
 */
const NOW = new Date('2026-11-06T10:00:00');
const course: CanvasCourse = { id: 'c1', name: '学术英语写作', courseCode: 'ENGL110025.03', teachers: [] };
const team = (markedDone: boolean): CanvasAssignment => ({
  id: 'a1', courseId: 'c1', name: 'Team project（元认知策略分享视频）', dueAt: new Date('2026-11-06T23:59:00').toISOString(),
  htmlUrl: 'https://elearning.fudan.edu.cn/courses/c1/assignments/a1', submissionTypes: ['online_upload'],
  submitted: false, markedDone, updatedAt: new Date('2026-11-01T10:00:00').toISOString(),
});

class StubElearning implements ElearningClient {
  marked = false;
  async ping() { return true; }
  async listCourses() { return [course]; }
  async listAssignments() { return [team(this.marked)]; }
  async listAnnouncements() { return []; }
}

const posted: ChatMessage[] = [];
const channels: Channels = { messagePosted: (m) => posted.push(m), notify() {}, changed() {}, toolProgress() {}, thinking() {} };
let ctx: AppContext | undefined;
afterEach(async () => { await ctx?.close(); ctx = undefined; posted.length = 0; });

async function start(elearning: ElearningClient | null, mail: DemoMailClient | null = null) {
  ctx = new AppContext({ dbPath: ':memory:', channels, elearning: () => elearning, mail: () => mail });
  await ctx.start();
  return ctx;
}

describe('作业完成状态', () => {
  it('组作业：本人没交、但在 eLearning 上标记了完成 → 同步后算完成，提醒说「标记为完成」而不是「交了」', async () => {
    const el = new StubElearning();
    const app = await start(el);
    await app.syncAll(NOW);
    await app.engine.tick(NOW); // 今晚截止且未完成：发出提醒
    const item = app.repo.listItems({ kind: 'assignment' })[0];
    expect(item.done).toBe(false);
    expect(buildToday(app.repo, NOW).deadlines[0].done).toBe(false);

    el.marked = true;
    const later = new Date(NOW.getTime() + 3_600_000);
    await app.syncAll(later);
    await app.engine.tick(later);
    expect(app.repo.getItem(item.id)?.done).toBe(true);
    expect(app.repo.taskForItem(item.id)?.status).toBe('done');
    expect(buildToday(app.repo, later).deadlines[0].done).toBe(true);
    const confirm = posted.find((m) => m.content.includes('Team project') && m.content.includes('标记为完成'));
    expect(confirm?.content).not.toContain('交了');
  });

  it('在应用里把作业标记为完成：「今天」里显示已完成，之后重新同步也不会被平台状态覆盖', async () => {
    const app = await start(new StubElearning());
    await app.syncAll(NOW);
    const item = app.repo.listItems({ kind: 'assignment' })[0];
    app.repo.markItemDone(item.id, true);
    expect(buildToday(app.repo, NOW).deadlines[0].done).toBe(true);
    await app.syncAll(new Date(NOW.getTime() + 60_000));
    expect(app.repo.taskForItem(item.id)?.status).toBe('done');
    expect(buildToday(app.repo, NOW).deadlines[0].done).toBe(true);
  });
});

describe('本地标记与平台状态分开记录（Codex 审查 #13）', () => {
  it('平台上撤销了「标记为完成」、本地也没标记过 → 重新同步后恢复为未完成', async () => {
    const el = new StubElearning();
    el.marked = true;
    const app = await start(el);
    await app.syncAll(NOW);
    const item = app.repo.listItems({ kind: 'assignment' })[0];
    expect(buildToday(app.repo, NOW).deadlines[0].done).toBe(true);

    el.marked = false;
    await app.syncAll(new Date(NOW.getTime() + 60_000));
    expect(app.repo.taskForItem(item.id)?.status).toBe('todo');
    expect(buildToday(app.repo, NOW).deadlines[0].done).toBe(false);
  });

  it('本地标记过完成的，平台状态怎么变都保持完成；本地撤销后跟随平台', async () => {
    const app = await start(new StubElearning());
    await app.syncAll(NOW);
    const item = app.repo.listItems({ kind: 'assignment' })[0];
    app.repo.markItemDone(item.id, true);
    await app.syncAll(new Date(NOW.getTime() + 60_000));
    expect(app.repo.taskForItem(item.id)).toMatchObject({ status: 'done', localDone: true });

    app.repo.markItemDone(item.id, false);
    await app.syncAll(new Date(NOW.getTime() + 120_000));
    expect(app.repo.taskForItem(item.id)).toMatchObject({ status: 'todo', localDone: false });
  });

  it('本地标记作业完成后，约好的跟进自动取消，到点不会再问', async () => {
    const app = await start(new StubElearning());
    await app.syncAll(NOW);
    const item = app.repo.listItems({ kind: 'assignment' })[0];
    app.repo.addFollowup({ topic: 'Team project 写完了吗', dueAt: new Date(NOW.getTime() + 3_600_000).toISOString(), itemId: item.id, verify: { type: 'assignment_submitted', itemId: item.id } });

    app.repo.markItemDone(item.id, true);
    expect(app.repo.pendingFollowups()).toHaveLength(0);
    await app.engine.tick(new Date(NOW.getTime() + 2 * 3_600_000));
    expect(posted.some((m) => m.content.includes('Team project 写完了吗'))).toBe(false);
  });

  it('在目标页打勾（用户操作）同样算本地完成，并取消跟进', async () => {
    const app = await start(new StubElearning());
    await app.syncAll(NOW);
    const item = app.repo.listItems({ kind: 'assignment' })[0];
    app.repo.addFollowup({ topic: '跟进', dueAt: new Date(NOW.getTime() + 3_600_000).toISOString(), itemId: item.id });
    app.repo.setTaskStatus(app.repo.taskForItem(item.id)!.id, 'done');
    expect(app.repo.taskForItem(item.id)?.localDone).toBe(true);
    expect(app.repo.pendingFollowups()).toHaveLength(0);
  });
});

describe('邮件「已处理」', () => {
  it('助理可以用 mark_item_done 把邮件从「待回复」里移出，重新同步后仍然保持', async () => {
    const mail = new DemoMailClient(() => NOW);
    const app = await start(null, mail);
    await app.syncAll(NOW);
    const before = buildToday(app.repo, NOW).mailToReply;
    const wang = app.repo.listItems({ kind: 'email', query: '组会' })[0];
    expect(wang.aiCategory).toBe('reply');

    const r = await app.hub.call('fudaner_local__mark_item_done', { item_id: wang.id });
    expect(r.ok).toBe(true);
    expect(buildToday(app.repo, NOW).mailToReply).toBe(before - 1);

    await app.syncAll(new Date(NOW.getTime() + 60_000));
    expect(app.repo.getItem(wang.id)?.done).toBe(true);
  });

  it('不存在的 id 会被拒绝，不会静默成功', async () => {
    const app = await start(null, new DemoMailClient(() => NOW));
    const r = await app.hub.call('fudaner_local__mark_item_done', { item_id: '组会邮件' });
    expect(r.ok).toBe(false);
  });

  it('需要处理的邮件卡片上有「标记已处理」按钮', async () => {
    const app = await start(null, new DemoMailClient(() => NOW));
    await app.syncAll(NOW);
    await app.engine.tick(NOW);
    const card = app.repo.listFeed().find((c) => c.title.includes('组会'));
    expect(card?.actions.map((a) => a.action)).toContain('mark_done');
  });
});
