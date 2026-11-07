import { afterEach, describe, expect, it } from 'vitest';
import { findDate, parseNoticeDetail, parseNoticeList } from '../src/main/notices/parse';
import { defaultNoticeSources, ownSchoolSources, NOTICE_SOURCES, type NoticeSource } from '../src/main/notices/sources';
import { syncNotices } from '../src/main/notices/sync';
import type { FetchText } from '../src/main/activities/sync';
import type { ModelRouter } from '../src/main/ai/llm';
import { AppContext } from '../src/main/app-context';
import { seedDemoProfile } from '../src/main/demo/demo';
import { nullChannels } from '../src/main/engine/channels';
import { heuristic } from '../src/main/engine/assess';
import type { Memory, Trigger } from '../src/shared/types';

/** 下面的页面是按复旦各网站真实结构写的小样例，内容虚构 */
const NOW = new Date('2026-11-07T10:00:00+08:00');

describe('通知列表：各网站的写法', () => {
  it('建站系统常见列表：标题链接 + 日期 span', () => {
    const html = `<ul class="news_list"><li class="news"><span class="news_title"><a href="/2f/57/c1a1/page.htm" title="关于期中退课的通知">关于期中退课的通知</a></span><span class="news_meta">2026-10-27</span></li>
      <li class="news"><span class="news_title"><a href="/2f/58/c1a2/page.htm" title="寒假项目申请通知（2026/11/06更新）">寒假项目申请通知（2026/11/06更新）</a></span><span class="news_meta">2026-10-23</span></li></ul>
      <div class="nav"><li><a href="/">首页</a><a href="/about">概况</a></li></div>`;
    expect(parseNoticeList(html, 'https://jwc.fudan.edu.cn/9397/list.htm')).toEqual([
      { url: 'https://jwc.fudan.edu.cn/2f/57/c1a1/page.htm', title: '关于期中退课的通知', date: '2026-10-27' },
      { url: 'https://jwc.fudan.edu.cn/2f/58/c1a2/page.htm', title: '寒假项目申请通知（2026/11/06更新）', date: '2026-10-23' },
    ]);
  });

  it('日和年月拆在两个元素里', () => {
    const html = `<li class="news n2 clearfix"><div class="news_date"><div class="news_days">12</div><div class="news_year">2026.10</div></div><div class="news_title"><a href='/1d/82/c2a3/page.htm' title='推免生招生选拔工作通知'>推免生招生选拔工作通知</a></div></li>`;
    expect(parseNoticeList(html, 'https://ai.fudan.edu.cn/24257/list.htm')[0]).toMatchObject({ title: '推免生招生选拔工作通知', date: '2026-10-12' });
  });

  it('整行都在链接里，日期也在链接里', () => {
    const html = `<ul class="data-list2"><li><a href="/Data/View/7067"><div class="data-date"><span>24</span><p>2026-09</p></div><div class="data-tt"><p>推免研究生第二轮报名通知</p></div></a></li></ul>`;
    expect(parseNoticeList(html, 'https://fit.fudan.edu.cn/Data/List/event')[0]).toEqual({ url: 'https://fit.fudan.edu.cn/Data/View/7067', title: '推免研究生第二轮报名通知', date: '2026-09-24' });
  });

  it('链接里有日期、标题和摘要，摘要里的年份不干扰', () => {
    const html = `<li><a href="../info/1404/22452.htm" title="青年学术奖开放申请"><span>2026-09-30</span><h3>青年学术奖开放申请</h3><p>2025年5月，校友捐赠设立基金，现启动申请……</p></a></li>`;
    expect(parseNoticeList(html, 'https://history.fudan.edu.cn/xwzx/tzgg.htm')[0]).toEqual({ url: 'https://history.fudan.edu.cn/info/1404/22452.htm', title: '青年学术奖开放申请', date: '2026-09-30' });
  });

  it('表格行；附件和外站链接不算通知', () => {
    const html = `<table><tr><td><a href="/info/1.htm">关于奖学金评选的通知</a></td><td>2026年11月5日</td></tr>
      <tr><td><a href="/files/a.pdf">附件下载说明文件</a></td><td>2026-11-05</td></tr>
      <tr><td><a href="https://example.com/x">外站链接的一条新闻</a></td><td>2026-11-05</td></tr></table>`;
    expect(parseNoticeList(html, 'https://econ.fudan.edu.cn/list.htm')).toEqual([{ url: 'https://econ.fudan.edu.cn/info/1.htm', title: '关于奖学金评选的通知', date: '2026-11-05' }]);
  });

  it('日期识别', () => {
    expect(findDate('2026-1-5')).toBe('2026-01-05');
    expect(findDate('2026年11月5日')).toBe('2026-11-05');
    expect(findDate('2026-02-30')).toBeUndefined();
    expect(findDate('2026-11-05 至 2026-11-08')).toBeNull();
    expect(findDate('05 2026-11')).toBe('2026-11-05');
  });
});

