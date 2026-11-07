import { afterEach, describe, expect, it } from 'vitest';
import { parseExamPage, parsePostgradTable, parseSemesterPage, parseUndergradTable, periodTime, toCourseSlots } from '../src/main/sources/timetable';
import { importExams, importTimetable, type CampusReader } from '../src/main/sources/timetable-sync';
import { parseCardBalance, parseLibrary } from '../src/main/sources/campus-life';
import { AppContext } from '../src/main/app-context';
import { seedDemoProfile } from '../src/main/demo/demo';
import { nullChannels } from '../src/main/engine/channels';
import { emitClockTriggers } from '../src/main/engine/clock';
import { coursesOn } from '../src/main/today';
import { NeedLoginError } from '../packages/fudan-auth/src';
import type { Course } from '../src/shared/types';

/** 教务系统返回格式的小样例（字段名按学校接口，内容虚构） */
const semesterPage = `<html><body><select id="allSemesters"><option value="501">2025-2026学年2学期</option><option value="521" selected>2026-2027学年1学期</option></select>
<script>var semesters = JSON.parse('[{\\x22id\\x22:521,\\x22name\\x22:\\x222026-2027学年1学期\\x22,\\x22startDate\\x22:\\x222026-08-30\\x22},{\\x22id\\x22:501,\\x22name\\x22:\\x222025-2026学年2学期\\x22,\\x22startDate\\x22:\\x222026-02-15\\x22}]');</script></body></html>`;
const printData = JSON.stringify({ studentTableVms: [{ activities: [
  { courseName: '数据结构', teachers: ['张老师'], room: 'H2215', weekday: 1, startUnit: 6, endUnit: 7, weekIndexes: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16] },
  { courseName: '数据结构', teachers: ['张老师'], room: 'H2215', weekday: 4, startUnit: 3, endUnit: 4, weekIndexes: [2, 4, 6, 8, 10, 12, 14, 16] },
  { courseName: '体育（羽毛球）', teachers: ['李老师'], room: '正大体育馆', weekday: 3, startUnit: 11, endUnit: 12, weekIndexes: [1, 2, 3] },
  { courseName: '坏数据', weekday: 9, startUnit: 1, endUnit: 2 },
] }] });

describe('课表解析', () => {
  it('本科：学期列表和当前学期', () => {
    const r = parseSemesterPage(semesterPage);
    expect(r.currentId).toBe('521');
    expect(r.semesters[0]).toEqual({ id: '521', name: '2026-2027学年1学期', startDate: '2026-08-30' });
  });

  it('本科：print-data，跳过格式不对的行', () => {
    const rows = parseUndergradTable(printData);
    expect(rows).toHaveLength(3);
    expect(rows[1]).toMatchObject({ course: '数据结构', weekday: 4, startPeriod: 3, endPeriod: 4, location: 'H2215', weeks: [2, 4, 6, 8, 10, 12, 14, 16] });
  });

  it('研究生：周次位串，相邻节次合并', () => {
    const body = JSON.stringify({ results: [
      { KCMC: '机器学习', XQ: '2', KSJCDM: '6', JSJCDM: '6', ZCBH: '1111000000000000', JASMC: 'H3108', JSXM: '王老师' },
      { KCMC: '机器学习', XQ: '2', KSJCDM: '7', JSJCDM: '7', ZCBH: '1111000000000000', JASMC: 'H3108', JSXM: '王老师' },
    ] });
    expect(parsePostgradTable(body)).toEqual([{ course: '机器学习', weekday: 2, startPeriod: 6, endPeriod: 7, weeks: [1, 2, 3, 4], teachers: ['王老师'], location: 'H3108' }]);
  });

  it('节次换算成时间', () => {
    expect(periodTime(1, 2)).toEqual({ start: '08:00', end: '09:40' });
    expect(periodTime(6, 7)).toEqual({ start: '13:30', end: '15:10' });
    expect(periodTime(11, 13)).toEqual({ start: '18:30', end: '21:05' });
  });

  it('格式不对时给出能看懂的错误', () => {
    expect(() => parseSemesterPage('<html>登录</html>')).toThrow('课表格式');
    expect(() => parseUndergradTable('{}')).toThrow('课表格式');
  });
});

