import type { CanvasAnnouncement, CanvasAssignment, CanvasCourse, ElearningClient } from '@fudaner/mcp-fudan-elearning';
import type { MailClient, MailMessage } from '@fudaner/mcp-fudan-mail';
import type { Repo } from '../db/repo';
import type { Course, CourseSlot } from '../../shared/types';

/**
 * 演示模式（PRD D8）：用模拟数据实现和真实客户端完全一样的接口，
 * 演示和真实环境走同一套同步、主动引擎、智能体和 MCP 流程。
 *
 * 所有时间都相对于「现在」生成，演示数据永远是新鲜的。内容均为虚构。
 */

const H = 3_600_000;
const D = 24 * H;

function at(now: Date, offsetMs: number, hhmm?: string): string {
  const d = new Date(now.getTime() + offsetMs);
  if (hhmm) {
    const [h, m] = hhmm.split(':').map(Number);
    d.setHours(h, m, 0, 0);
  }
  return d.toISOString();
}

const TA_LI = 'li.zhujiao@m.fudan.edu.cn';
const PROF_WANG = 'wang.laoshi@fudan.edu.cn';

export function demoCourses(): CanvasCourse[] {
  return [
    { id: '1001', name: '数据结构', courseCode: 'COMP130004.01', term: '2026秋', teachers: [{ name: '王老师', email: PROF_WANG, role: 'teacher' }, { name: '李助教', email: TA_LI, role: 'ta' }] },
    { id: '1002', name: '数学分析 III', courseCode: 'MATH120003.02', term: '2026秋', teachers: [{ name: '陈老师', role: 'teacher' }] },
    { id: '1003', name: '大学物理 B', courseCode: 'PHYS120013.05', term: '2026秋', teachers: [{ name: '周老师', role: 'teacher' }] },
    { id: '1004', name: '线性代数', courseCode: 'MATH120044.01', term: '2026秋', teachers: [{ name: '赵老师', role: 'teacher' }] },
    { id: '1005', name: '学术英语写作', courseCode: 'ENGL110025.03', term: '2026秋', teachers: [{ name: 'Ms. Smith', role: 'teacher' }] },
    { id: '1006', name: '中国近现代史纲要', courseCode: 'PTSS110008.12', term: '2026秋', teachers: [{ name: '孙老师', role: 'teacher' }] },
  ];
}

export function demoAssignments(now: Date): CanvasAssignment[] {
  const a = (id: string, courseId: string, name: string, dueAt: string, submitted: boolean, updatedOffset: number, description = ''): CanvasAssignment => ({
    id, courseId, name, dueAt, submitted, description, htmlUrl: `https://elearning.fudan.edu.cn/courses/${courseId}/assignments/${id}`,
    submissionTypes: ['online_upload'], updatedAt: at(now, updatedOffset),
  });
  return [
    a('5001', '1001', 'Lab 5：链表与栈', at(now, 0, '23:59'), false, -5 * D, '实现双向链表和基于链表的栈，提交源码。'),
    a('5002', '1001', 'Lab 4：顺序表', at(now, -6 * D, '23:59'), true, -12 * D),
    a('5003', '1001', 'Lab 6：二叉树', at(now, 9 * D, '23:59'), false, -10 * 60_000, '实现二叉搜索树的插入、删除与遍历。'),
    a('5101', '1002', '数分作业 6', at(now, 3 * D, '18:00'), false, -4 * D),
    a('5102', '1002', '数分作业 5', at(now, -4 * D, '18:00'), true, -11 * D),
    a('5201', '1003', '大学物理 习题 8', at(now, 2 * D, '12:00'), false, -6 * D),
    a('5202', '1003', '大学物理 习题 9', at(now, 9 * D, '12:00'), false, -10 * 60_000),
    a('5301', '1004', '线代 HW 7', at(now, 5 * D, '23:59'), false, -3 * D),
    a('5302', '1004', '线代 HW 6', at(now, -2 * D, '23:59'), true, -9 * D),
    a('5401', '1005', 'Essay Draft 2', at(now, 4 * D, '23:59'), false, -7 * D),
    a('5402', '1005', 'Reading Response 4', at(now, 2 * D, '23:59'), false, -3 * D),
    a('5501', '1006', '读书报告', at(now, 12 * D, '23:59'), false, -8 * D),
  ];
}

/** 数据结构期中考试：演示时间往后 16 天（与公告、考核安排保持一致） */
export function demoMidterm(now: Date): Date {
  return new Date(at(now, 16 * D, '14:00'));
}

export function demoAnnouncements(now: Date): CanvasAnnouncement[] {
  const mid = demoMidterm(now);
  return [
    { id: '7001', courseId: '1001', title: '期中考试范围说明', message: `期中考试范围为第 1–6 章，考试时间 ${mid.getMonth() + 1} 月 ${mid.getDate()} 日 14:00。`, postedAt: at(now, -20 * H), htmlUrl: 'https://elearning.fudan.edu.cn/courses/1001/discussion_topics/7001' },
    { id: '7002', courseId: '1003', title: '本周四习题课改到 H3208', message: '本周四习题课教室调整为 H3208。', postedAt: at(now, -30 * H), htmlUrl: 'https://elearning.fudan.edu.cn/courses/1003/discussion_topics/7002' },
  ];
}

