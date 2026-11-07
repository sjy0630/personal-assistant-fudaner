import { afterEach, describe, expect, it } from 'vitest';
import { extractTables, readProgramCompletion, readSelectedCourses, summarizeProgramTables, tablesToText } from '../src/main/sources/academic';
import type { CampusReader } from '../src/main/sources/timetable-sync';
import { AppContext } from '../src/main/app-context';
import { nullChannels } from '../src/main/engine/channels';
import { createToolPolicy } from '../src/main/ai/tool-policy';

/** 培养方案完成情况、选课结果（页面和接口结构为虚构样例） */
const programPage = `<html><body><h3>培养方案完成情况</h3><table>
  <tr><th>课程类别</th><th>要求学分</th><th>已获学分</th><th>还需学分</th></tr>
  <tr><td>通识教育</td><td>46</td><td>30</td><td>16</td></tr>
  <tr><td>专业必修</td><td>60</td><td>34.5</td><td>25.5</td></tr>
  <tr><td></td><td></td><td></td><td></td></tr>
</table><table><tr><td>只有一行</td></tr></table></body></html>`;

describe('培养方案完成情况', () => {
  it('从页面表格认出类别、要求学分、已获学分', () => {
    const tables = extractTables(programPage);
    expect(tables).toHaveLength(1);
    expect(tables[0].caption).toBe('培养方案完成情况');
    expect(summarizeProgramTables(tables)).toEqual([
      { name: '通识教育', required: 46, earned: 30, remaining: 16 },
      { name: '专业必修', required: 60, earned: 34.5, remaining: 25.5 },
    ]);
    expect(tablesToText(tables)).toContain('课程类别 | 要求学分 | 已获学分 | 还需学分');
  });

  it('数据接口读不到时，用隐藏窗口打开页面读表格', async () => {
    const rendered: string[] = [];
    const reader: CampusReader = {
      getText: async (url) => ({ url, status: 404, text: '' }),
      render: async (url, ready) => { rendered.push(url); expect(ready(programPage, url)).toBe(true); return programPage; },
    };
    const r = await readProgramCompletion(reader, '12345');
    expect(rendered).toEqual(['https://fdjwgl.fudan.edu.cn/student/for-std/program-completion-preview']);
    expect(r.source).toBe('page');
    expect(r.modules[0].name).toBe('通识教育');
  });

  it('数据接口返回 JSON 时压平成文本交给模型', async () => {
    const r = await readProgramCompletion({ getText: async (url) => ({ url, status: 200, text: JSON.stringify({ modules: [{ name: '通识教育', requiredCredits: 46, finishedCredits: 30 }] }) }) }, '1');
    expect(r.source).toBe('json');
    expect(r.text).toContain('modules[0].requiredCredits: 46');
  });
});

describe('选课结果', () => {
  const semesterPage = `<select id="allSemesters"><option value="521" selected>2026-2027学年1学期</option></select><script>var semesters = JSON.parse('[{"id":541,"name":"2026-2027学年2学期"},{"id":521,"name":"2026-2027学年1学期"}]');</script>`;
  const printData = (activities: unknown[]) => JSON.stringify({ studentTableVms: [{ id: 1, activities }] });
  const act = (courseName: string, weekday: number, credits?: number) => ({ courseName, teachers: ['张老师'], room: 'H2215', weekday, startUnit: 6, endUnit: 7, weekIndexes: [1, 2, 3, 16], credits });

  it('当前学期和下学期；按课程合并上课时间，合计学分', async () => {
    const reader: CampusReader = { getText: async (url) => ({ url, status: 200, text:
      url.endsWith('/course-table') ? semesterPage
        : url.includes('/semester/521/') ? printData([act('数据结构', 1, 3), act('数据结构', 4, 3), act('线性代数', 3, 4)])
        : printData([act('操作系统', 2)]) }) };
    const cur = await readSelectedCourses(reader);
    expect(cur.semester).toBe('2026-2027学年1学期');
    expect(cur.courses.map((c) => [c.course, c.credits, c.sessions.length])).toEqual([['数据结构', 3, 2], ['线性代数', 4, 1]]);
    expect(cur.totalCredits).toBe(7);
    expect(cur.courses[0].sessions[0]).toBe('周一 第6–7节 H2215 1–16周');
    const next = await readSelectedCourses(reader, 'next');
    expect(next.semester).toBe('2026-2027学年2学期');
    expect(next.totalCredits).toBeUndefined();
  });
});

describe('接进应用', () => {
  const cleanups: (() => Promise<void>)[] = [];
  afterEach(async () => { for (const c of cleanups.splice(0)) await c(); });
  it('培养方案完成情况按敏感内容处理；选课结果可以直接查', async () => {
    const ctx = new AppContext({ dbPath: ':memory:', channels: nullChannels, elearning: () => null, mail: () => null });
    cleanups.push(() => ctx.close());
    ctx.repo.setSettings({ demoMode: true });
    await ctx.start();
    const cloud = createToolPolicy(ctx.repo, { label: 'cloud:deepseek-chat' });
    expect(cloud.filter('fudaner-local', 'get_program_completion')).toBe(false);
    expect(cloud.filter('fudaner-local', 'get_selected_courses')).toBe(true);
    const program = JSON.parse((await ctx.hub.call('fudaner_local__get_program_completion', {})).text);
    expect(program.modules[0]).toMatchObject({ required: 46, earned: 30 });
    const sel = JSON.parse((await ctx.hub.call('fudaner_local__get_selected_courses', { semester: 'next' })).text);
    expect(sel.semester).toContain('2学期');
  });
});
