import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MailClient, MailMessage } from '@fudaner/mcp-fudan-mail';
import { AppContext } from '../src/main/app-context';
import { nullChannels, type Channels } from '../src/main/engine/channels';
import type { SemesterPhase } from '../src/shared/types';

/** 实时：新邮件推送后马上同步并提醒；问邮件时先确认是最新的 */
process.env.TZ = 'Asia/Shanghai';
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { vi.useRealTimers(); for (const c of cleanups.splice(0)) await c(); });

class FakeMail implements MailClient {
  inbox: MailMessage[] = [];
  fetches = 0;
  onNew?: () => void;
  async ping() { return true; }
  async fetchSince() { this.fetches++; return this.inbox; }
  watch(onNew: () => void, onState?: (s: 'watching' | 'reconnecting' | 'stopped') => void) {
    this.onNew = onNew;
    onState?.('watching');
    return async () => { this.onNew = undefined; onState?.('stopped'); };
  }
}
const mail = (uid: string, subject: string): MailMessage => ({
  uid, subject, from: { name: '小李', address: 'li@m.fudan.edu.cn' }, to: ['me@m.fudan.edu.cn'], date: new Date().toISOString(),
  text: '你好，下周组会能不能改到周三？麻烦回复一下我。',
});

async function setup(phase: SemesterPhase = 'regular') {
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
  vi.setSystemTime(new Date('2026-11-10T15:00:00+08:00'));
  const notified: string[] = [];
  const channels: Channels = { ...nullChannels, notify: (_t, body) => notified.push(body) };
  const fake = new FakeMail();
  const ctx = new AppContext({ dbPath: ':memory:', channels, elearning: () => null, mail: () => fake });
  cleanups.push(() => ctx.close());
  ctx.repo.setSettings({ quietHours: { start: '03:00', end: '03:01' } });
  ctx.repo.setKv('phase_override', phase);
  await ctx.start();
  return { ctx, fake, notified };
}

describe('邮件推送', () => {
  it.each(['regular', 'midterm', 'pre_exam'] as const)('%s：新邮件推送合并为一次同步，8 秒后需要回复的邮件弹通知', async (phase) => {
    const { ctx, fake, notified } = await setup(phase);
    await ctx.syncMailNow();
    await ctx.restartWatchers();
    expect(ctx.realtimeStatus().mail).toBe('watching');
    fake.inbox.push(mail('1', '组会时间能改吗？请回复'));
    fake.onNew!();
    fake.onNew!(); // 同一批合并成一次同步
    const before = fake.fetches;
    await vi.advanceTimersByTimeAsync(7999);
    expect(fake.fetches).toBe(before);
    await vi.advanceTimersByTimeAsync(1);
    await vi.waitFor(() => expect(fake.fetches).toBe(before + 1));
    await vi.waitFor(() => expect(ctx.repo.listItems({ kind: 'email' })).toHaveLength(1));
    await vi.waitFor(() => expect(notified.some((n) => n.includes('需要你回复'))).toBe(true));
    expect(notified.filter((n) => n.includes('需要你回复'))).toHaveLength(1);
  });

  it('静默时段的回复邮件先同步但不弹通知，留入摘要', async () => {
    const { ctx, fake, notified } = await setup();
    ctx.repo.setSettings({ quietHours: { start: '14:00', end: '16:00' } });
    fake.inbox.push(mail('quiet', '需要回复的组会邮件'));
    await ctx.syncMailNow();
    expect(ctx.repo.listItems({ kind: 'email' })).toHaveLength(1);
    expect(ctx.repo.listEvals().some((e) => e.decision === 'digest' && e.reason.includes('静默'))).toBe(true);
    expect(notified).toEqual([]);
  });

  it('当天提醒预算耗尽时，回复邮件不绕过预算弹通知', async () => {
    const { ctx, fake, notified } = await setup();
    await ctx.syncMailNow();
    ctx.repo.getBudget('2026-11-10', () => ({ budget: 10, phase: 'regular' }));
    ctx.repo.spendBudget('2026-11-10', 100);
    fake.inbox.push(mail('budget', '需要回复的组会邮件'));
    await ctx.syncMailNow();
    expect(ctx.repo.listItems({ kind: 'email' })).toHaveLength(1);
    expect(ctx.repo.listEvals().some((e) => e.reason.includes('预算不足'))).toBe(true);
    expect(notified).toEqual([]);
  });

  it('推送连不上时每 3 分钟查一次；连上时不轮询', async () => {
    const { ctx, fake } = await setup();
    await ctx.pollRealtime();
    expect(fake.fetches).toBe(1);
    await ctx.pollRealtime();
    expect(fake.fetches).toBe(1);
    await ctx.pollRealtime(new Date(Date.now() + 4 * 60_000));
    expect(fake.fetches).toBe(2);
    await ctx.restartWatchers();
    await ctx.pollRealtime(new Date(Date.now() + 60 * 60_000));
    expect(fake.fetches).toBe(2);
  });
});

describe('问的时候是最新的', () => {
  it('超过 2 分钟没同步，查邮件前先同步', async () => {
    const { ctx, fake } = await setup();
    fake.inbox.push(mail('9', '刚发来的邮件'));
    const r = JSON.parse((await ctx.hub.call('fudan_mail__search_mail', {})).text) as { subject: string }[];
    expect(r.map((m) => m.subject)).toContain('刚发来的邮件');
    const n = fake.fetches;
    await ctx.hub.call('fudan_mail__search_mail', {});
    expect(fake.fetches).toBe(n);
  });
});