export function demoMails(now: Date): MailMessage[] {
  const m = (uid: string, from: { name?: string; address: string }, subject: string, offset: number, text: string): MailMessage => ({
    uid, messageId: `<demo-${uid}@fudaner>`, from, to: ['demo@m.fudan.edu.cn'], subject, date: at(now, offset), text,
  });
  return [
    m('1', { name: '王老师', address: PROF_WANG }, '关于下周组会时间调整', -11 * H, '同学好，下周组会想改到周四下午 3 点，请回复是否方便参加。'),
    m('2', { name: '教务处', address: 'jwc@fudan.edu.cn' }, '关于 2026 秋季学期期中考试安排的通知', -26 * H, '各位同学：期中考试安排已发布，请于 11 月 10 日前登录系统确认考试时间。'),
    m('3', { name: '国际合作与交流处', address: 'fao@fudan.edu.cn' }, '2027 春季学期赴新加坡国立大学交换项目报名通知', -28 * H, '面向 2024、2025 级本科生，报名截止 11 月 15 日，需提交成绩单、个人陈述和语言成绩。'),
    m('4', { name: '计算与智能创新学院', address: 'cs@fudan.edu.cn' }, '【讲座】大模型推理加速前沿（本周五 14:00）', -9 * H, '主讲人：某某教授。地点：江湾校区交叉二号楼 A2001。欢迎对 AI 方向感兴趣的同学参加。'),
    m('5', { name: '图书馆', address: 'lib@fudan.edu.cn' }, '图书馆数据库培训第 3 期', -40 * H, '本周三 18:30 线上举行数据库检索培训。'),
    m('6', { name: '体育教学部', address: 'pe@fudan.edu.cn' }, '冬季长跑活动开始打卡', -50 * H, '冬季长跑活动开始，请在 App 中打卡。'),
    m('7', { name: '社团联合会', address: 'club@fudan.edu.cn' }, '社团周例会通知', -60 * H, '本周二晚 19:00 社团例会照常举行。'),
    m('8', { name: '学生工作部', address: 'xgb@fudan.edu.cn' }, '关于开展 2026 年度奖学金评定工作的通知', -70 * H, '各院系请于 11 月 20 日前完成初评，同学们请关注院系通知。'),
    m('9', { name: '某某招聘', address: 'hr@example.com' }, '2027 届校园招聘宣讲会', -36 * H, '欢迎参加我们的宣讲会。'),
    m('10', { name: '小李', address: 'xiaoli@m.fudan.edu.cn' }, 'Lab 5 我们分工一下？', -15 * H, '我写链表部分，你写栈？今晚能确认一下吗？'),
  ];
}

/** 演示用：之后「到达」的助教邮件（演示跨平台关联） */
export function demoLateMail(now: Date): MailMessage {
  return {
    uid: '99', messageId: '<demo-99@fudaner>', from: { name: '李助教', address: TA_LI }, to: ['demo@m.fudan.edu.cn'],
    subject: '关于 Lab 5 提交要求的补充说明', date: now.toISOString(),
    text: '各位同学：Lab 5 除了源码外，还需要提交一份 PDF 实验报告（含测试截图），源码和报告打包为 zip 上传。截止时间不变。',
  };
}

export class DemoElearningClient implements ElearningClient {
  private submitted = new Set<string>();
  constructor(private readonly now: () => Date = () => new Date()) {}
  async ping() { return true; }
  async listCourses() { return demoCourses(); }
  async listAssignments(courseId: string) {
    return demoAssignments(this.now()).filter((a) => a.courseId === courseId).map((a) => (this.submitted.has(a.id) ? { ...a, submitted: true, submittedAt: this.now().toISOString() } : a));
  }
  async listAnnouncements(courseIds: string[]) { return demoAnnouncements(this.now()).filter((a) => courseIds.includes(a.courseId)); }
  /** 演示课件（虚构）：每门课两个文件 */
  async listFiles(courseId: string) {
    const course = demoCourses().find((c) => c.id === courseId);
    const name = course?.name ?? '课程';
    return [
      { id: `${courseId}01`, name: `${name} 第5讲 讲义（演示）.md`, size: 2048, contentType: 'text/markdown', updatedAt: this.now().toISOString(), folder: '课件' },
      { id: `${courseId}02`, name: `${name} 课程大纲（演示）.md`, size: 1024, contentType: 'text/markdown', updatedAt: this.now().toISOString(), folder: '课程信息' },
    ];
  }
  async downloadFile(fileId: string) {
    const course = demoCourses().find((c) => fileId.startsWith(c.id));
    const name = course?.name ?? '课程';
    const lecture = fileId.endsWith('01');
    const text = lecture
      ? `# ${name} 第5讲（演示讲义）\n\n本讲内容为虚构示例。\n\n## 要点\n- 概念一：定义与例子\n- 概念二：常见错误\n- 课后练习：第 3、5 题\n`
      : `# ${name} 课程大纲（演示）\n\n- 平时作业 40%\n- 期中 20%\n- 期末 40%\n`;
    return { name: `${name} ${lecture ? '第5讲 讲义' : '课程大纲'}（演示）.md`, contentType: 'text/markdown', data: new TextEncoder().encode(text) };
  }

