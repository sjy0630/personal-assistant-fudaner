import { afterEach, describe, expect, it, vi } from 'vitest';
import { checkPublicUrl, isWechatVerifyPage, parseArticle, parseFeed, type Article } from '../src/main/activities/article';
import { extractActivities, guessCampus, guessCategory, parseChineseTime, ruleExtract } from '../src/main/activities/extract';
import { importArticle, syncFeeds, type FetchText } from '../src/main/activities/sync';
import type { LlmClient, ModelRouter } from '../src/main/ai/llm';
import { AppContext } from '../src/main/app-context';
import { seedDemoProfile } from '../src/main/demo/demo';
import { DEMO_ARTICLE_URL } from '../src/main/demo/demo-activities';
import { nullChannels } from '../src/main/engine/channels';
import { heuristic, memoryMatches } from '../src/main/engine/assess';
import type { Memory, Trigger } from '../src/shared/types';

/**
 * 校园活动：从公众号文章、RSS 订阅源里提取活动，按兴趣和目标推荐。
 * 所有页面都是测试里写的虚构内容。
 */
const NOW = new Date('2026-11-07T10:00:00+08:00');

const wechat = (body: string[], extra = '') => `<!doctype html><html><head>
<meta property="og:title" content="讲座预告｜大模型与科学发现">
<script>var nickname = htmlDecode("某学院学生会"); var ct = "1794016800";</script></head>
<body><h1 id="activity-name">讲座预告｜大模型与科学发现</h1>${extra}
<div class="rich_media_content" id="js_content"><section><p>${body.join('</p><p>')}</p><div><p>嵌套段落</p></div></section></div>
<div id="js_pc_qr_code">二维码</div></body></html>`;

const lecture = wechat([
  '本期讲座邀请青年学者分享大模型在材料科学中的应用。',
  '时间：11月12日（周三）14:00-16:00',
  '地点：光华楼东主楼 1801',
  '主讲人：林知远',
  '报名方式：无需报名',
]);

describe('读取文章', () => {
  it('公众号文章：标题、公众号名、发布时间、正文', () => {
    const a = parseArticle(lecture, 'https://mp.weixin.qq.com/s/abc');
    expect(a.title).toBe('讲座预告｜大模型与科学发现');
    expect(a.sourceName).toBe('某学院学生会');
    expect(a.publishedAt).toBe(new Date(1794016800 * 1000).toISOString());
    expect(a.text).toContain('地点：光华楼东主楼 1801');
    expect(a.text).toContain('嵌套段落');
    expect(a.text).not.toContain('二维码');
  });

  it('普通网页取正文区域', () => {
    const html = '<html><head><title>学术报告：量子计算前沿</title></head><body><nav>首页 新闻</nav><div class="v_news_content"><p>报告时间：2026年11月20日 15:00</p><p>报告地点：江湾校区交叉学科楼 2001</p><p>欢迎感兴趣的师生参加，本次报告将介绍量子计算的最新进展与未来方向。</p></div><footer>版权所有</footer></body></html>';
    const a = parseArticle(html, 'https://physics.example.edu.cn/info/1.htm');
    expect(a.title).toBe('学术报告：量子计算前沿');
    expect(a.text).toContain('报告地点：江湾校区交叉学科楼 2001');
    expect(a.text).not.toContain('版权所有');
  });

  it('识别微信的验证页面', () => {
    expect(isWechatVerifyPage('<html><body>环境异常，完成验证后即可继续访问</body></html>')).toBe(true);
    expect(isWechatVerifyPage(lecture)).toBe(false);
  });

  it('RSS 和 Atom', () => {
    const rss = parseFeed(`<?xml version="1.0"?><rss version="2.0"><channel><title>某学院</title>
      <item><title><![CDATA[讲座 &amp; 沙龙]]></title><link>https://mp.weixin.qq.com/s/1</link><guid>g1</guid><pubDate>Fri, 06 Nov 2026 02:00:00 GMT</pubDate><description><![CDATA[<p>时间：11月9日</p>]]></description></item>
      <item><title>第二篇</title><link>https://mp.weixin.qq.com/s/2</link></item></channel></rss>`);
    expect(rss.title).toBe('某学院');
    expect(rss.entries).toHaveLength(2);
    expect(rss.entries[0]).toMatchObject({ id: 'g1', title: '讲座 & 沙龙', link: 'https://mp.weixin.qq.com/s/1', publishedAt: '2026-11-06T02:00:00.000Z' });
    expect(rss.entries[0].html).toContain('时间：11月9日');
    expect(rss.entries[1].id).toBe('https://mp.weixin.qq.com/s/2');

    const atom = parseFeed(`<feed xmlns="http://www.w3.org/2005/Atom"><title>某网站</title><entry><id>tag:1</id><title>宣讲会</title>
      <link rel="alternate" href="https://example.com/a"/><published>2026-11-05T08:00:00Z</published><content type="html">&lt;p&gt;正文&lt;/p&gt;</content></entry></feed>`);
    expect(atom.entries[0]).toMatchObject({ id: 'tag:1', title: '宣讲会', link: 'https://example.com/a', html: '<p>正文</p>' });
  });

  it('不读取本机和内网地址', () => {
    for (const url of ['http://localhost:3000', 'http://127.0.0.1/', 'http://192.168.1.1/', 'http://10.0.0.2/', 'file:///etc/passwd', 'https://user:pw@example.com/']) {
      expect(() => checkPublicUrl(url)).toThrow();
    }
    expect(checkPublicUrl('https://mp.weixin.qq.com/s/abc').hostname).toBe('mp.weixin.qq.com');
  });
});

