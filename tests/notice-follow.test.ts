import { afterEach, describe, expect, it } from 'vitest';
import { findNoticeSource, suggestNoticeSources } from '../src/main/notices/sources';
import { changeNoticeFollows, enabledNoticeSources, noticeFollowState } from '../src/main/notices/sync';
import { AppContext } from '../src/main/app-context';
import { nullChannels, type Channels } from '../src/main/engine/channels';
import type { ChatMessage } from '../src/shared/types';

/** 官网通知来源：自动按院系、学历、兴趣选择；对话里加减，不用手动一个个勾 */
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const c of cleanups.splice(0)) await c(); });
async function context() {
  const posted: ChatMessage[] = [];
  const channels: Channels = { ...nullChannels, messagePosted: (m) => posted.push(m) };
  const ctx = new AppContext({ dbPath: ':memory:', channels, elearning: () => null, mail: () => null });
  cleanups.push(() => ctx.close());
  await ctx.start();
  return { ctx, posted };
}

describe('自动选择', () => {
  it('院系、学历和兴趣决定关注哪些，附理由', () => {
    const r = suggestNoticeSources({ school: '经济学院', degree: '硕士' }, [
      { type: 'goal', content: '想申请 2027 春季交换' }, { type: 'interest', content: '不关心：体育活动' }, { type: 'interest', content: '在准备雅思' },
    ]);
    expect(r.map((x) => x.id)).toEqual(['jwc', 'econ', 'gs', 'fao', 'cec']);
    expect(r.find((x) => x.id === 'fao')!.why).toContain('交换');
  });

  it('简称也能找到来源', () => {
    expect(findNoticeSource('国交处')?.id).toBe('fao');
    expect(findNoticeSource('经院')?.id).toBe('econ');
    expect(findNoticeSource('计算与智能创新学院')?.id).toBe('ai');
    expect(findNoticeSource('不存在的部门')).toBeUndefined();
  });

  it('记住新的兴趣后，自动选择跟着变', async () => {
    const { ctx } = await context();
    ctx.repo.setProfile({ school: '历史学系' });
    expect(enabledNoticeSources(ctx.repo).map((s) => s.id)).toEqual(['jwc', 'history']);
    ctx.repo.addMemory({ type: 'goal', content: '想去海外交换一学期', source: 'chat' });
    expect(enabledNoticeSources(ctx.repo).map((s) => s.id)).toContain('fao');
  });
});

describe('对话里调整', () => {
  it('工具：看现状、关注 / 取消、改画像', async () => {
    const { ctx } = await context();
    const call = async (tool: string, args: Record<string, unknown> = {}) => { const r = await ctx.hub.call(`fudaner_local__${tool}`, args); expect(r.ok).toBe(true); return JSON.parse(r.text); };
    expect((await call('list_notice_sources')).mode).toBe('auto');
    const profile = await call('update_profile', { school: '经院', degree: '本科' });
    expect(profile.notices).toContain('经济学院');
    const r = await call('follow_notice_sources', { follow: ['国交处', '火星学院'], unfollow: ['教务处'] });
    expect(r).toMatchObject({ added: ['国际合作与交流处'], removed: ['教务处'], unknown: ['火星学院'] });
    expect(noticeFollowState(ctx.repo)).toMatchObject({ mode: 'manual' });
    expect(noticeFollowState(ctx.repo).following.map((s) => s.id)).toEqual(['fao', 'econ']);
    ctx.repo.setSettings({ noticeSources: null });
    expect(noticeFollowState(ctx.repo).mode).toBe('auto');
  });

  it('没接模型时，点「也关注…」按钮也能生效', async () => {
    const { ctx } = await context();
    const reply = await ctx.agent.handleUserMessage('也关注国际合作与交流处（交换、留学）');
    expect(reply.content).toContain('已关注国际合作与交流处');
    expect(changeNoticeFollows(ctx.repo).following).toContain('国际合作与交流处');
  });

  it('首次使用后主动介绍一次，带一点就能加的建议', async () => {
    const { ctx, posted } = await context();
    ctx.repo.setSettings({ onboardingCompleted: true });
    ctx.introduceNoticeSources();
    ctx.introduceNoticeSources();
    const intro = posted.filter((m) => m.trigger === 'notice-intro');
    expect(intro).toHaveLength(1);
    expect(intro[0].content).toContain('教务处');
    expect(intro[0].actions.map((a) => a.label)).toContain('也关注国际合作与交流处（交换、留学）');
  });
});