describe('通知详情', () => {
  it('正文、发布日期、PDF 附件', () => {
    const d = parseNoticeDetail(`<html><head><title>某某通知-复旦大学</title></head><body><header><a href="/">首页</a></header>
      <h1 class="arti_title">推免生招生选拔工作通知</h1><p class="arti_metas">作者：发布时间：2026-10-08</p>
      <div class="wp_articlecontent"><p><div pdfsrc="/_upload/x/notice.pdf" sudyfile-attr="{'title':'推免通知.pdf'}" class="wp_pdf_player"></div></p></div></body></html>`, 'https://ai.fudan.edu.cn/1a/fa/c1/page.htm');
    expect(d).toMatchObject({ title: '推免生招生选拔工作通知', date: '2026-10-08', attachments: [{ name: '推免通知.pdf', url: 'https://ai.fudan.edu.cn/_upload/x/notice.pdf' }] });
  });

  it('「发布日期：」写在正文外', () => {
    const d = parseNoticeDetail(`<div class="art-tit"><h3>青年学术奖开放申请</h3><p><span>发布日期：2026-09-30</span></p></div><div id="vsb_content"><div class="v_news_content"><p>现启动本年度青年学术奖的申请和评选工作，欢迎符合条件的老师申请。</p></div></div>`, 'https://history.fudan.edu.cn/info/1404/22452.htm');
    expect(d.title).toBe('青年学术奖开放申请');
    expect(d.date).toBe('2026-09-30');
    expect(d.text).toContain('启动本年度');
  });
});

describe('来源', () => {
  it('从用户画像认出本人院系', () => {
    expect(ownSchoolSources('计算与智能创新学院').map((s) => s.id)).toEqual(['ai']);
    expect(ownSchoolSources('经济学院').map((s) => s.id)).toEqual(['econ']);
    expect(ownSchoolSources('历史系').map((s) => s.id)).toEqual(['history']);
    expect(defaultNoticeSources({ school: '历史学系', degree: '硕士' })).toEqual(['jwc', 'gs', 'history']);
    expect(defaultNoticeSources({})).toEqual(['jwc']);
    expect(new Set(NOTICE_SOURCES.map((s) => s.id)).size).toBe(NOTICE_SOURCES.length);
  });
});

