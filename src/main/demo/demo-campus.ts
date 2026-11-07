import type { LiteratureRecord } from '../sources/library-search';
import type { DormElectricity } from '../sources/dorm';
import type { WebResult } from '../sources/web-search';
import type { GradeReport } from '../sources/grades';
import type { ProgramCompletion, SelectedCourses } from '../sources/academic';
import type { Repo } from '../db/repo';
import type { LibraryStatus } from '../sources/campus-life';

/** 演示模式：考试安排、图书馆人数、校园卡余额（虚构数据） */

/** 演示考试：每门课的期末考 + 一场 5 天后的小测，用来展示考前提醒 */
export function demoExams(repo: Repo, now: Date): { exams: number; added: number } {
  let added = 0;
  const courses = repo.listCourses();
  const quizCourse = courses.find((c) => c.code.startsWith('PHYS')) ?? courses[0];
  const rows: { courseId?: string; course: string; at: string; location: string }[] = [];
  if (quizCourse) {
    const d = new Date(now.getTime() + 5 * 86_400_000);
    d.setHours(10, 0, 0, 0);
    rows.push({ courseId: quizCourse.id, course: `${quizCourse.name}（期中测验）`, at: d.toISOString(), location: 'H3208（演示）' });
  }
  for (const c of courses) {
    for (const a of c.assessments ?? []) {
      if (a.kind !== 'final') continue;
      rows.push({ courseId: c.id, course: c.name, at: new Date(a.date).toISOString(), location: 'HGX 待定（演示）' });
    }
  }
  for (const r of rows) {
    const { created } = repo.upsertItem({
      source: 'jwfw', kind: 'exam', sourceId: `demo|${r.course}|${r.at.slice(0, 10)}`, title: `${r.course} 考试`,
      body: [new Date(r.at).toLocaleString('zh-CN', { hour12: false }), r.location].join('\n'),
      publishedAt: now.toISOString(), dueAt: r.at, courseId: r.courseId, done: false,
    });
    if (created) added++;
  }
  repo.setKv('exam_meta', { exams: rows.length, updatedAt: now.toISOString() });
  return { exams: rows.length, added };
}

export function demoLibrary(): LibraryStatus[] {
  return [
    { name: '文科馆（演示）', inside: 452, remaining: 748, openTime: '8:00~22:00' },
    { name: '理科馆（演示）', inside: 281, remaining: 619, openTime: '8:00~23:00' },
    { name: '江湾馆（演示）', inside: 325, remaining: 475, openTime: '8:00~22:00' },
  ];
}

export function demoCardBalance(): number {
  return 23.5;
}

// ---------- 演示：宿舍电量、图书馆文献、树洞与旦克（全部虚构） ----------

export function demoElectricity(): DormElectricity {
  return { room: '邯郸 本部 演示楼 101', remainingKwh: 8.6, usedKwh: 1532.4, totalKwh: 1541, updatedAt: new Date().toISOString().slice(0, 10) };
}

const DEMO_PAPERS: LiteratureRecord[] = [
  { recordId: 'DEMO_1', context: 'PC', title: '图神经网络在分子性质预测中的应用综述（演示）', authors: ['张三（虚构）', '李四（虚构）'], year: 2025, journal: '演示期刊', type: 'article', abstract: '这是一篇虚构的综述摘要，介绍图神经网络如何把分子表示成图并预测其性质。', peerReviewed: true, fullTextAvailable: true, url: 'https://example.com/demo-paper-1' },
  { recordId: 'DEMO_2', context: 'PC', title: '大语言模型辅助科学发现：方法与挑战（演示）', authors: ['王五（虚构）'], year: 2026, journal: '演示学报', type: 'article', abstract: '虚构摘要：讨论大语言模型在提出假设、设计实验和分析数据中的作用与局限。', peerReviewed: true, fullTextAvailable: false, url: 'https://example.com/demo-paper-2' },
];

export function demoLiterature(query: string): { total: number; records: LiteratureRecord[]; searchUrl: string } {
  return { total: DEMO_PAPERS.length, records: DEMO_PAPERS, searchUrl: `https://example.com/demo-search?q=${encodeURIComponent(query)}` };
}