  /** 演示「闭环」：模拟用户在 eLearning 上交了作业 */
  submit(assignmentId: string) { this.submitted.add(assignmentId); }
  reset() { this.submitted.clear(); }
}

export class DemoMailClient implements MailClient {
  private extra: MailMessage[] = [];
  constructor(private readonly now: () => Date = () => new Date()) {}
  async ping() { return true; }
  async fetchSince(since: Date) {
    return [...demoMails(this.now()), ...this.extra].filter((m) => Date.parse(m.date) >= since.getTime());
  }
  inject(m: MailMessage) { this.extra.push(m); }
  reset() { this.extra = []; }
}

/**
 * 演示用的课表和考核安排（Canvas 不提供这些，真实环境由课表导入补充）。
 * 课表按「今天是星期几」生成，保证演示当天有课：上午数分、下午数据结构，15:10 之后空闲。
 */
export function applyDemoCourseExtras(repo: Repo, now: Date): void {
  const wd = ((now.getDay() + 6) % 7) + 1;
  const day = (k: number) => ((wd - 1 + k) % 7) + 1;
  const final = (k: number) => at(now, (45 + k) * D, '08:30');
  const extras: Record<string, { schedule: CourseSlot[]; assessments: NonNullable<Course['assessments']> }> = {
    'COMP130004.01': {
      schedule: [{ weekday: day(0), start: '13:30', end: '15:10', location: 'H2215' }, { weekday: day(3), start: '10:00', end: '11:40', location: 'H2215' }],
      assessments: [{ kind: 'midterm', date: demoMidterm(now).toISOString() }, { kind: 'final', date: final(0) }],
    },
    'MATH120003.02': {
      schedule: [{ weekday: day(0), start: '08:00', end: '09:40', location: 'H3109' }, { weekday: day(2), start: '08:00', end: '09:40', location: 'H3109' }],
      assessments: [{ kind: 'final', date: final(2) }],
    },
    'PHYS120013.05': {
      schedule: [{ weekday: day(1), start: '10:00', end: '11:40', location: 'H3208' }, { weekday: day(3), start: '08:00', end: '09:40', location: 'H3208' }],
      assessments: [{ kind: 'final', date: final(4) }],
    },
    'MATH120044.01': { schedule: [{ weekday: day(1), start: '13:30', end: '15:10', location: 'HGX102' }], assessments: [{ kind: 'final', date: final(6) }] },
    'ENGL110025.03': { schedule: [{ weekday: day(2), start: '15:25', end: '17:05', location: 'H4102' }], assessments: [] },
    'PTSS110008.12': { schedule: [{ weekday: day(4), start: '18:30', end: '20:10', location: 'H2115' }], assessments: [{ kind: 'final', date: final(8) }] },
  };
  for (const c of repo.listCourses()) {
    const e = extras[c.code];
    if (e) repo.setCourseExtras(c.id, e);
  }
}

/** 演示用的画像和记忆（PRD 演示脚本中的「周二晚上有社团」「想申请交换」） */
export function seedDemoProfile(repo: Repo): void {
  if (repo.getKv('demo_seeded', false)) return;
  // 用户可能在首次引导中才开启演示。下次启动不能用演示画像覆盖刚保存的个人配置。
  if (repo.getSettings().onboardingCompleted) { repo.setKv('demo_seeded', true); return; }
  // 主动程度设为「多」：演示开始时首次同步会集中涌入一批事件，「中」档的预算会在演示后半段用完，
  // 导致闭环确认等关键镜头被降级到动态里（这本身是预期行为，但不利于演示）
  repo.setProfile({ nickname: '小旦', school: '计算与智能创新学院', grade: '2024 级', degree: '本科', assistantName: '旦旦', style: 'playful', proactivity: 'high' });
  repo.addMemory({ type: 'schedule', content: '周二晚上有社团活动', source: 'manual' });
  repo.addMemory({ type: 'goal', content: '想申请 2027 春季交换', source: 'manual' });
  repo.addMemory({ type: 'interest', content: '对 AI 方向的讲座感兴趣', source: 'manual' });
  repo.addMemory({ type: 'preference', content: '晚上 11 点后不想安排任务', source: 'manual' });
  repo.setKv('demo_seeded', true);
}