describe('同步', () => {
  const cleanups: (() => Promise<void>)[] = [];
  afterEach(async () => { for (const c of cleanups.splice(0)) await c(); });
  const noModel = { for: () => null } as unknown as ModelRouter;
  const source: NoticeSource = { id: 'ai', name: '计算与智能创新学院', url: 'https://ai.fudan.edu.cn/24257/list.htm', group: '院系' };
  const row = (id: string, title: string, date: string) => `<li class="news"><span class="news_title"><a href="/n/${id}/page.htm" title="${title}">${title}</a></span><span class="news_meta">${date}</span></li>`;
  const detail = (text: string) => `<div class="wp_articlecontent"><p>${text}</p></div>`;

  it('第一次只推最近 3 天；讲座整理成活动；读不到详情时只留标题', async () => {
    const ctx = new AppContext({ dbPath: ':memory:', channels: nullChannels, elearning: () => null, mail: () => null });
    cleanups.push(() => ctx.close());
    ctx.repo.setProfile({ school: '计算与智能创新学院' });
    let list = `<ul>${row('a', '关于本科生选课的通知', '2026-11-06')}${row('b', '学术讲座：多模态大模型', '2026-11-06')}${row('c', '校内访问的通知', '2026-11-05')}${row('old', '很早以前的通知', '2026-09-01')}</ul>`;
    const pages: Record<string, string> = {
      'https://ai.fudan.edu.cn/n/a/page.htm': detail('请同学们在下周五前完成选课确认，逾期不再受理。'),
      'https://ai.fudan.edu.cn/n/b/page.htm': detail('时间：11月12日（周四）15:00-17:00</p><p>地点：江湾校区交叉学科楼 2001</p><p>欢迎参加。'),
      'https://ai.fudan.edu.cn/n/d/page.htm': detail('关于奖学金评选，请于下周提交申请材料，过期不候。'),
    };
    const fetched: string[] = [];
    const fetchText: FetchText = async (url) => {
      fetched.push(url);
      if (url === source.url) return { url, status: 200, text: list };
      return pages[url] ? { url, status: 200, text: pages[url] } : { url, status: 403, text: '' };
    };
    const r = await syncNotices({ repo: ctx.repo, router: noModel, fetchText, pause: async () => {} }, [source], NOW);
    expect(r).toMatchObject({ notices: 4, activities: 1, errors: [] });
    expect(fetched).not.toContain('https://ai.fudan.edu.cn/n/old/page.htm');
    const triggers = ctx.repo.pendingTriggers();
    expect(triggers.filter((t) => t.kind === 'notice_new').map((t) => t.payload.title)).toEqual(['关于本科生选课的通知', '校内访问的通知']);
    expect(triggers.find((t) => t.kind === 'notice_new')!.payload.own).toBe(true);
    expect(triggers.filter((t) => t.kind === 'activity_new')).toHaveLength(1);
    expect(ctx.repo.listNotices({ query: '校内访问' })[0].notice).toMatchObject({ titleOnly: true, sourceName: '计算与智能创新学院' });
    // 第二次：只处理新通知
    list = list.replace('<ul>', `<ul>${row('d', '关于奖学金评选的通知', '2026-11-07')}`);
    fetched.length = 0;
    const r2 = await syncNotices({ repo: ctx.repo, router: noModel, fetchText, pause: async () => {} }, [source], NOW);
    expect(r2.notices).toBe(1);
    expect(fetched).toEqual([source.url, 'https://ai.fudan.edu.cn/n/d/page.htm']);
  });

  it('只允许校园网访问的网站，提示连 VPN', async () => {
    const ctx = new AppContext({ dbPath: ':memory:', channels: nullChannels, elearning: () => null, mail: () => null });
    cleanups.push(() => ctx.close());
    const r = await syncNotices({ repo: ctx.repo, router: noModel, fetchText: async (url) => ({ url, status: 200, text: '<h3>访问策略禁止您访问该网站</h3>' }), pause: async () => {} }, [source], NOW);
    expect(r.errors[0]).toContain('VPN');
  });

  it('演示模式：同步后动态里有学校通知', async () => {
    const ctx = new AppContext({ dbPath: ':memory:', channels: nullChannels, elearning: () => null, mail: () => null });
    cleanups.push(() => ctx.close());
    ctx.repo.setSettings({ demoMode: true, quietHours: { start: '03:00', end: '03:01' } });
    seedDemoProfile(ctx.repo);
    await ctx.start();
    await ctx.syncAll();
    await ctx.engine.tick();
    expect(ctx.repo.listNotices().length).toBeGreaterThanOrEqual(3);
    expect(ctx.repo.listFeed('campus_notice').map((c) => c.title).some((t) => t.includes('期末考试'))).toBe(true);
    expect(ctx.repo.listActivities().some((a) => a.title.includes('多模态'))).toBe(true);
  });
});

describe('通知研判', () => {
  const memory = (type: Memory['type'], content: string): Memory => ({ id: content, type, content, source: 'manual', pinned: false, createdAt: '', updatedAt: '' });
  const t = (payload: Record<string, unknown>): Trigger => ({ id: 't', source: 'notice', kind: 'notice_new', sourceRef: 'x', threadKey: 'notice:x', payload: { sourceName: '教务处', ...payload }, occurredAt: '', disposition: 'pending' });
  const run = (payload: Record<string, unknown>, memories: Memory[] = []) => heuristic([t(payload)], { memories, phase: 'regular', describe: () => '' });

  it('按目标、院系、教务处重要通知区分', () => {
    expect(run({ title: '2027 春季学期赴某大学交换项目报名' }, [memory('goal', '想申请 2027 春季交换')]).action).toBe('suggest_ticket');
    expect(run({ title: '关于期中退课的通知', department: true }).action).toBe('card');
    expect(run({ title: '学院新闻：校友返校', own: true }).action).toBe('digest');
    expect(run({ title: '保卫处消防演练', department: true }).action).toBe('record');
  });
});
