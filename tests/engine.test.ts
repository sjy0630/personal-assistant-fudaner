import { describe, expect, it } from 'vitest';
import { ModelRouter } from '../src/main/ai/llm';
import { Db } from '../src/main/db/db';
import { Repo } from '../src/main/db/repo';
import { dailyBudget } from '../src/main/engine/budget';
import { buildCalendar, localDate } from '../src/main/engine/calendar';
import type { Channels } from '../src/main/engine/channels';
import { ProactiveEngine } from '../src/main/engine/engine';
import type { ChatMessage, Item } from '../src/shared/types';

/**
 * 主动引擎的单元测试（PRD §5.7、§7.8）。
 * 不配置任何模型：研判全部走规则表，结果是确定的。
 * 时间都用本地时间构造（不带 Z），和引擎里的「本地日期」口径一致。
 *
 * 用到的日期（按 engine/calendar.ts 的示例校历）：
 *   2026-11-10 周二 第 10 周 平时；2026-12-11 第 14 周 平时；2026-12-14 第 15 周 考试周前；2026-10-02 国庆假期
 */
const at = (s: string) => new Date(s);

function setup() {
  const repo = new Repo(new Db(':memory:'));
  repo.setCalendar(buildCalendar());
  const posted: ChatMessage[] = [];
  const notified: string[] = [];
  const channels: Channels = {
    messagePosted: (m) => posted.push(m),
    notify: (_title, body) => notified.push(body),
    changed() {}, toolProgress() {}, thinking() {},
  };
  const engine = new ProactiveEngine(repo, new ModelRouter(() => repo.getSettings()), channels);
  return {
    repo, engine, posted, notified,
    /** 主动引擎评估后发出的对话消息（不含早安、工单结果） */
    evalMessages: () => posted.filter((m) => m.trigger?.startsWith('eval:')),
    morning: () => posted.find((m) => m.trigger === 'morning'),
    budgetOf: (d: Date) => repo.getBudget(localDate(d), () => ({ budget: -1, phase: 'regular' })),
  };
}

function addAssignment(repo: Repo, title: string, dueAt: Date, done = false): Item {
  const course = repo.upsertCourse({ code: 'COMP130004.01', section: '01', name: '数据结构', teachers: [], elearningId: 'c1', matchStatus: 'auto' });
  const goal = repo.courseGoal(course.id) ?? repo.addGoal({ level: 'course', title: course.name, courseId: course.id, createdBy: 'system' });
  const { item } = repo.upsertItem({
    source: 'elearning', kind: 'assignment', sourceId: title, title, body: '', publishedAt: at('2026-11-01T10:00:00').toISOString(),
    dueAt: dueAt.toISOString(), courseId: course.id, done,
  });
  repo.upsertTaskForItem({ goalId: goal.id, itemId: item.id, title, dueAt: dueAt.toISOString(), done, verify: { type: 'assignment_submitted', itemId: item.id } });
  return item;
}

function addReplyMail(repo: Repo, ref: string, subject: string, when: Date): void {
  repo.addTrigger({
    source: 'mail', kind: 'mail_new', sourceRef: ref, threadKey: `mail:${ref}`,
    payload: { from: '王老师', subject, summary: '', category: 'reply' }, occurredAt: when.toISOString(),
  });
}

describe('静默时段', () => {
  it('非紧急事件在静默时段不打扰，并入第二天的早安消息', async () => {
    const { repo, engine, evalMessages, notified, morning } = setup();
    const night = at('2026-11-10T23:45:00');
    addReplyMail(repo, 'm1', '关于下周组会时间调整', night);

    const evals = await engine.tick(night);
    const ev = evals.find((e) => e.threadKey === 'mail:m1')!;
    expect(ev.decision).toBe('digest');
    expect(ev.reason).toContain('静默时段');
    expect(evalMessages()).toHaveLength(0);
    expect(notified).toHaveLength(0);

    await engine.tick(at('2026-11-11T08:00:00'));
    expect(morning()?.content).toContain('关于下周组会时间调整');
    expect(repo.listEvals().find((e) => e.decision === 'chat_notify' && e.reason.includes('每日早安'))?.reason).toContain('合并了 1 条');
    // 攒下的动态只用一次
    expect(repo.takeDigest()).toHaveLength(0);
  });

  it('3 小时内截止且未提交的作业，静默时段也会提醒', async () => {
    const { repo, engine, evalMessages, notified } = setup();
    addAssignment(repo, 'Lab 5：链表与栈', at('2026-11-11T01:30:00'));

    const evals = await engine.tick(at('2026-11-10T23:45:00'));
    expect(evals.find((e) => e.triggerIds.length && e.decision === 'chat_notify')).toBeDefined();
    expect(evalMessages()).toHaveLength(1);
    expect(evalMessages()[0].content).toContain('Lab 5');
    expect(evalMessages()[0].content).toContain('3 小时');
    expect(notified).toHaveLength(1);
  });

  it('早安只在早上发：深夜和清晨静默时段不发，07:30 之后才发', async () => {
    const { engine, morning } = setup();
    await engine.tick(at('2026-11-10T23:45:00'));
    await engine.tick(at('2026-11-11T07:00:00'));
    expect(morning()).toBeUndefined();
    await engine.tick(at('2026-11-11T07:45:00'));
    expect(morning()).toBeDefined();
  });

  it('下午 2 点之后第一次打开，当天不发早安', async () => {
    const { engine, morning } = setup();
    await engine.tick(at('2026-11-10T15:00:00'));
    expect(morning()).toBeUndefined();
  });
});

