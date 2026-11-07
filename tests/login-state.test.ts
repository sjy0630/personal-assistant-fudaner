import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CanvasCourse, ElearningClient } from '@fudaner/mcp-fudan-elearning';
import { CanvasClient } from '../packages/mcp-fudan-elearning/src/client';
import { NeedLoginError, isPermissionDenied, type FudanAuth } from '../packages/fudan-auth/src';
import { AppContext } from '../src/main/app-context';
import { loginActions } from '../src/main/ai/agent';
import { personaPrompt } from '../src/main/ai/prompts';
import type { Channels } from '../src/main/engine/channels';
import { buildToday } from '../src/main/today';

/**
 * 真实试用反馈：「刚登录 eLearning，一转眼又说没有登录授权；问旦旦怎么授权，它说不知道」。
 * - Canvas 对「没有权限」（例如课程花名册不对学生开放）也返回 401，不能当成登录过期；
 * - 旦旦要知道各平台的连接状态和登录方法。
 */
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
const noPermission = () => json({ status: 'unauthorized', errors: [{ message: 'user not authorized to perform that action' }] }, 401);
const notLoggedIn = () => json({ status: 'unauthenticated', errors: [{ message: 'user authorization required' }] }, 401);

describe('区分「没有权限」和「没有登录」', () => {
  it('Canvas 的两种 401', async () => {
    expect(await isPermissionDenied(noPermission())).toBe(true);
    expect(await isPermissionDenied(json({ errors: [{ message: 'user not authorized to perform that action' }] }, 401))).toBe(true);
    expect(await isPermissionDenied(notLoggedIn())).toBe(false);
    expect(await isPermissionDenied(json({}, 401))).toBe(false);
    expect(await isPermissionDenied(new Response('<html></html>', { status: 401 }))).toBe(false);
    expect(await isPermissionDenied(json({ status: 'unauthorized' }, 403))).toBe(false);
  });

  it('响应体判断之后仍可读取', async () => {
    const res = noPermission();
    await isPermissionDenied(res);
    expect(await res.json()).toMatchObject({ status: 'unauthorized' });
  });

  const client = (fetch: ReturnType<typeof vi.fn>) => new CanvasClient({ fetch } as unknown as FudanAuth);

  it('课程花名册没有权限时照常同步课程，不要求重新登录', async () => {
    const fetch = vi.fn((_p: string, url: string) => Promise.resolve(
      url.includes('/users') ? noPermission() : json([{ id: 1, name: '学术英语写作', course_code: 'ENGL110025.03', teachers: [{ display_name: '王老师' }] }]),
    ));
    const courses = await client(fetch).listCourses();
    expect(courses.map((c) => c.name)).toEqual(['学术英语写作']);
    expect(courses[0].teachers).toEqual([{ name: '王老师', email: undefined, role: 'teacher' }]);
  });

  it('单元没有权限时作业照常同步', async () => {
    const fetch = vi.fn((_p: string, url: string) => Promise.resolve(
      url.includes('/modules') ? noPermission() : url.includes('/planner') ? json([]) : json([{ id: 7, course_id: 1, name: 'Essay', html_url: 'https://elearning.fudan.edu.cn/courses/1/assignments/7', submission_types: ['online_upload'] }]),
    ));
    expect((await client(fetch).listAssignments('1')).map((a) => a.id)).toEqual(['7']);
  });

  it('没有权限按 403 报告，真正未登录仍要求登录', async () => {
    await expect(client(vi.fn().mockResolvedValue(noPermission())).listAssignments('1')).rejects.toMatchObject({ status: 403 });
    await expect(client(vi.fn().mockResolvedValue(notLoggedIn())).listAssignments('1')).rejects.toBeInstanceOf(NeedLoginError);
  });
});

