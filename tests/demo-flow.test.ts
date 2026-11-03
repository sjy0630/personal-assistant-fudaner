import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppContext } from '../src/main/app-context';
import { DemoElearningClient, DemoMailClient, demoLateMail, seedDemoProfile } from '../src/main/demo/demo';
import type { Channels } from '../src/main/engine/channels';
import type { ChatMessage } from '../src/shared/types';

/**
 * 端到端：演示模式下跑通「同步 → 主动引擎 → 写回 → 闭环 → MCP 工具 → 后台工单 → 搜索」。
 * 不需要任何模型（全部走规则兜底），也不需要 Electron。
 */
const NOW = new Date('2026-11-04T10:00:00');
const posted: ChatMessage[] = [];
const notified: string[] = [];
const channels: Channels = {
  messagePosted: (m) => posted.push(m), notify: (_t, b) => notified.push(b), changed() {}, toolProgress() {}, thinking() {},
};

const elearning = new DemoElearningClient(() => NOW);
const mail = new DemoMailClient(() => NOW);
let ctx: AppContext;

beforeAll(async () => {
  ctx = new AppContext({ dbPath: ':memory:', channels, elearning: () => elearning, mail: () => mail });
  ctx.repo.setSettings({ demoMode: true });
  seedDemoProfile(ctx.repo);
  await ctx.start();
  await ctx.syncAll(NOW);
});
afterAll(async () => ctx.close());

describe('演示流程', () => {
  it('同步后建立课程总表和课程目标', () => {
    expect(ctx.repo.listCourses()).toHaveLength(6);
    expect(ctx.repo.listGoals().filter((g) => g.level === 'course')).toHaveLength(6);
    expect(ctx.repo.findCourse('COMP130004.01')?.name).toBe('数据结构');
  });

  it('邮件分类（规则兜底）', () => {
    const wang = ctx.repo.listItems({ kind: 'email', query: '组会' })[0];
    expect(wang.aiCategory).toBe('reply');
  });

  it('主动引擎：早安 + 动态 + 建议工单，打扰次数远少于事件数', async () => {
    const evals = await ctx.engine.tick(NOW);
    const morning = posted.find((m) => m.trigger === 'morning');
    expect(morning?.content).toContain('Lab 5');
    expect(notified.length).toBeGreaterThan(0);

    const feed = ctx.repo.listFeed();
    expect(feed.some((c) => c.title.includes('习题 9') || c.title.includes('Lab 6'))).toBe(true);
    const suggest = feed.find((c) => c.type === 'suggest_ticket');
    expect(suggest?.reason).toContain('交换');

    const interruptions = evals.filter((e) => e.decision === 'chat_notify' || e.decision === 'chat').length;
    expect(interruptions).toBeLessThan(evals.length);
  });

  it('跨平台关联：助教邮件挂到 Lab 5 上，并主动告诉用户', async () => {
    mail.inject(demoLateMail(new Date(NOW.getTime() + 60_000)));
    await ctx.syncAll(new Date(NOW.getTime() + 2 * 60_000));
    await ctx.engine.tick(new Date(NOW.getTime() + 2 * 60_000));
    const lab5 = ctx.repo.listItems({ kind: 'assignment', query: 'Lab 5' })[0];
    expect(ctx.repo.linksOf(lab5.id).map((l) => l.item.title)).toContain('关于 Lab 5 提交要求的补充说明');
    expect(posted.some((m) => m.content.includes('Lab 5') && m.trigger?.startsWith('eval:'))).toBe(true);
  });

  it('可验证的闭环：在 eLearning 上交了 Lab 5 → 任务自动完成、不再提醒', async () => {
    const lab5 = ctx.repo.listItems({ kind: 'assignment', query: 'Lab 5' })[0];
    elearning.submit(lab5.sourceId);
    const later = new Date(NOW.getTime() + 11 * 3_600_000); // 21:00，进入 3 小时窗口
    await ctx.syncAll(later);
    await ctx.engine.tick(later);
    expect(ctx.repo.taskForItem(lab5.id)?.status).toBe('done');
    // 已提交的作业即使到了 3 小时窗口，也不会再生成提醒
    expect(posted.some((m) => m.content.includes('3 小时后截止') && m.content.includes('Lab 5'))).toBe(false);
  });

  it('MCP 连接层：智能体能通过工具查询 DDL 和课程', async () => {
    const tools = ctx.hub.list().map((s) => s.server);
    expect(tools).toEqual(['fudan-elearning', 'fudan-mail', 'fudan-courses', 'fudaner-local']);
    const r = await ctx.hub.call('fudan_courses__get_course', { code: '数据结构' });
    expect(r.ok).toBe(true);
    expect(r.text).toContain('Lab 5');
    expect(ctx.hub.llmTools().length).toBeGreaterThan(15);
  });

  it('后台工单：同意建议后执行，成果进资源库并可搜索到', async () => {
    const suggest = ctx.repo.listFeed().find((c) => c.type === 'suggest_ticket')!;
    const ticketId = String(suggest.actions[0].payload!.ticketId);
    ctx.repo.setTicketStatus(ticketId, 'queued');
    const t = await ctx.executor.runNext();
    expect(t?.status).toBe('done');
    const res = ctx.repo.getResource(t!.resultResourceId!);
    expect(res?.text).toContain('交换');
    expect(ctx.repo.search('交换项目').some((h) => h.type === 'resource')).toBe(true);
  });

  it('没有模型时，对话也能回答 DDL 问题', async () => {
    const reply = await ctx.agent.handleUserMessage('这周有什么 DDL？');
    expect(reply.content).toContain('截止');
  });
});