describe('注意力预算', () => {
  it('预算用完后逐级降级：需要回复的邮件改为并入早安，而不是被丢掉', async () => {
    const { repo, engine } = setup();
    repo.setProfile({ proactivity: 'low' }); // 平时预算 6
    const noon = at('2026-11-10T12:00:00');
    for (let i = 1; i <= 5; i++) addReplyMail(repo, `m${i}`, `需要回复的邮件 ${i}`, new Date(noon.getTime() + i * 1000));

    const evals = await engine.evaluatePending(noon);
    const decisions = evals.map((e) => e.decision);
    // 每条对话消息成本 1.5：前 4 条用完 6 点预算，第 5 条降级为并入早安
    expect(decisions).toEqual(['chat', 'chat', 'chat', 'chat', 'digest']);
    expect(evals[4].reason).toContain('预算不足');
    expect(evals[4].attentionCost).toBeLessThan(1);
    expect(repo.takeDigest().map((d) => d.text).join()).toContain('需要回复的邮件 5');
  });

  it('每天的预算随学期阶段变化：平时 10，考试周前 15，假期 4（主动程度「中」）', async () => {
    const { engine, budgetOf } = setup();
    for (const d of ['2026-11-10T10:00:00', '2026-12-14T10:00:00', '2026-10-02T10:00:00']) await engine.tick(at(d));
    expect(budgetOf(at('2026-11-10T10:00:00')).budget).toBe(dailyBudget('medium', 'regular'));
    expect(budgetOf(at('2026-12-14T10:00:00')).budget).toBe(15);
    expect(budgetOf(at('2026-10-02T10:00:00')).budget).toBe(4);
  });
});

describe('学期阶段切换', () => {
  it('进入「考试周前」时主动建议做复习计划：以建议工单的形式出现，等用户同意', async () => {
    const { repo, engine } = setup();
    await engine.tick(at('2026-12-11T10:00:00')); // 平时，记下当前阶段
    expect(repo.listTickets()).toHaveLength(0);

    await engine.tick(at('2026-12-14T10:00:00')); // 第 15 周：考试周前
    const tickets = repo.listTickets();
    expect(tickets).toHaveLength(1);
    expect(tickets[0]).toMatchObject({ title: '考试周复习计划', status: 'suggested', mandate: 'inferred' });
    const card = repo.listFeed().find((c) => c.type === 'suggest_ticket')!;
    expect(card.actions.map((a) => a.action)).toContain('accept_ticket');

    // 同一天再运行，不会重复建议
    await engine.tick(at('2026-12-14T11:00:00'));
    expect(repo.listTickets()).toHaveLength(1);
  });

  it('第一次启动时不会误报「阶段切换」', async () => {
    const { repo, engine } = setup();
    await engine.tick(at('2026-12-14T10:00:00'));
    expect(repo.listTickets()).toHaveLength(0);
  });
});