describe('提取活动', () => {
  it('中文时间写法', () => {
    const ref = new Date('2026-11-07T10:00:00+08:00');
    expect(parseChineseTime('11月12日（周三）14:00-16:00', ref)).toEqual({ start: '2026-11-12T06:00:00.000Z', end: '2026-11-12T08:00:00.000Z' });
    expect(parseChineseTime('2026年11月20日 下午3点半', ref).start).toBe('2026-11-20T07:30:00.000Z');
    expect(parseChineseTime('1月5日 晚上7:00', ref).start).toBe('2027-01-05T11:00:00.000Z');
    expect(parseChineseTime('11月12日', ref).start).toBe('2026-11-11T16:00:00.000Z');
    expect(parseChineseTime('待定', ref)).toEqual({});
  });

  it('校区和类别', () => {
    expect(guessCampus('光华楼东主楼 1801')).toBe('邯郸');
    expect(guessCampus('枫林校区明道楼')).toBe('枫林');
    expect(guessCampus('腾讯会议 123')).toBe('线上');
    expect(guessCategory('某公司 2027 校园招聘宣讲会')).toBe('就业');
    expect(guessCategory('学术讲座')).toBe('讲座');
  });

  it('规则提取「时间：」「地点：」写法；活动回顾不算活动', () => {
    const a = parseArticle(lecture, 'https://mp.weixin.qq.com/s/abc');
    const r = ruleExtract(a, NOW)!;
    expect(r).toMatchObject({ timeText: '11月12日（周三）14:00-16:00', location: '光华楼东主楼 1801', speaker: '林知远', signup: '无需报名', startsAt: '2026-11-12T06:00:00.000Z' });
    expect(ruleExtract({ ...a, title: '回顾｜讲座圆满落幕' }, NOW)).toBeUndefined();
    expect(ruleExtract({ ...a, text: '这是一篇普通的新闻，没有时间地点。' }, NOW)).toBeUndefined();
  });

  it('模型提取多场活动，并清洗字段', async () => {
    const llm: LlmClient = { label: 'cloud:fixture', chat: vi.fn(async () => ({ toolCalls: [], content: JSON.stringify({ activities: [
      { title: '大模型与科学发现', starts_at: '2026-11-12T14:00:00+08:00', location: '光华楼东主楼 1801', campus: '邯郸', category: '讲座', summary: '青年学者分享' },
      { title: '读书会', starts_at: '下周', location: '腾讯会议', campus: '火星', category: '奇怪的类别' },
    ] }) })) };
    const a = parseArticle(lecture, 'https://mp.weixin.qq.com/s/abc');
    const { activities, model } = await extractActivities(a, llm, NOW);
    expect(model).toBe('cloud:fixture');
    expect(activities[0]).toMatchObject({ title: '大模型与科学发现', startsAt: '2026-11-12T06:00:00.000Z', campus: '邯郸', category: '讲座', sourceName: '某学院学生会' });
    expect(activities[1]).toMatchObject({ title: '读书会', startsAt: undefined, campus: '线上', category: '其他' });
    const prompt = (llm.chat as ReturnType<typeof vi.fn>).mock.calls[0][0][0].content as string;
    expect(prompt).toContain('<external_data');
  });

  it('模型输出不合法时退回规则', async () => {
    const llm: LlmClient = { label: 'local:bad', chat: async () => ({ content: '不是 JSON', toolCalls: [] }) };
    const { activities, model } = await extractActivities(parseArticle(lecture, 'https://mp.weixin.qq.com/s/abc'), llm, NOW);
    expect(model).toBe('rules');
    expect(activities).toHaveLength(1);
  });
});

