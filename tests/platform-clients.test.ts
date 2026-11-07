import { describe, expect, it, vi } from 'vitest';
import { CanvasClient } from '../packages/mcp-fudan-elearning/src/client';
import { NeedLoginError, type FudanAuth } from '../packages/fudan-auth/src';

const json = (data: unknown, headers: Record<string, string> = {}, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json', ...headers } });
function client(fetch: ReturnType<typeof vi.fn>) { return new CanvasClient({ fetch } as unknown as FudanAuth); }
/** 作业列表之外，listAssignments 还会读取「待办标记」和「单元」；这里把它们分流，作业请求仍按原来的顺序模拟 */
const isCompletionUrl = (url: string) => url.includes('/planner/overrides') || url.includes('/modules');
function withCompletion(assignments: ReturnType<typeof vi.fn>, completion: (url: string) => Response = () => json([])) {
  return vi.fn((platform: string, url: string) => (isCompletionUrl(url) ? Promise.resolve(completion(url)) : assignments(platform, url)));
}
const assignment = (id: number, state = 'unsubmitted') => ({ id, course_id: 1, name: `作业${id}`, html_url: 'https://elearning.fudan.edu.cn/courses/1', submission_types: ['online_upload'], submission: { workflow_state: state } });
describe('Canvas 真实客户端协议', () => {
  it('完整读取 Link 分页，保持下一页参数', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(json([assignment(1)], { link: '<https://elearning.fudan.edu.cn/api/v1/courses/1/assignments?page=2>; rel="next"' })).mockResolvedValueOnce(json([assignment(2, 'submitted')]));
    const rows = await client(withCompletion(fetch)).listAssignments('1');
    expect(rows.map((r) => r.id)).toEqual(['1', '2']);
    expect(rows[1].submitted).toBe(true);
    expect(fetch.mock.calls[1][1]).toContain('page=2');
  });
  it.each(['https://example.com/api/v1/courses/1/assignments', 'https://elearning.fudan.edu.cn/api/v1/users/1'])('拒绝异常分页链接 %s', async (url) => {
    const fetch = vi.fn().mockResolvedValue(json([], { link: `<${url}>; rel="next"` }));
    await expect(client(fetch).listAssignments('1')).rejects.toThrow('分页');
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('循环分页中止并报告失败，不返回不完整结果', async () => {
    const fetch = vi.fn().mockImplementation((_p, url) => Promise.resolve(json([], { link: `<${url}>; rel="next"` })));
    await expect(client(fetch).listAssignments('1')).rejects.toThrow('分页');
  });
  it('认证失败不重试', async () => {
    const fetch = vi.fn().mockResolvedValue(json({}, {}, 401));
    await expect(client(fetch).listAssignments('1')).rejects.toBeInstanceOf(NeedLoginError);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('HTML 登录页和无身份的 JSON 不能冒充成功', async () => {
    await expect(client(vi.fn().mockResolvedValue(new Response('<html>login</html>'))).ping()).rejects.toThrow('接口数据');
    await expect(client(vi.fn().mockResolvedValue(json({}))).ping()).rejects.toThrow('登录身份');
  });
  it('暂时性服务错误有限重试', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(json({}, { 'retry-after': '0' }, 503)).mockResolvedValueOnce(json([]));
    await expect(client(withCompletion(fetch)).listAssignments('1')).resolves.toEqual([]);
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it('长时间限流不会提前重试', async () => {
    const fetch = vi.fn().mockResolvedValue(json({}, { 'retry-after': '60' }, 429));
    await expect(client(fetch).listAssignments('1')).rejects.toThrow('稍后');
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('课程名册无权限时仍读取课程，有权限时保留助教邮箱', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(json([{ id: 1, name: '数据结构', course_code: 'COMP130004.01', teachers: [{ display_name: '教师' }] }])).mockResolvedValueOnce(json({}, {}, 403)).mockResolvedValueOnce(json([{ name: '助教', email: 'ta@example.com' }]));
    const courses = await client(fetch).listCourses();
    expect(courses[0].teachers).toEqual([{ name: '教师', role: 'teacher' }, { name: '助教', role: 'ta', email: 'ta@example.com' }]);
  });

  it('组作业：本人没有提交记录，但在「待办」里勾选了完成 → 算完成', async () => {
    const fetch = withCompletion(vi.fn().mockResolvedValue(json([assignment(1), assignment(2)])), (url) =>
      url.includes('/planner/overrides') ? json([{ plannable_type: 'assignment', plannable_id: 1, marked_complete: true }, { plannable_type: 'assignment', plannable_id: 2, marked_complete: false }]) : json([]));
    const rows = await client(fetch).listAssignments('1');
    expect(rows.map((r) => [r.id, r.submitted, r.markedDone])).toEqual([['1', false, true], ['2', false, false]]);
  });
  it('单元里要求「标记为完成」且已完成的作业 → 算完成', async () => {
    const fetch = withCompletion(vi.fn().mockResolvedValue(json([assignment(1)])), (url) =>
      url.includes('/modules') ? json([{ items: [{ type: 'Assignment', content_id: 1, completion_requirement: { type: 'must_mark_done', completed: true } }] }]) : json([]));
    expect((await client(fetch).listAssignments('1'))[0].markedDone).toBe(true);
  });
  it('教师免交（excused）→ 算完成', async () => {
    const excused = { ...assignment(1), submission: { workflow_state: 'unsubmitted', excused: true } };
    const rows = await client(withCompletion(vi.fn().mockResolvedValue(json([excused])))).listAssignments('1');
    expect(rows[0].markedDone).toBe(true);
  });
  it('「待办」或「单元」接口无权限时，不影响作业同步', async () => {
    const fetch = withCompletion(vi.fn().mockResolvedValue(json([assignment(1)])), () => json({}, {}, 403));
    const rows = await client(fetch).listAssignments('1');
    expect(rows.map((r) => [r.id, r.markedDone])).toEqual([['1', false]]);
  });
  it('一次同步里「待办」标记只读一次（多门课共用）', async () => {
    const fetch = withCompletion(vi.fn().mockImplementation(() => Promise.resolve(json([assignment(1)]))));
    const c = client(fetch);
    await c.listAssignments('1');
    await c.listAssignments('2');
    expect(fetch.mock.calls.filter(([, url]) => String(url).includes('/planner/overrides'))).toHaveLength(1);
  });
});