describe('主动跟进', () => {
  it('约定的跟进到点后主动询问，只问一次', async () => {
    const { repo, engine, evalMessages } = setup();
    const lab = addAssignment(repo, 'Lab 5：链表与栈', at('2026-11-12T23:59:00'));
    repo.addFollowup({ topic: 'Lab 5 写完了吗', dueAt: at('2026-11-11T09:00:00').toISOString(), itemId: lab.id, verify: { type: 'assignment_submitted', itemId: lab.id } });
    const asked = () => evalMessages().filter((m) => m.content.includes('Lab 5 写完了吗'));

    await engine.tick(at('2026-11-11T08:30:00'));
    expect(asked()).toHaveLength(0);

    await engine.tick(at('2026-11-11T09:05:00'));
    expect(asked()).toHaveLength(1);
    expect(asked()[0].content).toContain('进展怎么样');

    await engine.tick(at('2026-11-11T10:00:00'));
    expect(asked()).toHaveLength(1);
    expect(repo.pendingFollowups()).toHaveLength(0);
  });

  it('作业在平台上已经提交时，跟进自动取消，不再追问', async () => {
    const { repo, engine, evalMessages } = setup();
    const due = at('2026-11-12T23:59:00');
    const lab = addAssignment(repo, 'Lab 5：链表与栈', due);
    repo.addFollowup({ topic: 'Lab 5 写完了吗', dueAt: at('2026-11-11T09:00:00').toISOString(), itemId: lab.id, verify: { type: 'assignment_submitted', itemId: lab.id } });

    // 模拟下一次同步：eLearning 显示已提交
    repo.upsertItem({ ...lab, done: true });
    engine.verifyAfterSync();
    expect(repo.pendingFollowups()).toHaveLength(0);
    expect(repo.taskForItem(lab.id)?.status).toBe('done');

    await engine.tick(at('2026-11-11T09:05:00'));
    expect(evalMessages().filter((m) => m.content.includes('Lab 5 写完了吗'))).toHaveLength(0);
  });
});

describe('观察模式', () => {
  it('照常评估并记录「本来会做什么」，但不打扰、不进动态、不花预算', async () => {
    const { repo, engine, posted, budgetOf } = setup();
    repo.setSettings({ observeRules: ['mail_new'] });
    const noon = at('2026-11-10T12:00:00');
    addReplyMail(repo, 'm1', '关于下周组会时间调整', noon);

    const [ev] = await engine.evaluatePending(noon);
    expect(ev.ruleMode).toBe('observe');
    expect(ev.decision).toBe('chat');
    expect(ev.attentionCost).toBe(0);
    expect(ev.reason).toContain('观察模式');
    expect(posted).toHaveLength(0);
    expect(repo.listFeed()).toHaveLength(0);
    expect(budgetOf(noon).spent).toBe(0);
  });
});

describe('线程归并', () => {
  it('同一门课的多个事件合并成一次评估：最重要的发到对话，其余进入动态', async () => {
    const { repo, engine, evalMessages } = setup();
    const noon = at('2026-11-10T12:00:00');
    const lab = addAssignment(repo, 'Lab 5：链表与栈', at('2026-11-10T22:00:00'));
    const thread = 'course:COMP130004.01';
    repo.addTrigger({ source: 'clock', kind: 'deadline_24h', sourceRef: lab.id, threadKey: thread, payload: { itemId: lab.id, title: lab.title, dueAt: lab.dueAt } });
    repo.addTrigger({ source: 'elearning', kind: 'announcement_new', sourceRef: 'a1', threadKey: thread, payload: { title: '期中考试范围说明', course: '数据结构' } });

    const evals = await engine.evaluatePending(noon);
    expect(evals).toHaveLength(1);
    expect(evals[0].triggerIds).toHaveLength(2);
    expect(evalMessages()).toHaveLength(1);
    expect(evalMessages()[0].content).toContain('还剩约 10 小时');
    expect(repo.listFeed().map((c) => c.title)).toContain('期中考试范围说明');
  });

  it('同一事件只会写入一次（幂等）', () => {
    const { repo } = setup();
    const t = { source: 'mail' as const, kind: 'mail_new' as const, sourceRef: 'x', threadKey: 'mail:x', payload: {} };
    expect(repo.addTrigger(t)).toBe(true);
    expect(repo.addTrigger(t)).toBe(false);
  });

  it('同一份作业的同一档提醒只发一次', async () => {
    const { repo, engine, evalMessages } = setup();
    addAssignment(repo, 'Lab 5：链表与栈', at('2026-11-10T22:00:00'));
    await engine.tick(at('2026-11-10T12:00:00'));
    await engine.tick(at('2026-11-10T13:00:00'));
    expect(evalMessages().filter((m) => m.content.includes('Lab 5'))).toHaveLength(1);
  });
});