describe('导入与订阅', () => {
  const cleanups: (() => Promise<void>)[] = [];
  afterEach(async () => { for (const c of cleanups.splice(0)) await c(); });
  const context = () => {
    const ctx = new AppContext({ dbPath: ':memory:', channels: nullChannels, elearning: () => null, mail: () => null });
    cleanups.push(() => ctx.close());
    return ctx;
  };
  const noModel = { for: () => null } as unknown as ModelRouter;
  const pages = (map: Record<string, string>): FetchText => async (url) => (map[url] ? { url, status: 200, text: map[url] } : { url, status: 404, text: '' });

  it('导入公众号文章：保存活动、进入主动引擎；重复导入不重复', async () => {
    const { repo } = context();
    const url = 'https://mp.weixin.qq.com/s?__biz=MzA&mid=1&idx=1&sn=abc&chksm=x&scene=21';
    const fetchText = pages({ [url]: lecture, 'https://mp.weixin.qq.com/s?__biz=MzA&mid=1&idx=1&sn=abc&scene=99': lecture });
    const r = await importArticle({ repo, router: noModel, fetchText }, url, { now: NOW });
    expect(r.activities).toHaveLength(1);
    expect(r.activities[0].activity).toMatchObject({ location: '光华楼东主楼 1801', campus: '邯郸', category: '讲座', sourceName: '某学院学生会' });
    expect(repo.pendingTriggers().filter((t) => t.kind === 'activity_new')).toHaveLength(1);
    // 同一篇文章换了跟踪参数，仍是同一场活动
    await importArticle({ repo, router: noModel, fetchText }, 'https://mp.weixin.qq.com/s?__biz=MzA&mid=1&idx=1&sn=abc&scene=99', { now: NOW });
    expect(repo.listActivities()).toHaveLength(1);
    expect(repo.pendingTriggers().filter((t) => t.kind === 'activity_new')).toHaveLength(1);
  });

  it('已经结束的活动保存但不推荐', async () => {
    const { repo } = context();
    const url = 'https://mp.weixin.qq.com/s/old';
    const r = await importArticle({ repo, router: noModel, fetchText: pages({ [url]: lecture }) }, url, { now: new Date('2026-11-20T10:00:00+08:00') });
    expect(r.past).toBe(1);
    expect(repo.pendingTriggers().filter((t) => t.kind === 'activity_new')).toHaveLength(0);
  });

  it('读不到正文时给出能看懂的原因', async () => {
    const { repo } = context();
    const verify = 'https://mp.weixin.qq.com/s/verify';
    const fetchText = pages({ [verify]: '<html>环境异常，完成验证后即可继续访问</html>' });
    await expect(importArticle({ repo, router: noModel, fetchText }, verify, { now: NOW })).rejects.toThrow('验证');
    await expect(importArticle({ repo, router: noModel, fetchText }, 'https://mp.weixin.qq.com/s/missing', { now: NOW })).rejects.toThrow('不存在');
    await expect(importArticle({ repo, router: noModel, fetchText }, 'http://127.0.0.1/admin', { now: NOW })).rejects.toThrow('内网');
  });

  it('订阅源：首次只看最近 7 天，之后只处理新条目', async () => {
    const { repo } = context();
    const feedUrl = 'https://rss.example.com/college.xml';
    const entry = (id: string, days: number) => `<item><title>讲座 ${id}</title><link>https://mp.weixin.qq.com/s/${id}</link><guid>${id}</guid><pubDate>${new Date(NOW.getTime() - days * 86_400_000).toUTCString()}</pubDate></item>`;
    let xml = `<rss><channel><title>某学院</title>${entry('new', 1)}${entry('old', 30)}</channel></rss>`;
    const fetched: string[] = [];
    const fetchText: FetchText = async (url) => {
      fetched.push(url);
      if (url === feedUrl) return { url, status: 200, text: xml };
      return { url, status: 200, text: lecture.replace('大模型与科学发现', `大模型与科学发现 ${url.slice(-3)}`) };
    };
    const first = await syncFeeds({ repo, router: noModel, fetchText }, [{ url: feedUrl }], NOW);
    expect(first).toMatchObject({ entries: 1, errors: [] });
    expect(fetched).toEqual([feedUrl, 'https://mp.weixin.qq.com/s/new']);
    xml = xml.replace('</channel>', `${entry('next', 0)}</channel>`);
    fetched.length = 0;
    const second = await syncFeeds({ repo, router: noModel, fetchText }, [{ url: feedUrl }], NOW);
    expect(second.entries).toBe(1);
    expect(fetched).toEqual([feedUrl, 'https://mp.weixin.qq.com/s/next']);
  });

  it('订阅地址不是 RSS 时报错', async () => {
    const { repo } = context();
    const r = await syncFeeds({ repo, router: noModel, fetchText: async (url) => ({ url, status: 200, text: '<html>普通网页</html>' }) }, [{ url: 'https://example.com/', name: '某网站' }], NOW);
    expect(r.errors[0]).toContain('不是 RSS');
  });
});

