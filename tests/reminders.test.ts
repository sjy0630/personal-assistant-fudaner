import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppContext } from '../src/main/app-context';
import { ChatAgent } from '../src/main/ai/agent';
import { ModelRouter, type LlmClient } from '../src/main/ai/llm';
import { describeRepeat, nextOccurrence, validateRepeat } from '../src/main/engine/reminders';
import { nullChannels, type Channels } from '../src/main/engine/channels';
import type { ChatMessage } from '../src/shared/types';

/** 测试按本机时区计算；固定用上海时间书写，换算后断言 */
process.env.TZ = 'Asia/Shanghai';
const at = (s: string) => new Date(`${s}+08:00`);

describe('下一次触发时间', () => {
  it('每天：今天的时间没到就是今天，过了就是明天', () => {
    expect(nextOccurrence({ type: 'daily', time: '22:00' }, at('2026-11-07T21:00:00'))).toEqual(at('2026-11-07T22:00:00'));
    expect(nextOccurrence({ type: 'daily', time: '22:00' }, at('2026-11-07T22:00:00'))).toEqual(at('2026-11-08T22:00:00'));
  });
  it('工作日和每周几', () => {
    // 2026-11-07 是周六
    expect(nextOccurrence({ type: 'weekly', time: '08:00', weekdays: [1, 2, 3, 4, 5] }, at('2026-11-07T10:00:00'))).toEqual(at('2026-11-09T08:00:00'));
    expect(nextOccurrence({ type: 'weekly', time: '08:00', weekdays: [6] }, at('2026-11-07T07:00:00'))).toEqual(at('2026-11-07T08:00:00'));
  });
  it('一次性：过期返回空', () => {
    expect(nextOccurrence({ type: 'once', at: '2026-11-08T08:00:00+08:00' }, at('2026-11-07T10:00:00'))).toEqual(at('2026-11-08T08:00:00'));
    expect(nextOccurrence({ type: 'once', at: '2026-11-06T08:00:00+08:00' }, at('2026-11-07T10:00:00'))).toBeUndefined();
  });
  it('校验和描述', () => {
    expect(validateRepeat({ type: 'daily', time: '25:00' })).toContain('HH:MM');
    expect(validateRepeat({ type: 'weekly', time: '08:00', weekdays: [] })).toContain('星期');
    expect(describeRepeat({ type: 'weekly', time: '08:00', weekdays: [1, 2, 3, 4, 5] })).toBe('工作日 08:00');
    expect(describeRepeat({ type: 'weekly', time: '19:30', weekdays: [3, 1] })).toBe('每周一、三 19:30');
  });
});

