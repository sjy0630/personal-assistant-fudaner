import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MailClient, MailMessage } from '@fudaner/mcp-fudan-mail';
import { AppContext } from '../src/main/app-context';
import { nullChannels, type Channels } from '../src/main/engine/channels';

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

async function setup() {
  const notified: string[] = [];
  const channels: Channels = { ...nullChannels, notify: (_t, body) => notified.push(body) };
  const fake = new FakeMail();
  const ctx = new AppContext({ dbPath: ':memory:', channels, elearning: () => null, mail: () => fake });
  cleanups.push(() => ctx.close());
  ctx.repo.setSettings({ quietHours: { start: '03:00', end: '03:01' } });
  // 固定为平常周：提醒门槛随学期阶段变化，不固定的话结果取决于跑测试的日期
  ctx.repo.setKv('phase_override', 'regular');
  await ctx.start();
  return { ctx, fake, notified };
}

describe('邮件推送', () => {
  it('新邮件到达 → 8 秒内同步 → 需要回复的邮件弹通知', async () => {
    const { ctx, fake, notified } = await setup();
    await ctx.syncMailNow();
    await ctx.restartWatchers();
    expect(ctx.realtimeStatus().mail).toBe('watching');
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    fake.inbox.push(mail('1', '组会时间能改吗？请回复'));
    fake.onNew!();
    fake.onNew!(); // 同一批合并成一次同步
    const before = fake.fetches;
    await vi.advanceTimersByTimeAsync(8000);
    vi.useRealTimers();
    await vi.waitFor(() => expect(fake.fetches).toBe(before + 1));
    await vi.waitFor(() => expect(ctx.repo.listItems({ kind: 'email' })).toHaveLength(1));
    await vi.waitFor(() => expect(notified.some((n) => n.includes('需要你回复'))).toBe(true));
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