describe('按教学周排今天的课', () => {
  const course = (slots: Course['schedule']): Course => ({ id: 'c', code: 'X', name: '数据结构', teachers: [], matchStatus: 'auto', schedule: slots });
  const slots = toCourseSlots(parseUndergradTable(printData)).get('数据结构')!;
  it('双周的课只在双周出现；假期没有课', () => {
    // 2026-11-12 周四，第 10 周（双周）；2026-11-19 周四，第 11 周（单周）
    expect(coursesOn([course(slots)], new Date('2026-11-12T09:00:00+08:00'))).toEqual([{ name: '数据结构', start: '09:55', end: '11:35', location: 'H2215' }]);
    expect(coursesOn([course(slots)], new Date('2026-11-19T09:00:00+08:00'))).toEqual([]);
    expect(coursesOn([course(slots)], new Date('2026-10-05T09:00:00+08:00'))).toEqual([]);
    // 演示数据没有周次：每周都上
    expect(coursesOn([course([{ weekday: 1, start: '08:00', end: '09:40' }])], new Date('2026-10-05T09:00:00+08:00'))).toHaveLength(1);
  });
});

describe('考试安排', () => {
  it('表格解析', () => {
    const html = `<table><tr><th>课程</th><th>时间</th><th>考场</th></tr>
      <tr><td>1</td><td>数据结构</td><td>COMP130004.01</td><td>2027-01-05 08:30~10:30</td><td>HGX 205</td><td>闭卷</td></tr>
      <tr><td>2</td><td>线性代数</td><td>2027年1月8日</td><td>13:00-15:00</td><td>H3109 教室</td></tr></table>`;
    const exams = parseExamPage(html);
    expect(exams).toHaveLength(2);
    expect(exams[0]).toMatchObject({ course: '数据结构', startsAt: '2027-01-05T00:30:00.000Z', endsAt: '2027-01-05T02:30:00.000Z', location: 'HGX 205' });
    expect(exams[1]).toMatchObject({ course: '线性代数', location: 'H3109 教室' });
  });
});

describe('导入', () => {
  const cleanups: (() => Promise<void>)[] = [];
  afterEach(async () => { for (const c of cleanups.splice(0)) await c(); });
  const context = () => {
    const ctx = new AppContext({ dbPath: ':memory:', channels: nullChannels, elearning: () => null, mail: () => null });
    cleanups.push(() => ctx.close());
    return ctx;
  };
  const reader = (pages: Record<string, string>): CampusReader => ({
    getText: async (url) => {
      const key = Object.keys(pages).find((k) => url.startsWith(k) && (k.length === url.length || url.slice(k.length).startsWith('?') || pages[url] === undefined));
      const text = pages[url] ?? (key ? pages[key] : undefined);
      if (text === undefined) throw new NeedLoginError('jwfw');
      return { url, status: 200, text };
    },
  });

  it('课表写到同名课程上；没有的课新建；退掉的课清空上课时间', async () => {
    const { repo } = context();
    const ds = repo.upsertCourse({ code: 'COMP130004.01', name: '数据结构', teachers: [], elearningId: '1', matchStatus: 'auto' });
    const pages = {
      'https://fdjwgl.fudan.edu.cn/student/for-std/course-table': semesterPage,
      'https://fdjwgl.fudan.edu.cn/student/for-std/course-table/semester/521/print-data': printData,
    };
    const r = await importTimetable(repo, reader(pages));
    expect(r).toMatchObject({ kind: 'undergraduate', semester: '2026-2027学年1学期', courses: 2 });
    expect(repo.getCourse(ds.id)!.schedule).toHaveLength(2);
    const pe = repo.listCourses().find((c) => c.name === '体育（羽毛球）')!;
    expect(pe.schedule![0]).toMatchObject({ weekday: 3, start: '18:30', end: '20:10', location: '正大体育馆' });
    // 再导入一次，体育课没了
    const withoutPe = JSON.stringify({ studentTableVms: [{ activities: JSON.parse(printData).studentTableVms[0].activities.slice(0, 2) }] });
    await importTimetable(repo, reader({ ...pages, 'https://fdjwgl.fudan.edu.cn/student/for-std/course-table/semester/521/print-data': withoutPe }));
    expect(repo.getCourse(pe.id)!.schedule).toEqual([]);
    expect(repo.listCourses().filter((c) => c.name === '数据结构')).toHaveLength(1);
  });

  it('研究生读研究生选课系统', async () => {
    const { repo } = context();
    repo.setProfile({ degree: '硕士' });
    const r = await importTimetable(repo, reader({ 'https://yjsxk.fudan.edu.cn/yjsxkapp/sys/xsxkappfudan/xsxkCourse/loadKbxx.do': JSON.stringify({ results: [{ KCMC: '机器学习', XQ: 2, KSJCDM: 6, JSJCDM: 7, ZCBH: '11', JASMC: 'H3108' }] }) }));
    expect(r).toMatchObject({ kind: 'postgraduate', courses: 1 });
  });

  it('没登录时抛出 NeedLoginError', async () => {
    const { repo } = context();
    await expect(importTimetable(repo, reader({}))).rejects.toBeInstanceOf(NeedLoginError);
  });

  it('考试 → 事项、课程考核；考前 7 天和前一天提醒', async () => {
    const { repo } = context();
    const ds = repo.upsertCourse({ code: 'COMP130004.01', name: '数据结构', teachers: [], elearningId: '1', matchStatus: 'auto' });
    const html = `<table><tr><td>数据结构</td><td>2027-01-05 08:30~10:30</td><td>HGX 205</td></tr></table>`;
    const r = await importExams(repo, { getText: async (url) => ({ url, status: 200, text: html }) });
    expect(r).toEqual({ exams: 1, added: 1 });
    const exam = repo.listItems({ kind: 'exam' })[0];
    expect(exam).toMatchObject({ title: '数据结构 考试', courseId: ds.id, dueAt: '2027-01-05T00:30:00.000Z' });
    expect(repo.getCourse(ds.id)!.assessments).toEqual([{ kind: 'final', date: '2027-01-05' }]);
    emitClockTriggers(repo, new Date('2026-12-30T10:00:00+08:00'));
    emitClockTriggers(repo, new Date('2027-01-04T10:00:00+08:00'));
    const stages = repo.pendingTriggers().filter((t) => t.kind === 'exam_soon').map((t) => t.payload.stage);
    expect(stages).toEqual(['7d', '1d']);
    // 重复导入不重复
    expect((await importExams(repo, { getText: async (url) => ({ url, status: 200, text: html }) })).added).toBe(0);
  });

  it('考试页靠脚本加载时，用隐藏窗口渲染后再读', async () => {
    const { repo } = context();
    const rendered: string[] = [];
    const r = await importExams(repo, {
      getText: async (url) => ({ url, status: 200, text: '<html><div id="app"></div></html>' }),
      render: async (url) => { rendered.push(url); return '<table><tr><td>线性代数</td><td>2027-01-08 13:00~15:00</td><td>H3109</td></tr></table>'; },
    });
    expect(rendered).toHaveLength(1);
    expect(r.exams).toBe(1);
  });
});