describe('到点执行', () => {
  const cleanups: (() => Promise<void>)[] = [];
  afterEach(async () => { for (const c of cleanups.splice(0)) await c(); });
  const setup = async () => {
    const posted: ChatMessage[] = [];
    const notified: string[] = [];
    const channels: Channels = { ...nullChannels, messagePosted: (m) => posted.push(m), notify: (_t, body) => notified.push(body) };
    const ctx = new AppContext({ dbPath: ':memory:', channels, elearning: () => null, mail: () => null });
    cleanups.push(() => ctx.close());
    await ctx.start();
    return { ctx, posted, notified, channels };
  };

  it('提醒：到点发消息和系统通知，排好下一次；不受静默时段影响', async () => {
    const { ctx, posted, notified } = await setup();
    ctx.repo.setSettings({ quietHours: { start: '21:00', end: '08:00' } });
    const r = ctx.repo.addReminder({ title: '背单词', kind: 'remind', prompt: '该背单词啦', repeat: { type: 'daily', time: '22:00' }, createdBy: 'chat', nextAt: at('2026-11-07T22:00:00').toISOString() });
    expect(await ctx.runReminders(at('2026-11-07T21:59:00'))).toBe(0);
    expect(await ctx.runReminders(at('2026-11-07T22:00:05'))).toBe(1);
    expect(posted.at(-1)).toMatchObject({ content: '⏰ 该背单词啦', proactive: true });
    expect(notified).toEqual(['该背单词啦']);
    expect(ctx.repo.getReminder(r.id)!.nextAt).toBe(at('2026-11-08T22:00:00').toISOString());
    expect(await ctx.runReminders(at('2026-11-07T22:00:15'))).toBe(0);
  });

  it('一次性提醒触发后停用；错过超过 12 小时的跳过', async () => {
    const { ctx, posted } = await setup();
    const once = ctx.repo.addReminder({ title: '交表', kind: 'remind', repeat: { type: 'once', at: at('2026-11-08T08:00:00').toISOString() }, createdBy: 'manual', nextAt: at('2026-11-08T08:00:00').toISOString() });
    await ctx.runReminders(at('2026-11-08T08:30:00'));
    expect(posted.at(-1)!.content).toContain('原定 08:00');
    expect(ctx.repo.getReminder(once.id)).toMatchObject({ enabled: false, nextAt: undefined });
    const daily = ctx.repo.addReminder({ title: '早起', kind: 'remind', repeat: { type: 'daily', time: '07:00' }, createdBy: 'manual', nextAt: at('2026-11-05T07:00:00').toISOString() });
    const before = posted.length;
    await ctx.runReminders(at('2026-11-08T09:00:00'));
    expect(posted.length).toBe(before);
    expect(ctx.repo.getReminder(daily.id)!.nextAt).toBe(at('2026-11-09T07:00:00').toISOString());
  });

  it('定时任务：让助理按要求去做，结果作为主动消息，不伪造用户消息', async () => {
    const { ctx, posted, notified, channels } = await setup();
    const chat = vi.fn(async () => ({ content: '本周有 2 个 DDL：……', toolCalls: [] }));
    const llm: LlmClient = { label: 'cloud:fixture', chat };
    ctx.repo.setSettings({ cloud: { baseURL: 'http://127.0.0.1:1/v1', model: 'fixture', apiKey: '' } });
    const router = new ModelRouter(() => ctx.repo.getSettings(), () => llm);
    Object.assign(ctx, { router, agent: new ChatAgent(ctx.repo, router, ctx.hub, channels) });
    ctx.repo.addReminder({ title: '周一汇总', kind: 'task', prompt: '汇总本周 DDL', repeat: { type: 'weekly', time: '08:00', weekdays: [1] }, createdBy: 'chat', nextAt: at('2026-11-09T08:00:00').toISOString() });
    await ctx.runReminders(at('2026-11-09T08:00:10'));
    const reply = posted.at(-1)!;
    expect(reply).toMatchObject({ role: 'assistant', proactive: true });
    expect(reply.content).toBe('⏰ 周一汇总\n\n本周有 2 个 DDL：……');
    expect(ctx.repo.recentMessages(10).some((m) => m.role === 'user')).toBe(false);
    const sent = (chat.mock.calls[0] as unknown as [{ role: string; content: string }[]])[0];
    expect(sent.at(-1)!.content).toContain('汇总本周 DDL');
    expect(notified[0]).toContain('周一汇总');
  });

  it('定时任务没接模型时，退回成提醒', async () => {
    const { ctx, posted } = await setup();
    ctx.repo.addReminder({ title: '周一汇总', kind: 'task', prompt: '汇总本周 DDL', repeat: { type: 'daily', time: '08:00' }, createdBy: 'chat', nextAt: at('2026-11-09T08:00:00').toISOString() });
    await ctx.runReminders(at('2026-11-09T08:00:10'));
    expect(posted.at(-1)!.content).toContain('还没有接上大模型');
  });

  it('对话工具创建、列出、取消', async () => {
    const { ctx } = await setup();
    const created = await ctx.hub.call('fudaner_local__create_reminder', { title: '背单词', kind: 'remind', repeat: 'daily', time: '22:00' });
    expect(created.ok).toBe(true);
    expect(JSON.parse(created.text)).toMatchObject({ schedule: '每天 22:00' });
    const bad = await ctx.hub.call('fudaner_local__create_reminder', { title: 'x', kind: 'remind', repeat: 'once', at: '2020-01-01T08:00:00+08:00' });
    expect(bad.ok).toBe(false);
    const list = JSON.parse((await ctx.hub.call('fudaner_local__list_reminders', {})).text) as { id: string }[];
    expect(list).toHaveLength(1);
    expect((await ctx.hub.call('fudaner_local__cancel_reminder', { id: list[0].id })).ok).toBe(true);
    expect(ctx.repo.listReminders()).toHaveLength(0);
  });
});