/** 演示树洞：虚构的帖子和课程评价，接口形状与真实客户端一致 */
export function demoTreehole() {
  const floors = [
    { hole_id: 10001, floor_id: 1, floor: 0, who: 'Alice（演示）', time: '2026-11-01 21:03', likes: 12, content: '数据结构这门课作业量大吗？期中难不难？（虚构帖子）' },
    { hole_id: 10001, floor_id: 2, floor: 1, who: 'Bob（演示）', time: '2026-11-01 21:20', likes: 30, content: 'Lab 每周一个，按时写不会太累；期中考链表和树，往年题很有参考价值。（虚构回复）' },
    { hole_id: 10001, floor_id: 3, floor: 2, who: 'Carol（演示）', time: '2026-11-02 09:12', likes: 8, content: '老师讲得清楚，答疑很及时，给分不错。（虚构回复）' },
  ];
  return {
    searchFloors: async () => floors.slice(1),
    hole: async (holeId: number) => ({ hole_id: holeId, division_id: 1, tags: ['课程（演示）'], replies: 2, views: 320, time: '2026-11-01 21:03', first_floor: floors[0].content, floors }),
    latest: async () => [{ hole_id: 10001, division_id: 1, tags: ['课程（演示）'], replies: 2, views: 320, time: '2026-11-01 21:03', first_floor: floors[0].content }],
    searchCourses: async () => [{ course_group_id: 501, name: '数据结构（演示）', code: 'COMP130004', department: '演示学院', credits: 3, campus: '邯郸', review_count: 2, course_count: 2 }],
    courseReviews: async () => ({
      name: '数据结构（演示）', code: 'COMP130004', department: '演示学院', credits: 3, review_count: 2, teachers: ['张老师（虚构）'],
      reviews: [
        { teachers: '张老师（虚构）', term: '2025 学年第 1 学期', title: '收获很大', content: '作业量适中，Lab 设计得好，期末考题不偏。（虚构评价）', time: '2026-01-20', rating: { overall: 5, content: 5, workload: 3, assessment: 4 }, votes: 20, remark: 18 },
        { teachers: '张老师（虚构）', term: '2025 学年第 1 学期', title: '要花时间', content: '每周要留出一晚上写 Lab，提前开始就不难。（虚构评价）', time: '2026-01-22', rating: { overall: 4, content: 4, workload: 2, assessment: 4 }, votes: 9, remark: 7 },
      ],
    }),
  };
}

/** 演示用的联网搜索结果（虚构） */
export async function demoSearch(query: string): Promise<WebResult[]> {
  return [
    { title: `${query}：本周值得关注的三件事（演示）`, url: `https://example.com/demo-news/${encodeURIComponent(query)}/1`, snippet: `虚构资讯：和「${query}」有关的最新进展汇总。`, date: '1 天前', site: '演示资讯' },
    { title: `${query} 入门指南（演示）`, url: `https://example.com/demo-news/${encodeURIComponent(query)}/2`, snippet: `虚构内容：适合本科生了解「${query}」的入门资料。`, date: '3 天前', site: '演示博客' },
  ];
}

/** 演示成绩（虚构） */
export function demoGrades(): GradeReport {
  const courses = [
    { course: '数学分析 II（演示）', credits: 5, grade: 'A-', gp: 3.7, semester: '2025-2026学年2学期' },
    { course: '程序设计（演示）', credits: 3, grade: 'A', gp: 4, semester: '2025-2026学年2学期' },
    { course: '大学英语（演示）', credits: 2, grade: 'B+', gp: 3.3, semester: '2025-2026学年2学期' },
    { course: '形势与政策（演示）', credits: 0.5, grade: 'P', semester: '2025-2026学年2学期' },
  ];
  return { semesters: [{ id: 'demo', name: '2025-2026学年2学期', courses }], gpa: 3.73, credits: 10.5, updatedAt: new Date().toISOString() };
}

/** 演示培养方案完成情况（虚构） */
export function demoProgram(): ProgramCompletion {
  const modules = [
    { name: '通识教育（演示）', required: 46, earned: 30, remaining: 16 },
    { name: '专业必修（演示）', required: 60, earned: 34, remaining: 26 },
    { name: '专业选修（演示）', required: 20, earned: 6, remaining: 14 },
    { name: '任意选修（演示）', required: 10, earned: 4, remaining: 6 },
  ];
  return { modules, text: modules.map((m) => `${m.name} | 要求 ${m.required} | 已获 ${m.earned}`).join('\n'), source: 'page', updatedAt: new Date().toISOString() };
}

/** 演示选课结果（虚构） */
export function demoSelected(which: string): SelectedCourses {
  return {
    semester: which === 'next' ? '2026-2027学年2学期（演示）' : '2026-2027学年1学期（演示）',
    courses: [
      { course: '数据结构（演示）', teachers: ['张老师'], credits: 3, sessions: ['周一 第6–7节 H2215 1–16周'] },
      { course: '线性代数（演示）', teachers: ['王老师'], credits: 4, sessions: ['周三 第1–2节 H3109 1–16周', '周五 第1–2节 H3109 1–16周'] },
    ],
    totalCredits: 7,
  };
}
