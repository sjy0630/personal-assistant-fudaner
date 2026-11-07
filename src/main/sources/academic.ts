import { load } from 'cheerio';
import type { CampusReader } from './timetable-sync';
import { parseSemesterPage, parseUndergradTable, UNDERGRAD_TABLE_URL, TimetableFormatError } from './timetable';

/**
 * 教务系统里的培养方案完成情况和选课结果（本科，只读）。
 *
 * 这两个页面没有公开的接口文档：
 * - 选课结果：课表接口按学期返回选上的课（教学班），当前学期和下学期都能读；选课页面上的轮次信息尽量读出。
 * - 培养方案完成情况：先试数据接口；读不到时在隐藏窗口里打开页面，把页面上的表格原样读出来交给模型理解，
 *   不依赖猜测的数据格式。
 */
const JW = 'https://fdjwgl.fudan.edu.cn/student/for-std';
export const PROGRAM_PAGE = `${JW}/program-completion-preview`;
export const COURSE_SELECT_PAGE = `${JW}/course-select`;

export interface PageTable { caption?: string; header: string[]; rows: string[][] }

/** 页面里的表格（表头 + 行），空行去掉；同一页可能有多个表 */
export function extractTables(html: string): PageTable[] {
  const $ = load(html);
  const out: PageTable[] = [];
  $('table').each((_i, table) => {
    const cell = (el: Parameters<typeof $>[0]) => $(el).text().replace(/\s+/g, ' ').trim();
    const rows = $(table).find('tr').toArray().map((tr) => $(tr).find('th, td').toArray().map(cell));
    const nonEmpty = rows.filter((r) => r.some(Boolean));
    if (nonEmpty.length < 2) return;
    const headerIdx = nonEmpty.findIndex((r) => $(table).find('tr').eq(rows.indexOf(r)).find('th').length > 0);
    const header = nonEmpty[headerIdx >= 0 ? headerIdx : 0];
    const body = nonEmpty.filter((r) => r !== header).slice(0, 200);
    const caption = $(table).find('caption').text().trim() || $(table).prevAll('h1,h2,h3,h4,.title,legend').first().text().replace(/\s+/g, ' ').trim() || undefined;
    out.push({ caption, header, rows: body });
  });
  return out;
}

/** 表格转成给模型看的紧凑文本 */
export function tablesToText(tables: PageTable[], max = 8000): string {
  return tables.map((t) => [t.caption ? `【${t.caption}】` : '', t.header.join(' | '), ...t.rows.map((r) => r.join(' | '))].filter(Boolean).join('\n')).join('\n\n').slice(0, max);
}

export interface ProgramCompletion {
  /** 学分相关的汇总行：类别、要求、已获得（能识别表头时） */
  modules: { name: string; required?: number; earned?: number; remaining?: number }[];
  /** 页面表格的文本（识别不了表头时也有） */
  text: string;
  source: 'json' | 'page';
  updatedAt: string;
}

const NUM = (s?: string) => (s && /^-?\d+(\.\d+)?$/.test(s.trim()) ? Number(s) : undefined);

/** 从表格里认出「类别 / 要求学分 / 已获学分」 */
export function summarizeProgramTables(tables: PageTable[]): ProgramCompletion['modules'] {
  const out: ProgramCompletion['modules'] = [];
  for (const t of tables) {
    const idx = (re: RegExp) => t.header.findIndex((h) => re.test(h));
    const name = idx(/类别|模块|课程组|名称|分类/);
    const required = idx(/要求|应修|最低/);
    const earned = idx(/已(获|修|得|完成)|实修|获得/);
    const remaining = idx(/还需|差额|尚需|未完成|缺/);
    if (name < 0 || (required < 0 && earned < 0)) continue;
    for (const r of t.rows) {
      if (!r[name]) continue;
      out.push({ name: r[name], required: NUM(r[required]), earned: NUM(r[earned]), remaining: NUM(r[remaining]) ?? (NUM(r[required]) !== undefined && NUM(r[earned]) !== undefined ? Math.max(0, NUM(r[required])! - NUM(r[earned])!) : undefined) });
    }
  }
  return out.slice(0, 60);
}

/** 数据接口返回的 JSON：不认识结构时，把它压平成「路径: 值」的文本交给模型 */
function flattenJson(value: unknown, prefix = '', out: string[] = [], depth = 0): string[] {
  if (out.length > 400 || depth > 6) return out;
  if (Array.isArray(value)) value.slice(0, 80).forEach((v, i) => flattenJson(v, `${prefix}[${i}]`, out, depth + 1));
  else if (value && typeof value === 'object') for (const [k, v] of Object.entries(value)) flattenJson(v, prefix ? `${prefix}.${k}` : k, out, depth + 1);
  else if (value !== null && value !== undefined && value !== '') out.push(`${prefix}: ${String(value).slice(0, 80)}`);
  return out;
}