describe('同步时跳过没有权限的课', () => {
  const courses: CanvasCourse[] = [
    { id: 'c1', name: '学术英语写作', courseCode: 'ENGL110025.03', teachers: [] },
    { id: 'c2', name: '已结课的旧课', courseCode: 'HIST000001.01', teachers: [] },
  ];
  const forbidden = () => Object.assign(new Error('没有权限查看这部分 eLearning 内容'), { status: 403 });
  class Partial implements ElearningClient {
    async ping() { return true; }
    async listCourses() { return courses; }
    async listAssignments(id: string) {
      if (id === 'c2') throw forbidden();
      return [{ id: 'a1', courseId: 'c1', name: 'Essay draft', htmlUrl: 'https://elearning.fudan.edu.cn/courses/c1/assignments/a1', submissionTypes: ['online_upload'], submitted: false }];
    }
    async listAnnouncements(ids: string[]) {
      if (ids.includes('c2')) throw forbidden();
      return [{ id: 'n1', courseId: 'c1', title: '下周停课', message: '', postedAt: new Date().toISOString(), htmlUrl: 'https://elearning.fudan.edu.cn/courses/c1/announcements/n1' }];
    }
  }
  const channels: Channels = { messagePosted() {}, notify() {}, changed() {}, toolProgress() {}, thinking() {} };
  let ctx: AppContext | undefined;
  afterEach(async () => { await ctx?.close(); ctx = undefined; });

  it('其他课的作业和公告照常同步，不报登录过期', async () => {
    const client = new Partial();
    ctx = new AppContext({ dbPath: ':memory:', channels, elearning: () => client, mail: () => null });
    await ctx.start();
    const result = await ctx.syncAll();
    expect(result.errors).toEqual([]);
    expect(ctx.repo.listItems({ kind: 'assignment' }).map((i) => i.title)).toEqual(['Essay draft']);
    expect(ctx.repo.listItems({ kind: 'announcement' }).map((i) => i.title)).toEqual(['下周停课']);
  });
});

describe('旦旦知道连接状态和登录方法', () => {
  const channels: Channels = { messagePosted() {}, notify() {}, changed() {}, toolProgress() {}, thinking() {} };

  it('系统提示里有登录步骤和当前状态', async () => {
    const ctx = new AppContext({ dbPath: ':memory:', channels, elearning: () => null, mail: () => null });
    const prompt = personaPrompt({
      profile: ctx.repo.getProfile(), memories: [], today: buildToday(ctx.repo), nowIso: new Date().toISOString(),
      platforms: [{ platform: 'elearning', status: 'need_login' }, { platform: 'mail', status: 'not_configured' }],
    });
    expect(prompt).toContain('设置 → 复旦账号');
    expect(prompt).toContain('企业微信');
    expect(prompt).toContain('客户端专用密码');
    expect(prompt).toContain('eLearning（复旦账号）：登录已过期');
    expect(prompt).toContain('学生邮箱：未配置');
    // 历史消息里的旧说法不能覆盖当前状态
    expect(prompt).toContain('对话历史里之前说过的「登录过期 / 没登录」可能已经过时');
    await ctx.close();
  });

  it('没登录时聊到登录 / 同步，回复下面带登录按钮', () => {
    const expired = [{ platform: 'elearning' as const, status: 'need_login' as const }];
    expect(loginActions(expired, '怎么授权 eLearning')).toEqual([{ label: '登录复旦账号', action: 'login' }]);
    expect(loginActions(expired, '帮我排一下今晚的计划')).toEqual([]);
    expect(loginActions([{ platform: 'elearning', status: 'ok' }], '怎么登录')).toEqual([]);
  });

  it('没接模型时问怎么登录，也能得到步骤和按钮', async () => {
    const ctx = new AppContext({ dbPath: ':memory:', channels, elearning: () => null, mail: () => null });
    await ctx.start();
    const reply = await ctx.agent.handleUserMessage('eLearning 怎么授权登录？');
    expect(reply.content).toContain('统一身份认证');
    expect(reply.actions).toEqual([{ label: '登录复旦账号', action: 'login' }]);
    await ctx.close();
  });
});
