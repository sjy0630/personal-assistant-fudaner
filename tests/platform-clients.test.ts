import { describe, expect, it, vi } from 'vitest';
import { CanvasClient } from '../packages/mcp-fudan-elearning/src/client';
import { NeedLoginError, type FudanAuth } from '../packages/fudan-auth/src';

const json = (data: unknown, headers: Record<string, string> = {}, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json', ...headers } });
function client(fetch: ReturnType<typeof vi.fn>) { return new CanvasClient({ fetch } as unknown as FudanAuth); }
const assignment = (id: number, state = 'unsubmitted') => ({ id, course_id: 1, name: `作业${id}`, html_url: 'https://elearning.fudan.edu.cn/courses/1', submission_types: ['online_upload'], submission: { workflow_state: state } });
describe('Canvas 真实客户端协议', () => {
  it('完整读取 Link 分页，保持下一页参数', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(json([assignment(1)], { link: '<https://elearning.fudan.edu.cn/api/v1/courses/1/assignments?page=2>; rel="next"' })).mockResolvedValueOnce(json([assignment(2, 'submitted')]));
    const rows = await client(fetch).listAssignments('1');
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
    await expect(client(fetch).listAssignments('1')).resolves.toEqual([]);
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
});
