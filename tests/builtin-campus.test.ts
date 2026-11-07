import { afterEach, describe, expect, it, vi } from 'vitest';
import { LibrarySearch, normalizeRecord, type GetJson } from '../src/main/sources/library-search';
import { encryptHost, isWebvpnLogin, toWebvpnUrl } from '../src/main/sources/webvpn';
import { TreeholeClient, TreeholeLoginError, type HoleTokens, type RawFetch, type RawResponse } from '../src/main/sources/treehole';
import { parseElectricity, readElectricity } from '../src/main/sources/dorm';
import { NeedLoginError } from '../packages/fudan-auth/src';
import { AppContext } from '../src/main/app-context';
import { nullChannels } from '../src/main/engine/channels';

/** 图书馆文献检索、WebVPN、树洞与旦克、宿舍电量（接口返回格式按真实服务，内容虚构） */

describe('图书馆文献检索', () => {
  const doc = { context: 'PC', pnx: {
    control: { recordid: ['TN_demo_1'] }, display: { title: ['Graph neural networks for molecules'], type: ['article'] },
    addata: { au: ['Li, A', 'Wang, B'], date: ['2025'], jtitle: ['Demo Journal'], doi: ['10.1/demo'], abstract: ['<p>An abstract.</p>'] },
    facets: { toplevel: ['peer_reviewed', 'online_resources'] },
  } };
  it('PNX 记录转成精简信息', () => {
    expect(normalizeRecord(doc)).toMatchObject({ recordId: 'TN_demo_1', title: 'Graph neural networks for molecules', authors: ['Li, A', 'Wang, B'], year: 2025, doi: '10.1/demo', abstract: 'An abstract.', peerReviewed: true, fullTextAvailable: true });
    expect(normalizeRecord({ pnx: { control: {} } })).toBeUndefined();
  });
  it('先取访客令牌再检索；令牌失效时换一次', async () => {
    const calls: { url: string; auth?: string }[] = [];
    let tokenNo = 0;
    const getJson: GetJson = async (url, headers) => {
      calls.push({ url, auth: headers.Authorization });
      if (url.includes('guestJwt')) return { status: 200, text: `"a.b.t${++tokenNo}"` };
      if (headers.Authorization === 'Bearer a.b.t1') return { status: 401, text: '' };
      return { status: 200, text: JSON.stringify({ info: { total: 1 }, docs: [doc] }) };
    };
    const lib = new LibrarySearch(getJson, (() => { let t = 0; return () => (t += 2000); })());
    const r = await lib.search({ query: 'graph; neural', yearFrom: 2020 });
    expect(r.total).toBe(1);
    expect(r.records[0].title).toBe('Graph neural networks for molecules');
    const search = new URL(calls.find((c) => c.url.includes('pnxs'))!.url);
    expect(search.searchParams.get('q')).toBe('any,contains,graph neural;dr_s,exact,20200101;dr_e,exact,21001231');
    expect(calls.filter((c) => c.url.includes('guestJwt'))).toHaveLength(2);
    expect(lib.document('TN_demo_1')?.abstract).toBe('An abstract.');
  });
});

describe('WebVPN 地址改写', () => {
  it('主机名加密（与 Python cryptography 的 AES-CFB 结果一致）', () => {
    expect(encryptHost('forum.fduhole.com')).toBe('77726476706e69737468656265737421f6f853892a7e6e546b0086a09d1b203a46');
    expect(toWebvpnUrl('https://auth.fduhole.com/api/login?x=1')).toBe('https://webvpn.fudan.edu.cn/https/77726476706e69737468656265737421f1e2559469366c45760785a9d6562c38/api/login?x=1');
    expect(isWebvpnLogin('https://webvpn.fudan.edu.cn:443/login')).toBe(true);
    expect(isWebvpnLogin('https://webvpn.fudan.edu.cn/https/abc/api')).toBe(false);
  });
});