describe('可验证的闭环', () => {
  it('提醒过的作业交了：马上在对话里确认一句；没提醒过的：并入早安', async () => {
    const { repo, engine, evalMessages } = setup();
    const reminded = addAssignment(repo, 'Lab 5：链表与栈', at('2026-11-10T22:00:00'));
    const quiet = addAssignment(repo, '线代 HW 7', at('2026-11-14T23:59:00'));
    await engine.tick(at('2026-11-10T12:00:00')); // Lab 5 进入 24 小时窗口，发出提醒

    for (const it of [reminded, quiet]) {
      repo.upsertItem({ ...it, done: true });
      repo.addTrigger({ source: 'elearning', kind: 'assignment_submitted', sourceRef: it.sourceId, threadKey: `course:${it.title}`, payload: { itemId: it.id, title: it.title } });
    }
    engine.verifyAfterSync();
    const evals = await engine.evaluatePending(at('2026-11-10T13:00:00'));

    expect(evals.find((e) => e.assessment?.messageDraft.includes('Lab 5'))?.decision).toBe('chat');
    expect(evals.find((e) => e.assessment?.messageDraft.includes('线代'))?.decision).toBe('digest');
    expect(evalMessages().some((m) => m.content.includes('看到「Lab 5：链表与栈」已经交了'))).toBe(true);
    expect(repo.taskForItem(reminded.id)?.status).toBe('done');
  });
});

describe('写回', () => {
  it('来自平台的重要事件进对话的同时也留在动态里，且不额外占用预算', async () => {
    const { repo, engine, evalMessages, budgetOf } = setup();
    const noon = at('2026-11-10T12:00:00');
    addReplyMail(repo, 'm1', '关于下周组会时间调整', noon);
    await engine.evaluatePending(noon);
    expect(evalMessages()).toHaveLength(1);
    expect(repo.listFeed().map((c) => c.title)).toContain('关于下周组会时间调整');
    expect(budgetOf(noon).spent).toBe(1.5);
  });

  it('UIS 登录过期：主动提醒，并带「重新登录」按钮', async () => {
    const { repo, engine, evalMessages, notified } = setup();
    repo.addTrigger({ source: 'elearning', kind: 'auth_expired', sourceRef: '2026-11-10:elearning', threadKey: 'auth', payload: { platform: 'elearning' } });
    await engine.evaluatePending(at('2026-11-10T12:00:00'));
    expect(evalMessages()[0].content).toContain('登录过期');
    expect(evalMessages()[0].actions.map((a) => a.action)).toEqual(['login']);
    expect(notified).toHaveLength(1);
    expect(repo.listFeed()).toHaveLength(0);
  });

  it('价值很高的建议（考试周前的复习计划）除了动态卡片，还会在对话里直接问', async () => {
    const { repo, engine, evalMessages } = setup();
    await engine.tick(at('2026-12-11T10:00:00'));
    await engine.tick(at('2026-12-14T10:00:00'));
    const ask = evalMessages().find((m) => m.content.includes('复习计划'))!;
    expect(ask.actions.map((a) => a.action)).toEqual(['accept_ticket', 'decline_ticket']);
    expect(ask.actions[0].payload?.ticketId).toBe(repo.listTickets()[0].id);
  });

  it('这类建议也遵守静默时段：深夜进入「考试周前」时不发消息，攒到早安里', async () => {
    const { repo, engine, evalMessages } = setup();
    await engine.tick(at('2026-12-11T10:00:00'));
    await engine.tick(at('2026-12-14T23:45:00'));
    expect(repo.listTickets()[0]).toMatchObject({ title: '考试周复习计划', status: 'suggested' });
    expect(evalMessages().some((m) => m.content.includes('复习计划'))).toBe(false);
    expect(repo.takeDigest().map((d) => d.text).join()).toContain('复习计划');
  });

  it('这类建议也遵守当天预算：剩余预算不够一条对话消息时，只留在动态里', async () => {
    const { repo, engine, evalMessages } = setup();
    await engine.tick(at('2026-12-11T10:00:00'));
    const day = at('2026-12-14T14:30:00'); // 14:00 之后，不发早安
    const date = '2026-12-14';
    repo.getBudget(date, () => ({ budget: 15, phase: 'pre_exam' }));
    repo.spendBudget(date, 14); // 只剩 1 点：够建议卡片（0.5），不够对话消息（1.5）
    await engine.tick(day);
    expect(repo.listFeed().some((c) => c.type === 'suggest_ticket')).toBe(true);
    expect(evalMessages().some((m) => m.content.includes('复习计划'))).toBe(false);
    expect(repo.getBudget(date, () => ({ budget: -1, phase: 'regular' })).spent).toBeLessThanOrEqual(15);
  });
});
