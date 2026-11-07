import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppContext } from '../src/main/app-context';
import { FeedCurator } from '../src/main/engine/curator';
import { ProactiveEngine } from '../src/main/engine/engine';
import { ModelRouter, type LlmClient, type LlmMessage } from '../src/main/ai/llm';
import { nullChannels } from '../src/main/engine/channels';
import { parseBingResults, unwrapBingUrl } from '../src/main/sources/web-search';

/** 动态策展：按用户情况挑校园通知 / 活动，联网找资讯（模型和搜索都是假的） */
process.env.TZ = 'Asia/Shanghai';
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const c of cleanups.splice(0)) await c(); });
const NOW = new Date('2026-11-07T10:00:00+08:00');

function setup(reply: (prompt: string) => unknown) {
  const ctx = new AppContext({ dbPath: ':memory:', channels: nullChannels, elearning: () => null, mail: () => null });
  cleanups.push(() => ctx.close());
  const chat = vi.fn(async (messages: LlmMessage[]) => ({ content: JSON.stringify(reply(messages[0].content as string)), toolCalls: [] }));
  const llm: LlmClient = { label: 'cloud:fixture', chat };
  ctx.repo.setSettings({ cloud: { baseURL: 'http://127.0.0.1:1/v1', model: 'fixture', apiKey: '' } });
  const router = new ModelRouter(() => ctx.repo.getSettings(), () => llm);
  return { ctx, router, chat };
}

describe('动态策展', () => {
  it('挑出和用户相关的校园通知、活动，以及联网资讯；不重复', async () => {
    const { ctx, router, chat } = setup((prompt) => {
      if (prompt.includes('挑出对 TA')) {
        const id = prompt.match(/(\S+) \| 活动 \| 机器学习讲座/)![1];
        return { picks: [{ id, summary: '周三下午的机器学习讲座', reason: '和你的 AI 兴趣相关' }, { id: 'not-a-real-id', reason: 'x' }] };
      }
      if (prompt.includes('检索词')) return { queries: ['大模型 进展', '交换 申请'] };
      return { picks: [{ id: '0', summary: '一周大模型进展汇总', reason: '你关心 AI' }] };
    });
    ctx.repo.setProfile({ school: '计算与智能创新学院' });
    ctx.repo.addMemory({ type: 'interest', content: '对 AI 方向的讲座感兴趣', source: 'manual' });
    ctx.repo.upsertItem({ source: 'notice', kind: 'activity', sourceId: 'a1', title: '机器学习讲座', body: '', url: 'https://ai.fudan.edu.cn/a1', publishedAt: NOW.toISOString(), done: false, activity: { startsAt: '2026-11-11T06:00:00.000Z', location: '光华楼' } });
    ctx.repo.upsertItem({ source: 'notice', kind: 'activity', sourceId: 'a2', title: '合唱音乐会', body: '', url: 'https://x/a2', publishedAt: NOW.toISOString(), done: false, activity: { startsAt: '2026-11-12T11:00:00.000Z' } });
    const search = vi.fn(async (q: string) => [{ title: `${q} 周报`, url: `https://news.example.com/${encodeURIComponent(q)}`, snippet: `${q} 的最新消息`, site: 'example.com' }]);
    const curator = new FeedCurator({ repo: ctx.repo, router, channels: nullChannels, search });
    const r = await curator.run(NOW);
    expect(r).toEqual({ campus: 1, news: 1 });
    const cards = ctx.repo.listFeed();
    expect(cards.find((c) => c.type === 'opportunity')).toMatchObject({ title: '机器学习讲座', reason: '和你的 AI 兴趣相关' });
    const news = cards.find((c) => c.type === 'news')!;
    expect(news.actions.find((a) => a.action === 'open_url')?.payload?.url).toBe('https://news.example.com/%E5%A4%A7%E6%A8%A1%E5%9E%8B%20%E8%BF%9B%E5%B1%95');
    expect(search).toHaveBeenCalledTimes(2);
    // 发给搜索引擎的只有检索词；给模型的用户情况里有兴趣
    expect(String(chat.mock.calls[0][0][0].content)).toContain('对 AI 方向的讲座感兴趣');
    // 4 小时内不重复跑；强制刷新时已经推过的不再推
    expect((await curator.run(new Date(NOW.getTime() + 3_600_000))).skipped).toBe('还没到时间');
    const again = await curator.run(new Date(NOW.getTime() + 3_600_000), { force: true });
    expect(again).toEqual({ campus: 0, news: 0 });
  });

  it('关掉联网后只整理校园部分；夜里不跑；没有模型时跳过', async () => {
    const { ctx, router } = setup(() => ({ picks: [] }));
    ctx.repo.setSettings({ webCuration: false });
    const search = vi.fn(async () => []);
    const curator = new FeedCurator({ repo: ctx.repo, router, channels: nullChannels, search });
    await curator.run(NOW, { force: true });
    expect(search).not.toHaveBeenCalled();
    expect(curator.due(new Date('2026-11-08T02:00:00+08:00'))).toBe(false);
    const noModel = new FeedCurator({ repo: ctx.repo, router: new ModelRouter(() => ({ demoMode: false, quietHours: { start: '23:00', end: '07:00' } })), channels: nullChannels, search });
    expect((await noModel.run(NOW, { force: true })).skipped).toBe('没有配置模型');
  });

  it('只有云端模型时，学校通知和活动也用模型研判（不再只靠关键词）', async () => {
    const { ctx, router, chat } = setup(() => ({ value: 0.6, urgency: 0.3, action: 'card', message_draft: '经院有个讲座', reason: '和你的专业相关' }));
    ctx.repo.addTrigger({ source: 'notice', kind: 'notice_new', sourceRef: 'n1', threadKey: 'notice:econ', payload: { title: '经济学前沿讲座', sourceName: '经济学院' } });
    const engine = new ProactiveEngine(ctx.repo, router, nullChannels);
    const [ev] = await engine.evaluatePending(NOW);
    expect(ev.modelUsed).toBe('cloud:fixture');
    expect(chat).toHaveBeenCalled();
    // 邮件仍然不交给云端模型研判
    ctx.repo.addTrigger({ source: 'mail', kind: 'mail_new', sourceRef: 'm1', threadKey: 'mail:1', payload: { subject: 'x', category: 'notice' } });
    const [mailEv] = await engine.evaluatePending(NOW);
    expect(mailEv.modelUsed).toBe('rules');
  });
});

describe('搜索结果解析', () => {
  it('必应结果和跳转链接', () => {
    const real = 'https://news.example.com/a?b=1';
    const wrapped = `https://www.bing.com/ck/a?!&&p=x&u=a1${Buffer.from(real).toString('base64').replace(/=+$/, '')}&ntb=1`;
    expect(unwrapBingUrl(wrapped)).toBe(real);
    const html = `<ol><li class="b_algo"><h2><a href="${wrapped}">大模型周报</a></h2><div class="b_caption"><p>2026年11月5日 · 本周大模型进展</p></div></li><li class="b_algo"><h2><a href="https://www.bing.com/search?q=x">相关搜索</a></h2></li></ol>`;
    expect(parseBingResults(html)).toEqual([{ title: '大模型周报', url: real, snippet: '本周大模型进展', date: '2026年11月5日', site: 'news.example.com' }]);
  });
});