export async function readProgramCompletion(reader: CampusReader, studentId: string): Promise<ProgramCompletion> {
  const now = new Date().toISOString();
  for (const url of [`${PROGRAM_PAGE}/json/${studentId}`, `${PROGRAM_PAGE}/info/${studentId}`]) {
    try {
      const res = await reader.getText(url);
      if (res.status >= 400) continue;
      try {
        const data = JSON.parse(res.text) as unknown;
        return { modules: [], text: flattenJson(data).join('\n').slice(0, 8000), source: 'json', updatedAt: now };
      } catch { /* 不是 JSON，看看是不是带表格的页面 */ }
      const tables = extractTables(res.text);
      if (tables.length) return { modules: summarizeProgramTables(tables), text: tablesToText(tables), source: 'page', updatedAt: now };
    } catch (e) {
      if ((e as Error).name === 'NeedLoginError') throw e;
    }
  }
  if (!reader.render) throw new Error('教务系统没有返回培养方案完成情况。');
  const html = await reader.render(PROGRAM_PAGE, (h) => /<table/i.test(h) && /学分/.test(h));
  const tables = extractTables(html);
  if (!tables.length) throw new Error('没有在教务系统里读到培养方案完成情况（页面可能还没开放或改版了）。');
  return { modules: summarizeProgramTables(tables), text: tablesToText(tables), source: 'page', updatedAt: now };
}

export interface SelectedCourses {
  semester: string;
  courses: { course: string; teachers: string[]; credits?: number; sessions: string[] }[];
  totalCredits?: number;
  /** 选课页面上的轮次信息（读得到时） */
  rounds?: string;
}

const WD = ['', '一', '二', '三', '四', '五', '六', '日'];

/** 选课结果：某学期课表里的课。which：current 当前学期、next 下学期，或学期名关键词 */
export async function readSelectedCourses(reader: CampusReader, which = 'current'): Promise<SelectedCourses> {
  const page = await reader.getText(UNDERGRAD_TABLE_URL);
  const { semesters, currentId } = parseSemesterPage(page.text);
  // 学期列表按时间倒序（最新在前）
  const curIdx = Math.max(0, semesters.findIndex((s) => s.id === currentId));
  const target = which === 'current' ? semesters[curIdx]
    : which === 'next' ? semesters[curIdx - 1]
    : semesters.find((s) => s.name.includes(which));
  if (!target) throw new Error(which === 'next' ? '教务系统里还没有下学期（选课可能还没开始）。' : `没有找到学期「${which}」。`);
  const data = await reader.getText(`${UNDERGRAD_TABLE_URL}/semester/${target.id}/print-data`);
  let activities: Record<string, unknown>[] = [];
  try { activities = (JSON.parse(data.text) as { studentTableVms?: { activities?: Record<string, unknown>[] }[] }).studentTableVms?.[0]?.activities ?? []; } catch { throw new TimetableFormatError(); }
  const entries = parseUndergradTable(data.text);
  const creditsOf = new Map<string, number>();
  for (const a of activities) {
    const v = typeof a.credits === 'number' ? a.credits : typeof a.credits === 'string' && Number.isFinite(Number(a.credits)) ? Number(a.credits) : undefined;
    if (typeof a.courseName === 'string' && v !== undefined) creditsOf.set(a.courseName.trim(), v);
  }
  const byCourse = new Map<string, SelectedCourses['courses'][number]>();
  entries.forEach((e) => {
    const credits = creditsOf.get(e.course);
    const c = byCourse.get(e.course) ?? { course: e.course, teachers: [], credits, sessions: [] };
    for (const t of e.teachers) if (!c.teachers.includes(t)) c.teachers.push(t);
    const weeks = e.weeks.length ? `${e.weeks[0]}–${e.weeks.at(-1)}周` : '';
    c.sessions.push(`周${WD[e.weekday]} 第${e.startPeriod}–${e.endPeriod}节${e.location ? ` ${e.location}` : ''}${weeks ? ` ${weeks}` : ''}`);
    byCourse.set(e.course, c);
  });
  const courses = [...byCourse.values()];
  const withCredits = courses.filter((c) => c.credits !== undefined);
  let rounds: string | undefined;
  if (reader.render) {
    try {
      const html = await reader.render(COURSE_SELECT_PAGE, (h) => /选课|轮次/.test(h) && !/加载中/.test(h));
      const text = load(html)('body').text().replace(/\s+/g, ' ').trim();
      const m = text.match(/.{0,40}(?:轮次|选课时间|开放时间|第[一二三四]轮).{0,200}/);
      rounds = m?.[0];
    } catch { /* 选课页面读不到不影响选课结果 */ }
  }
  return { semester: target.name, courses, totalCredits: withCredits.length === courses.length && courses.length ? withCredits.reduce((n, c) => n + c.credits!, 0) : undefined, rounds };
}