describe('图书馆和校园卡', () => {
  it('图书馆接口', () => {
    const body = JSON.stringify({ msg: 'SUCCESS', code: '1', data: [{ campusId: '1', campusName: '文科馆', inNum: '452', canInNumb: '748', libraryOpenTime: '8:00~22:00' }, { campusName: '理科馆', inNum: null, canInNumb: '619' }] });
    expect(parseLibrary(body)).toEqual([
      { name: '文科馆', inside: 452, remaining: 748, openTime: '8:00~22:00' },
      { name: '理科馆', inside: null, remaining: 619, openTime: undefined },
    ]);
    expect(() => parseLibrary(JSON.stringify({ code: '0' }))).toThrow('暂时查不到');
  });

  it('校园卡余额', () => {
    expect(parseCardBalance('<div class="custname">某同学</div><div class="payway-box-bottom-item"><p>¥ 1,023.50</p></div>')).toBe(1023.5);
    expect(() => parseCardBalance('<html>登录</html>')).toThrow('余额');
  });

  it('演示模式：每天一次的校园更新，余额低时提醒；考试出现在「今天」', async () => {
    const ctx = new AppContext({ dbPath: ':memory:', channels: nullChannels, elearning: () => null, mail: () => null });
    try {
      ctx.repo.setSettings({ demoMode: true, quietHours: { start: '03:00', end: '03:01' } });
      seedDemoProfile(ctx.repo);
      await ctx.start();
      // 演示课程来自 eLearning 演示客户端，这里直接建一门
      ctx.repo.upsertCourse({ code: 'PHYS120013.05', name: '大学物理', teachers: [], elearningId: 'p', matchStatus: 'auto' });
      await ctx.syncAll(new Date(), { force: true });
      expect(ctx.repo.pendingTriggers().some((t) => t.kind === 'card_low')).toBe(true);
      expect(ctx.repo.listItems({ kind: 'exam' }).some((e) => e.title.includes('期中测验'))).toBe(true);
      expect((await ctx.library())[0].name).toContain('演示');
    } finally {
      await ctx.close();
    }
  });
});