describe('树洞与旦克', () => {
  const json = (data: unknown, status = 200, url = ''): RawResponse => ({ status, url, contentType: 'application/json', text: JSON.stringify(data) });
  const store = (initial: HoleTokens | null = null) => { let t = initial; return { get: () => t, set: (v: HoleTokens | null) => { t = v; } }; };

  it('校外：直连失败后走 WebVPN；WebVPN 会话失效时重新建立一次', async () => {
    const urls: string[] = [];
    let vpnReady = false;
    const fetch: RawFetch = async (url) => {
      urls.push(url);
      if (url.startsWith('https://forum.fduhole.com')) throw new Error('ECONNREFUSED');
      if (!vpnReady) return { status: 200, url: 'https://webvpn.fudan.edu.cn/login', contentType: 'text/html', text: '<html>login</html>' };
      return json([{ floor_id: 9, hole_id: 123, ranking: 2, anonyname: 'Alice', content: '食堂推荐 ![](x.png) 南区', time_created: '2026-11-01T12:00:00+08:00', like: 3 }]);
    };
    const ensureWebvpn = vi.fn(async () => { vpnReady = true; });
    const client = new TreeholeClient({ fetch, ensureWebvpn, tokens: store({ access: 'a', refresh: 'r' }) });
    const floors = await client.searchFloors('食堂');
    expect(floors).toEqual([{ hole_id: 123, floor_id: 9, floor: 2, who: 'Alice', time: '2026-11-01 12:00', likes: 3, reply_to: undefined, content: '食堂推荐 [图片] 南区' }]);
    expect(ensureWebvpn).toHaveBeenCalledTimes(1);
    expect(urls.at(-1)).toContain('webvpn.fudan.edu.cn/https/');
  });

  it('校园网内直连；令牌过期时刷新一次；刷新失败要求重新登录', async () => {
    const tokens = store({ access: 'old', refresh: 'r1' });
    const seen: string[] = [];
    const fetch: RawFetch = async (url, init) => {
      seen.push(`${init.method ?? 'GET'} ${url} ${init.headers?.Authorization ?? ''}`);
      if (url.endsWith('/divisions')) return json([]);
      if (url.endsWith('/refresh')) return init.headers?.Authorization === 'Bearer r1' ? json({ access: 'new', refresh: 'r2' }) : json({ message: 'bad' }, 401);
      return init.headers?.Authorization === 'Bearer new' ? json({ items: [{ id: 5, name: '数据结构', code: 'COMP130004', review_count: 9 }] }) : json({ message: 'expired' }, 401);
    };
    const client = new TreeholeClient({ fetch, ensureWebvpn: async () => {}, tokens });
    expect(await client.searchCourses('数据结构')).toEqual([{ course_group_id: 5, name: '数据结构', code: 'COMP130004', department: undefined, credits: undefined, campus: undefined, review_count: 9, course_count: undefined }]);
    expect(tokens.get()).toEqual({ access: 'new', refresh: 'r2' });
    expect(seen.some((s) => s.includes('webvpn'))).toBe(false);
    tokens.set({ access: 'x', refresh: 'bad' });
    await expect(client.searchCourses('数据结构')).rejects.toBeInstanceOf(TreeholeLoginError);
    expect(tokens.get()).toBeNull();
  });

  it('没登录时提示去设置里登录；登录只保存令牌', async () => {
    const tokens = store();
    const fetch: RawFetch = async (url, init) => {
      if (url.endsWith('/divisions')) return json([]);
      if (url.endsWith('/login')) return JSON.parse(init.body!).password === 'right' ? json({ access: 'a', refresh: 'r' }) : json({ message: '用户名或密码错误' }, 401);
      return json([]);
    };
    const client = new TreeholeClient({ fetch, ensureWebvpn: async () => {}, tokens });
    await expect(client.latest()).rejects.toThrow('设置');
    await expect(client.login('me@m.fudan.edu.cn', 'wrong')).rejects.toThrow('用户名或密码错误');
    await client.login('me@m.fudan.edu.cn', 'right');
    expect(tokens.get()).toEqual({ access: 'a', refresh: 'r' });
    expect(JSON.stringify(tokens.get())).not.toContain('right');
  });

  it('WebVPN 直接返回它的登录页面（200）时也能识别，登录后重试', async () => {
    let vpnReady = false;
    const fetch: RawFetch = async (url) => {
      if (url.startsWith('https://forum.fduhole.com')) throw new Error('offline');
      if (!vpnReady) return { status: 200, url, contentType: 'text/html', text: '<html><head><title>资源访问控制系统</title></head><a href="/login?cas_login=true">统一身份认证登录</a></html>' };
      return json({ access: 'a', refresh: 'r' });
    };
    const ensureWebvpn = vi.fn(async () => { vpnReady = true; });
    const tokens = store();
    await new TreeholeClient({ fetch, ensureWebvpn, tokens }).login('me@m.fudan.edu.cn', 'pw');
    expect(ensureWebvpn).toHaveBeenCalledTimes(1);
    expect(tokens.get()).toEqual({ access: 'a', refresh: 'r' });
  });

  it('直连拿到「请使用校园网」之类的网页时改走 WebVPN', async () => {
    const urls: string[] = [];
    const fetch: RawFetch = async (url) => {
      urls.push(url);
      if (url.endsWith('/divisions')) return json([]);
      if (url.startsWith('https://auth.fduhole.com')) return { status: 200, url, contentType: 'text/html', text: '<html><title>请使用校园网访问</title></html>' };
      return json({ access: 'a', refresh: 'r' });
    };
    await new TreeholeClient({ fetch, ensureWebvpn: async () => {}, tokens: store() }).login('me@m.fudan.edu.cn', 'pw');
    expect(urls.at(-1)).toContain('webvpn.fudan.edu.cn/https/');
  });

  it('拿到看不懂的网页时，错误里写明是哪个页面', async () => {
    const fetch: RawFetch = async (url) => (url.endsWith('/divisions') ? json([]) : { status: 200, url: 'https://auth.fduhole.com/api/login', contentType: 'text/plain', text: 'maintenance' });
    await expect(new TreeholeClient({ fetch, ensureWebvpn: async () => {}, tokens: store() }).login('a', 'b')).rejects.toThrow('auth.fduhole.com');
  });

  it('旦克课程评价按推荐数排序', async () => {
    const fetch: RawFetch = async (url) => url.endsWith('/divisions') ? json([]) : json({
      name: '数据结构', code: 'COMP130004', review_count: 2, course_list: [{ teachers: '张老师', year: 2025, semester: 1, review_list: [
        { title: '一般', content: '还行', remark: 1, vote: 1, rank: { overall: 3 } }, { title: '很好', content: '推荐', remark: 9, vote: 5, rank: { overall: 5 } },
      ] }],
    });
    const r = await new TreeholeClient({ fetch, ensureWebvpn: async () => {}, tokens: store({ access: 'a', refresh: 'r' }) }).courseReviews(5) as { reviews: { title: string }[]; teachers: string[] };
    expect(r.reviews.map((x) => x.title)).toEqual(['很好', '一般']);
    expect(r.teachers).toEqual(['张老师']);
  });
});