describe('按兴趣和目标推荐', () => {
  const memory = (type: Memory['type'], content: string): Memory => ({ id: content, type, content, source: 'manual', pinned: false, createdAt: '', updatedAt: '' });
  const trigger = (payload: Record<string, unknown>): Trigger => ({ id: 't', source: 'notice', kind: 'activity_new', sourceRef: 'x', threadKey: 'activity:x', payload, occurredAt: '', disposition: 'pending' });
  const describe_ = () => '';

  it('匹配兴趣推到动态；「讲座」这种宽泛词不算匹配', () => {
    const memories = [memory('interest', '对 AI 方向的讲座感兴趣')];
    const ai = heuristic([trigger({ title: '大模型与 AI for Science 讲座', category: '讲座' })], { memories, phase: 'regular', describe: describe_ });
    expect(ai).toMatchObject({ action: 'card' });
    expect(ai.reason).toContain('兴趣');
    const history = heuristic([trigger({ title: '宋代史学讲座', category: '讲座' })], { memories, phase: 'regular', describe: describe_ });
    expect(history.action).toBe('record');
  });

  it('年份不算匹配，拆开的中文词片段算', () => {
    expect(memoryMatches('想申请 2027 春季交换', '2027 届校园招聘宣讲会')).toBe(false);
    expect(memoryMatches('想申请 2027 春季交换', '2027 春季学期赴某大学交换项目报名通知')).toBe(true);
    expect(memoryMatches('对 AI 方向的讲座感兴趣', '请查收 email 附件')).toBe(false);
    expect(memoryMatches('对 AI 方向的讲座感兴趣', '欢迎对 AI 感兴趣的同学参加')).toBe(true);
  });

  it('匹配长期目标', () => {
    const r = heuristic([trigger({ title: '2027 春季交换项目说明会' })], { memories: [memory('goal', '想申请 2027 春季交换')], phase: 'regular', describe: describe_ });
    expect(r.reason).toContain('目标');
  });

  it('演示模式：同步后在动态里推荐活动，可以加入计划', async () => {
    const ctx = new AppContext({ dbPath: ':memory:', channels: nullChannels, elearning: () => null, mail: () => null });
    try {
      ctx.repo.setSettings({ demoMode: true, quietHours: { start: '03:00', end: '03:01' } });
      seedDemoProfile(ctx.repo);
      await ctx.start();
      const r = await ctx.syncAll();
      expect(r.errors).toEqual([]);
      expect(ctx.repo.listActivities().length).toBeGreaterThanOrEqual(4);
      await ctx.engine.tick();
      const cards = ctx.repo.listFeed('opportunity');
      const titles = cards.map((c) => c.title);
      expect(titles.some((t) => t.includes('大模型'))).toBe(true);
      expect(titles.some((t) => t.includes('春季交换'))).toBe(true);
      expect(titles.some((t) => t.includes('合唱'))).toBe(false);
      const card = cards.find((c) => c.title.includes('大模型'))!;
      const add = card.actions.find((a) => a.action === 'add_to_plan')!;
      const task = ctx.repo.addActivityToPlan(String(add.payload?.itemId))!;
      expect(task.title).toContain('参加：');
      expect(ctx.repo.listGoals().some((g) => g.title === '校园活动')).toBe(true);
      // 演示文章也能从对话里导入
      const imported = await ctx.importArticle(DEMO_ARTICLE_URL);
      expect(imported.activities[0].title).toContain('大模型');
      await expect(ctx.importArticle('https://mp.weixin.qq.com/s/real')).rejects.toThrow('演示模式');
    } finally {
      await ctx.close();
    }
  });
});

describe('文章对象', () => {
  it('Article 类型可以手动构造（订阅源自带正文时）', () => {
    const a: Article = { url: 'https://example.com', title: 't', text: '时间：11月9日 19:00\n地点：相辉堂' };
    expect(ruleExtract(a, NOW)).toMatchObject({ location: '相辉堂' });
  });
});