describe('宿舍电量', () => {
  it('解析电量系统的返回', () => {
    expect(parseElectricity(JSON.stringify({ e: 0, d: { xq: '江湾', ssmc: '15号楼', fjmc: '323', fj_surplus: 23.08, fj_used: 3360.4, fj_all: 3383.48, fj_update_time: '2026-11-07 00:00:00' } })))
      .toEqual({ room: '江湾 15号楼 323', remainingKwh: 23.08, usedKwh: 3360.4, totalKwh: 3383.48, updatedAt: '2026-11-07 00:00:00' });
    expect(() => parseElectricity(JSON.stringify({ e: 1, m: '未绑定宿舍' }))).toThrow('未绑定宿舍');
  });
  it('先走单点登录再读；被带到登录页时要求重新登录', async () => {
    const urls: string[] = [];
    const ok = await readElectricity({ getText: async (url) => { urls.push(url); return { url, status: 200, text: JSON.stringify({ e: 0, d: { fj_surplus: '9.5' } }) }; } });
    expect(ok.remainingKwh).toBe(9.5);
    expect(urls[0]).toContain('/sso/');
    await expect(readElectricity({ getText: async (url) => ({ url: url.includes('sso') ? url : 'https://zlapp.fudan.edu.cn/uc/wap/login?redirect=x', status: 200, text: '<html>登录</html>' }) })).rejects.toBeInstanceOf(NeedLoginError);
  });

  it('后台请求走不完单点登录时，用隐藏窗口完成再读', async () => {
    let session = false;
    const rendered: string[] = [];
    const r = await readElectricity({
      getText: async (url) => (session || url.includes('sso')
        ? { url, status: 200, text: url.includes('sso') ? '<html>跳转中</html>' : JSON.stringify({ e: 0, d: { fj_surplus: 12 } }) }
        : { url: 'https://zlapp.fudan.edu.cn/uc/wap/login?redirect=x', status: 200, text: '<html>登录</html>' }),
      render: async (url, ready) => { rendered.push(url); session = ready('', 'https://zlapp.fudan.edu.cn/site/home'); return ''; },
    });
    expect(rendered).toHaveLength(1);
    expect(r.remainingKwh).toBe(12);
  });
});

describe('对话工具（演示模式）', () => {
  const cleanups: (() => Promise<void>)[] = [];
  afterEach(async () => { for (const c of cleanups.splice(0)) await c(); });
  it('不用安装任何东西，直接能查树洞、旦克、文献、电量；电量低时提醒', async () => {
    const ctx = new AppContext({ dbPath: ':memory:', channels: nullChannels, elearning: () => null, mail: () => null });
    cleanups.push(() => ctx.close());
    ctx.repo.setSettings({ demoMode: true });
    await ctx.start();
    const call = async (tool: string, args: Record<string, unknown> = {}) => { const r = await ctx.hub.call(`fudaner_local__${tool}`, args); expect(r.ok).toBe(true); return JSON.parse(r.text); };
    expect((await call('search_course_reviews', { keyword: '数据结构' }))[0].course_group_id).toBe(501);
    expect((await call('get_course_reviews', { course_group_id: 501 })).reviews).toHaveLength(2);
    expect((await call('search_treehole', { keyword: '数据结构' })).length).toBeGreaterThan(0);
    expect((await call('read_treehole', { hole_id: 10001 })).floors).toHaveLength(3);
    const lit = await call('search_literature', { query: '图神经网络' });
    expect(lit.records[0].title).toContain('图神经网络');
    expect((await call('get_literature', { record_id: 'DEMO_1' })).recordId).toBe('DEMO_1');
    expect((await call('get_dorm_electricity')).remainingKwh).toBe(8.6);
    await ctx.syncAll(new Date(), { force: true });
    expect(ctx.repo.pendingTriggers().some((t) => t.kind === 'power_low')).toBe(true);
  });
});
