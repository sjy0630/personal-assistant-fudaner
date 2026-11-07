import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Repo } from '../db/repo';
import type { Channels } from '../engine/channels';
import { buildToday } from '../today';
import { lexicalScore } from '../ai/memory-recall';
import type { Item } from '../../shared/types';
import type { ImportResult } from '../activities/sync';
import type { LiteratureQuery, LiteratureRecord } from '../sources/library-search';
import type { TreeholeApi } from '../sources/treehole';
import { changeNoticeFollows, noticeFollowState, noticeView } from '../notices/sync';
import { findNoticeSource, NOTICE_SOURCES } from '../notices/sources';
import { describeRepeat, nextOccurrence, validateRepeat } from '../engine/reminders';
import type { ReminderRepeat } from '../../shared/types';

/** 活动给模型看的样子：时间换成上海时间的说法，去掉正文 */
function activityView(i: Item) {
  const a = i.activity ?? {};
  return {
    item_id: i.id, title: i.title, starts_at: a.startsAt, time: a.timeText, location: a.location, campus: a.campus, category: a.category,
    organizer: a.organizer, speaker: a.speaker, signup: a.signup, signup_deadline: a.signupDeadline, summary: a.summary,
    source: a.sourceName, url: i.url,
  };
}

const json = (data: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] });
const isoDueAt = z.iso.datetime({ offset: true });

/** 没有截止时间用 undefined；拒绝本地歧义时间、无效日期和 NaN。 */
function optionalDueAt(value?: string): string | undefined {
  const text = value?.trim();
  if (!text) return undefined;
  if (!isoDueAt.safeParse(text).success || !Number.isFinite(Date.parse(text))) {
    throw new Error('due_at 必须是合法且带时区的 ISO 时间，例如 2026-11-10T23:59:00+08:00；没有截止时间请省略或传空字符串。');
  }
  return new Date(text).toISOString();
}

const dueAtDescription = '带时区的 ISO 截止时间，例如 2026-11-10T23:59:00+08:00；没有截止时间时省略或传空字符串';

/**
 * fudaner-local MCP 服务（PRD §7.5）：记忆、目标、跟进、动态、资源库、搜索。
 * 只写本地数据，不触碰任何校内平台。写操作会在对话里展示结果，用户可以撤销。
 *
 * scope = 'executor' 时只暴露后台工单可用的工具（PRD §7.8 执行器的受限工具集）。
 */
export function createLocalServer(
  repo: Repo, channels: Channels, scope: 'chat' | 'executor' = 'chat',
  extras: {
    importArticle?: (url: string) => Promise<ImportResult>;
    library?: () => Promise<unknown>;
    cardBalance?: () => Promise<{ balance: number; at: string }>;
    literature?: { search(q: LiteratureQuery): Promise<{ total: number; records: LiteratureRecord[]; searchUrl: string }>; get(id: string): LiteratureRecord | undefined };
    treehole?: () => TreeholeApi;
    electricity?: () => Promise<unknown>;
    grades?: () => Promise<{ semesters: { name: string; courses: unknown[] }[]; gpa?: number; credits: number; updatedAt: string }>;
    gpaRank?: () => Promise<unknown>;
    program?: () => Promise<unknown>;
    selected?: (which: string) => Promise<unknown>;
  } = {},
): McpServer {
  const server = new McpServer({ name: 'fudaner-local', version: '0.1.0' });
  const ro = { readOnlyHint: true };
  const chatOnly = scope === 'chat';

  // ---------- 记忆 ----------
  server.registerTool('recall', {
    description: '按话题检索关于用户的长期记忆（偏好、固定安排、目标、人物、近况、兴趣）',
    inputSchema: { query: z.string() }, annotations: ro,
  }, async ({ query }) => json(repo.recallMemories(query)));

  server.registerTool('recall_conversation', {
    description: '在和用户更早的聊天记录里找回聊过的事（最近的对话和摘要里没有时用）。用户说「上次 / 之前 / 那天聊的…」「我跟你说过…」时先查这个。返回按话题整理的早先对话分段和相关的原话（带日期和 message_id）；要看某条前后的完整对话，传 message_id。',
    inputSchema: {
      query: z.string().optional().describe('要找的事，如「交换申请」「数据结构期中」'),
      message_id: z.string().optional().describe('看这条消息前后的对话'),
    },
    annotations: ro,
  }, async ({ query, message_id }) => {
    const brief = (m: { id: string; role: string; content: string; createdAt: string }, n: number) => ({ message_id: m.id, role: m.role === 'user' ? '用户' : '助理', at: m.createdAt, content: m.content.slice(0, n) });
    if (message_id) return json({ around: repo.conversationAround(message_id).map((m) => brief(m, 1200)) });
    const q = (query ?? '').trim();
    if (!q) return json({ error: '请给出要找的事（query）或 message_id' });
    const episodes = repo.listEpisodes().map((e) => ({ e, s: lexicalScore(q, `${e.title}：${e.content}`) })).filter((x) => x.s >= 1)
      .sort((a, b) => b.s - a.s).slice(0, 5).map(({ e }) => ({ title: e.title, from: e.startedAt, to: e.endedAt, content: e.content }));
    const messages = repo.searchOldMessages(q, { skipRecent: 0, limit: 8, minScore: 1.5 }).map(({ message }) => brief(message, 400));
    return json({ episodes, messages, note: episodes.length || messages.length ? undefined : '早先的聊天记录里没有找到相关内容。' });
  });

  server.registerTool('get_profile', { description: '读取用户画像', inputSchema: {}, annotations: ro }, async () => json(repo.getProfile()));

  server.registerTool('get_today', {
    description: '查询某一天的概况：当天课程（时间、地点）、空闲时段、7 天内的 DDL、待回复邮件数、本周任务进度。安排时间、问「今天/明天有什么课」时使用',
    inputSchema: { date: z.string().optional().describe('ISO 日期，默认今天') }, annotations: ro,
  }, async ({ date }) => json(buildToday(repo, date ? new Date(date) : new Date())));

  if (chatOnly) {
    server.registerTool('remember', {
      description: '记住一条关于用户的长期信息。只记对以后有用的稳定信息，不记密码等敏感信息。',
      inputSchema: {
        content: z.string().describe('一句话，如「周二晚上有社团活动」'),
        type: z.enum(['preference', 'schedule', 'goal', 'person', 'status', 'interest']),
      },
    }, async ({ content, type }) => json(repo.addMemory({ type, content, source: 'chat' })));

    server.registerTool('forget', {
      description: '删除一条记忆', inputSchema: { id: z.string() },
    }, async ({ id }) => { repo.removeMemory(id); return json({ ok: true }); });
  }

  // ---------- 目标与任务 ----------
  server.registerTool('list_goals', {
    description: '列出目标（长期目标 / 本学期课程 / 本周）及其任务和进度',
    inputSchema: { level: z.enum(['long_term', 'course', 'week']).optional() }, annotations: ro,
  }, async ({ level }) => {
    const goals = repo.listGoals().filter((g) => !level || g.level === level);
    return json(goals.map((g) => {
      const tasks = repo.listTasks({ goalId: g.id });
      return { ...g, progress: `${tasks.filter((t) => t.status === 'done').length}/${tasks.length}`, tasks };
    }));
  });

  server.registerTool('list_deadlines', {
    description: '列出某个时间范围内的 DDL（作业截止）及提交状态',
    inputSchema: { from: z.string().optional().describe('ISO 时间，默认现在'), to: z.string().describe('ISO 时间') }, annotations: ro,
  }, async ({ from, to }) => json(repo.listItems({ kind: 'assignment', dueAfter: from ?? new Date().toISOString(), dueBefore: to })
    .map((i) => ({ id: i.id, title: i.title, course: i.courseId ? repo.getCourse(i.courseId)?.name : undefined, dueAt: i.dueAt, submitted: i.done }))));

  server.registerTool('create_goal', {
    description: '创建一个目标（例如「申请 2027 春季交换」），之后可以用 add_task 拆解成带日期的任务',
    inputSchema: { title: z.string(), level: z.enum(['long_term', 'week']), due_at: z.string().optional().describe(dueAtDescription), description: z.string().optional() },
  }, async (a) => {
    const dueAt = optionalDueAt(a.due_at);
    const g = repo.addGoal({ level: a.level, title: a.title, dueAt, description: a.description, createdBy: 'assistant' });
    channels.changed('goals');
    return json(g);
  });

  server.registerTool('add_task', {
    description: '给目标添加一个任务（拆解目标、制定计划时使用）。goal_id 必须使用 create_goal 或 list_goals 返回的真实 id，不能用目标标题代替',
    inputSchema: { goal_id: z.string().optional().describe('create_goal 或 list_goals 返回的真实目标 id；不是目标标题'), title: z.string(), due_at: z.string().optional().describe(dueAtDescription) },
  }, async (a) => {
    const dueAt = optionalDueAt(a.due_at);
    const goalId = a.goal_id?.trim();
    if (a.goal_id !== undefined && (!goalId || !repo.getGoal(goalId))) {
      throw new Error('goal_id 对应的目标不存在。请使用 create_goal 或 list_goals 返回的真实 id，不能使用目标标题；不关联目标时请省略 goal_id。');
    }
    const t = repo.addTask({ goalId, title: a.title, dueAt, source: 'assistant' });
    channels.changed('goals');
    return json(t);
  });

  if (chatOnly) {
    server.registerTool('update_progress', {
      description: '更新任务状态（用户说「写完了」时）',
      inputSchema: { task_id: z.string(), status: z.enum(['todo', 'done', 'skipped']) },
    }, async ({ task_id, status }) => {
      if (!repo.getTask(task_id)) throw new Error('task_id 对应的任务不存在。请使用 add_task 或 list_goals 返回的真实任务 id，不能使用任务标题。');
      repo.setTaskStatus(task_id, status); channels.changed('goals'); return json({ ok: true });
    });

    server.registerTool('mark_item_done', {
      description: '在应用里把邮件标记为「已处理」（不再出现在待回复里），或把作业标记为「已完成」（如组作业由组长提交、线下已交）。只改本地状态，不改邮箱或 eLearning。用户说「这封不用回了」「这个作业组长交了」时使用。',
      inputSchema: {
        item_id: z.string().describe('事项 id：search_mail / list_action_required / list_deadlines 等工具返回的真实 id'),
        done: z.boolean().optional().describe('默认 true；false 表示撤销标记'),
      },
    }, async ({ item_id, done }) => {
      const item = repo.getItem(item_id);
      if (!item || (item.kind !== 'email' && item.kind !== 'assignment')) {
        throw new Error('item_id 对应的邮件或作业不存在。请先用搜索或列表工具查到真实的事项 id，不能使用标题。');
      }
      repo.markItemDone(item_id, done ?? true);
      channels.changed('goals');
      channels.changed('feed');
      return json({ ok: true, kind: item.kind, title: item.title, done: done ?? true, note: '只改了应用里的状态，邮箱和 eLearning 上没有变化' });
    });

    server.registerTool('schedule_followup', {
      description: '安排一次跟进：到时间后助理会主动问进展。用户提到计划或承诺时使用（如「今晚写 Lab 5」→ 明早跟进）',
      inputSchema: {
        topic: z.string().describe('跟进的事，如「Lab 5 写完了吗」'),
        at: z.string().describe('ISO 时间'),
        assignment_item_id: z.string().optional().describe('相关作业的事项 ID；如果作业在平台上已提交，跟进会自动取消'),
      },
    }, async (a) => json(repo.addFollowup({
      topic: a.topic, dueAt: a.at, itemId: a.assignment_item_id,
      verify: a.assignment_item_id ? { type: 'assignment_submitted', itemId: a.assignment_item_id } : undefined,
    })));
  }

  if (chatOnly) {
    // ---------- 通过对话调整设置：画像、关注的官网通知 ----------
    server.registerTool('update_profile', {
      description: '更新用户画像（院系、专业、年级、学历、昵称）。用户在对话里说「我是经院大二的」「我在读研」时使用；院系和学历会影响自动关注哪些官网通知、读哪个系统的课表。改了什么要告诉用户',
      inputSchema: {
        nickname: z.string().max(30).optional(), school: z.string().max(40).optional().describe('院系全称或常用简称，如「经济学院」'),
        major: z.string().max(40).optional(), grade: z.string().max(20).optional().describe('如「大二」「研一」'),
        degree: z.enum(['本科', '硕士', '博士']).optional(),
        student_number: z.string().regex(/^\d{8,12}$/).optional().describe('学号，只用来在绩点排名里找到本人'),
      },
    }, async (a) => {
      const { student_number: studentNumber, ...rest } = a;
      const patch: Record<string, unknown> = Object.fromEntries(Object.entries({ ...rest, studentNumber }).filter(([, v]) => v !== undefined && v !== ''));
      // 「经院」「计院」这类简称存成全称，方便认出本院系的通知
      if (typeof patch.school === 'string') {
        const s = findNoticeSource(patch.school);
        if (s?.group === '院系') patch.school = s.name;
      }
      if (!Object.keys(patch).length) throw new Error('没有要更新的内容。');
      repo.setProfile(patch);
      const follow = noticeFollowState(repo);
      return json({ ok: true, profile: repo.getProfile(), notices: follow.mode === 'auto' ? `已按新的画像自动关注：${follow.following.map((s) => s.name).join('、')}` : undefined });
    });

    server.registerTool('list_notice_sources', {
      description: '查看现在关注了哪些学校和院系官网通知（auto 表示按院系、学历、兴趣自动选的，并附理由），以及还可以关注哪些',
      inputSchema: {}, annotations: ro,
    }, async () => {
      const state = noticeFollowState(repo);
      const on = new Set(state.following.map((s) => s.id));
      return json({ ...state, available: NOTICE_SOURCES.filter((s) => !on.has(s.id)).map((s) => `${s.name}（${s.group}）`) });
    });

    server.registerTool('follow_notice_sources', {
      description: '关注或取消关注学校和院系的官网通知。用户说「也关注一下国际交流处」「别推保卫处的了」，或者聊到兴趣（想交换 → 国际合作与交流处；想保研 → 研究生院和本院系）时使用，并告诉用户改了什么。名称可以用简称',
      inputSchema: {
        follow: z.array(z.string()).optional().describe('要关注的来源名称或 id，如「国际合作与交流处」「经院」'),
        unfollow: z.array(z.string()).optional(),
      },
    }, async (a) => {
      const r = changeNoticeFollows(repo, a.follow, a.unfollow);
      channels.changed('feed');
      return json({ ...r, note: r.unknown.length ? `没找到：${r.unknown.join('、')}。可以用 list_notice_sources 看可选的来源。` : undefined });
    });

    // ---------- 定时提醒 / 定时任务 ----------
    server.registerTool('create_reminder', {
      description: '创建定时提醒或定时任务。用户说「每天 22:00 提醒我背单词」「明早 8 点叫我交表」「每周一早上帮我汇总上周的通知和本周 DDL」时使用。'
        + 'kind=remind：到点弹通知提醒一句；kind=task：到点由你自动完成 prompt 里的事并把结果发到对话里。'
        + '一次性用 repeat=once 和 at（带时区的 ISO 时间）；重复的用 daily / weekdays（周一到周五）/ weekly（配 weekdays 数组，1=周一…7=周日）和 time（HH:MM）。创建后把时间复述给用户。',
      inputSchema: {
        title: z.string().min(1).max(60).describe('简短标题，如「背单词」「周一汇总」'),
        kind: z.enum(['remind', 'task']),
        prompt: z.string().max(1000).optional().describe('remind：到点要说的话；task：到时要做的事，写清楚，如「汇总上周新的学校通知、本周 DDL 和考试，给出本周安排建议」'),
        repeat: z.enum(['once', 'daily', 'weekdays', 'weekly']),
        at: z.string().optional().describe('repeat=once 时必填：带时区的 ISO 时间，如 2026-11-08T08:00:00+08:00'),
        time: z.string().optional().describe('重复提醒的时间 HH:MM（上海时间）'),
        weekdays: z.array(z.number().int().min(1).max(7)).optional().describe('repeat=weekly 时：星期几，1=周一…7=周日'),
      },
    }, async (a) => {
      const repeat: ReminderRepeat = a.repeat === 'once' ? { type: 'once', at: a.at ?? '' }
        : a.repeat === 'daily' ? { type: 'daily', time: a.time ?? '' }
        : { type: 'weekly', time: a.time ?? '', weekdays: a.repeat === 'weekdays' ? [1, 2, 3, 4, 5] : a.weekdays ?? [] };
      const problem = validateRepeat(repeat);
      if (problem) throw new Error(problem);
      const next = nextOccurrence(repeat, new Date());
      if (!next) throw new Error('这个时间已经过去了，请换一个将来的时间。');
      const r = repo.addReminder({ title: a.title, kind: a.kind, prompt: a.prompt, repeat, createdBy: 'chat', nextAt: next.toISOString() });
      channels.changed('goals');
      return json({ ok: true, id: r.id, title: r.title, kind: r.kind, schedule: describeRepeat(repeat), next_at: r.nextAt, note: '可以在「设置 → 助理 → 定时提醒」里查看、暂停或删除' });
    });

    server.registerTool('list_reminders', {
      description: '列出用户设置的定时提醒和定时任务', inputSchema: {}, annotations: ro,
    }, async () => json(repo.listReminders().map((r) => ({ id: r.id, title: r.title, kind: r.kind, prompt: r.prompt, schedule: describeRepeat(r.repeat), enabled: r.enabled, next_at: r.nextAt }))));

    server.registerTool('cancel_reminder', {
      description: '删除一个定时提醒或定时任务。先用 list_reminders 找到真实 id',
      inputSchema: { id: z.string() },
    }, async ({ id }) => {
      const r = repo.getReminder(id);
      if (!r) throw new Error('id 对应的提醒不存在。请先用 list_reminders 查到真实 id。');
      repo.removeReminder(id);
      return json({ ok: true, removed: r.title });
    });

    server.registerTool('start_background_task', {
      description: '把一件需要较长时间的整理工作交给后台执行（如整理申请材料清单、做复习提纲），完成后成果会放进资源库并通知用户。用户明确提出请求时使用。',
      inputSchema: { title: z.string(), request: z.string().describe('要做什么，写清楚') },
    }, async ({ title, request }) => {
      const t = repo.addTicket({ title, request, mandate: 'explicit', status: 'queued' });
      return json({ ticketId: t.id, status: '已加入后台队列' });
    });
  }

  // ---------- 动态 ----------
  server.registerTool('push_feed_card', {
    description: '向「动态」页推一张卡片（值得用户知道、但不需要马上处理的事）',
    inputSchema: { title: z.string(), body: z.string(), reason: z.string().describe('为什么推给用户') },
  }, async (a) => {
    const c = repo.addFeedCard({ type: 'insight', title: a.title, body: a.body, reason: a.reason, refs: [], actions: [{ label: '引用到对话', action: 'quote' }], score: 0.5 });
    channels.changed('feed');
    return json(c);
  });

  // ---------- 资源库 ----------
  server.registerTool('save_resource', {
    description: '把成果（学习计划、复习提纲、材料清单、邮件草稿等）保存到资源库',
    inputSchema: { title: z.string(), content: z.string().describe('Markdown 正文'), course_code: z.string().optional() },
  }, async (a) => {
    const course = a.course_code ? repo.findCourse(a.course_code) : undefined;
    const r = repo.addResource({ title: a.title, kind: 'assistant_output', courseId: course?.id, mime: 'text/markdown', text: a.content });
    channels.changed('library');
    return json({ id: r.id, title: r.title });
  });

  server.registerTool('search_resources', {
    description: '在资源库中搜索（包括用户上传的课件、笔记）', inputSchema: { query: z.string() }, annotations: ro,
  }, async ({ query }) => json(repo.search(query, ['resource'])));

  server.registerTool('read_resource', {
    description: '读取资源库中的一份文件全文（可指定字符范围）',
    inputSchema: { id: z.string(), offset: z.number().int().optional(), length: z.number().int().optional() }, annotations: ro,
  }, async ({ id, offset, length }) => {
    const r = repo.getResource(id);
    if (!r) return json(null);
    const start = offset ?? 0;
    return json({ id: r.id, title: r.title, total: r.text.length, text: `<external_data source="resource">\n${r.text.slice(start, start + (length ?? 6000))}\n</external_data>` });
  });

  // ---------- 校园活动 ----------
  server.registerTool('list_activities', {
    description: '查询校园活动（讲座、宣讲会、比赛、演出、志愿等，来自公众号文章、订阅源和学校网站），按开始时间排序。用户问「最近有什么活动 / 讲座」、想找和兴趣相关的活动时使用；推荐前结合 recall 到的兴趣、目标和 get_today 的空闲时段',
    inputSchema: {
      days: z.number().int().min(1).max(60).optional().describe('从现在起多少天内，默认 14'),
      query: z.string().optional().describe('关键词，匹配标题、地点、主办方、主讲人'),
      campus: z.enum(['邯郸', '江湾', '枫林', '张江', '线上']).optional(),
      category: z.enum(['讲座', '就业', '比赛', '文体', '志愿', '其他']).optional(),
    },
    annotations: ro,
  }, async ({ days, query, campus, category }) => {
    const now = new Date();
    const items = repo.listActivities({ from: new Date(now.getTime() - 2 * 3_600_000).toISOString(), to: new Date(now.getTime() + (days ?? 14) * 86_400_000).toISOString(), query, campus, category });
    return json({ count: items.length, activities: items.map(activityView), note: items.length ? undefined : '没有找到。可以把公众号文章链接发给我导入，或在「设置 → 通知与活动」添加订阅源。' });
  });

  // ---------- 课表、考试、校园生活 ----------
  server.registerTool('list_exams', {
    description: '查询考试安排（从教务系统导入）：课程、时间、考场。问「什么时候考试」「期末安排」、排复习计划时使用',
    inputSchema: { days: z.number().int().min(1).max(120).optional().describe('从现在起多少天内，默认 60') },
    annotations: ro,
  }, async ({ days }) => {
    const now = Date.now();
    const exams = repo.listItems({ kind: 'exam', dueAfter: new Date(now).toISOString(), dueBefore: new Date(now + (days ?? 60) * 86_400_000).toISOString(), limit: 50 });
    return json({
      count: exams.length,
      exams: exams.map((e) => ({ item_id: e.id, course: e.title.replace(/ 考试$/, ''), starts_at: e.dueAt, time: e.body.split('\n')[0], location: e.body.split('\n')[1] })),
      note: exams.length ? undefined : '没有考试记录。可能还没导入考试安排（设置 → 复旦账号 → 课表与考试），或教务系统还没排考。',
    });
  });

  server.registerTool('get_week_schedule', {
    description: '查询某一周每天的课（来自导入的真实课表，按教学周过滤单双周）和空闲时段。排一周计划、问「这周哪天下午有空」时使用',
    inputSchema: { start_date: z.string().optional().describe('这一周中任意一天的 ISO 日期，默认今天') },
    annotations: ro,
  }, async ({ start_date }) => {
    const base = start_date ? new Date(start_date) : new Date();
    const monday = new Date(base);
    monday.setDate(base.getDate() - ((base.getDay() + 6) % 7));
    const days = Array.from({ length: 7 }, (_, i) => {
      const d = new Date(monday.getTime() + i * 86_400_000);
      const t = buildToday(repo, d);
      return { date: t.date, week: t.weekNo, courses: t.courses, free: t.freeSlots };
    });
    return json({ days, meta: repo.getKv('timetable_meta', null) });
  });

  if (extras.library) {
    const library = extras.library;
    server.registerTool('get_library_status', {
      description: '查询复旦各图书馆现在的在馆人数和还能进入的人数、开放时间。用户想去图书馆自习、问「哪个馆人少」时使用',
      inputSchema: {}, annotations: ro,
    }, async () => json(await library()));
  }
  if (extras.cardBalance) {
    const cardBalance = extras.cardBalance;
    server.registerTool('get_campus_card_balance', {
      description: '查询本人校园卡余额（只读，复用复旦账号登录状态）。用户问「卡里还有多少钱」时使用',
      inputSchema: {}, annotations: ro,
    }, async () => json(await cardBalance()));
  }

  // ---------- 图书馆文献检索 ----------
  if (extras.literature) {
    const lit = extras.literature;
    const brief = (r: LiteratureRecord) => ({ ...r, abstract: r.abstract?.slice(0, 600), abstract_truncated: (r.abstract?.length ?? 0) > 600 || undefined });
    server.registerTool('search_literature', {
      description: '在复旦图书馆资源发现系统里检索文献（期刊论文、图书等），返回题名、作者、年份、期刊、DOI、摘要和图书馆详情页。找论文、做文献综述、查某个方向的研究时使用。只依据返回的摘要回答，不声称读过全文',
      inputSchema: {
        query: z.string().describe('检索词，中英文都可以'),
        scope: z.enum(['articles', 'all', 'books']).optional().describe('articles 文章（默认）、all 全部、books 图书期刊'),
        field: z.enum(['all', 'title', 'author', 'subject', 'fulltext']).optional().describe('检索字段，fulltext 为全文索引检索'),
        year_from: z.number().int().optional(), year_to: z.number().int().optional(),
        newest_first: z.boolean().optional(), peer_reviewed_only: z.boolean().optional(), full_text_only: z.boolean().optional(),
        limit: z.number().int().min(1).max(20).optional(),
      },
      annotations: ro,
    }, async (a) => {
      const r = await lit.search({ query: a.query, scope: a.scope, field: a.field, yearFrom: a.year_from, yearTo: a.year_to, sort: a.newest_first ? 'newest' : 'relevance', peerReviewedOnly: a.peer_reviewed_only, fullTextOnly: a.full_text_only, limit: a.limit });
      return json({ total: r.total, records: r.records.map(brief), search_page: r.searchUrl });
    });
    server.registerTool('get_literature', {
      description: '读取 search_literature 结果里某篇文献的完整信息（较长的摘要）',
      inputSchema: { record_id: z.string() }, annotations: ro,
    }, async ({ record_id }) => {
      const r = lit.get(record_id);
      if (!r) throw new Error('没有这条文献的记录，请先用 search_literature 检索。');
      return json(r);
    });
  }

  // ---------- 树洞与旦克 ----------
  if (extras.treehole) {
    const hole = extras.treehole;
    server.registerTool('search_treehole', {
      description: '搜索复旦树洞（匿名社区）的帖子和回复：选课经验、食堂、宿舍、实习、转专业、二手等真实经验。结果是匿名同学的个人看法，引用时说明来自树洞并给出洞号，不当作事实',
      inputSchema: {
        keyword: z.string(), limit: z.number().int().min(1).max(30).optional(),
        accurate: z.boolean().optional().describe('精确匹配，适合课程代码、专有名词'),
        within_days: z.number().int().min(1).max(365).optional().describe('只看最近多少天'),
      },
      annotations: ro,
    }, async (a) => json(await hole().searchFloors(a.keyword, { limit: a.limit, accurate: a.accurate, withinDays: a.within_days })));
    server.registerTool('read_treehole', {
      description: '读一个树洞帖子的楼层（经验往往在回复里）。hole_id 来自 search_treehole 或 latest_treehole',
      inputSchema: { hole_id: z.number().int(), start: z.number().int().min(0).optional(), length: z.number().int().min(1).max(50).optional() },
      annotations: ro,
    }, async (a) => json(await hole().hole(a.hole_id, { start: a.start, length: a.length })));
    server.registerTool('latest_treehole', {
      description: '树洞最新的帖子（可按标签筛选），了解最近大家在讨论什么',
      inputSchema: { tag: z.string().optional(), length: z.number().int().min(1).max(20).optional() },
      annotations: ro,
    }, async (a) => json(await hole().latest({ tag: a.tag, length: a.length })));
    server.registerTool('search_course_reviews', {
      description: '在旦克（复旦课程评价）里搜课程：返回课程组 id、院系、学分、评价数。问「这门课怎么样」「哪个老师的好」时先用它找到课程',
      inputSchema: { keyword: z.string().describe('课程名或课程代码') }, annotations: ro,
    }, async (a) => json(await hole().searchCourses(a.keyword)));
    server.registerTool('get_course_reviews', {
      description: '读取旦克上某门课的评价：各老师、学期的评分（综合、内容、工作量、考核）和文字评价。course_group_id 来自 search_course_reviews',
      inputSchema: { course_group_id: z.number().int(), max_reviews: z.number().int().min(1).max(30).optional() }, annotations: ro,
    }, async (a) => json(await hole().courseReviews(a.course_group_id, a.max_reviews)));
  }

  // ---------- 成绩与绩点（敏感：只有本地模型或用户允许时才开放给云端模型，见 tool-policy） ----------
  if (extras.grades) {
    const grades = extras.grades;
    server.registerTool('get_grades', {
      description: '查询本人在教务系统里的成绩（每门课的等级、绩点、学分，按学期）和学分加权绩点。用户问「我这学期成绩」「XX 课考得怎么样」时使用',
      inputSchema: { semester: z.string().optional().describe('学期名称关键词，如「2025-2026学年2学期」；不填返回全部') },
      annotations: ro,
    }, async ({ semester }) => {
      const r = await grades();
      const semesters = semester ? r.semesters.filter((s) => s.name.includes(semester)) : r.semesters;
      return json({ gpa: r.gpa, credits: r.credits, semesters, updated: r.updatedAt, note: '绩点按有绩点的课程学分加权计算，P/NP 课程不计入；以教务系统为准' });
    });
  }
  if (extras.gpaRank) {
    const gpaRank = extras.gpaRank;
    server.registerTool('get_gpa', {
      description: '查询本人的绩点和在本年级本院系的排名（教务系统「我的绩点」）。只返回本人和总人数。需要学号才能在排名里找到本人：没有时请用户告诉你，用 update_profile 记下 student_number',
      inputSchema: {}, annotations: ro,
    }, async () => json(await gpaRank()));
  }

  if (extras.program) {
    const program = extras.program;
    server.registerTool('get_program_completion', {
      description: '查询本人的培养方案完成情况：各类别（通识、专业必修、专业选修等）要求学分、已获学分、还差多少。问「我还差多少学分毕业」「专业选修修够了吗」、规划选课时使用。modules 是认出来的汇总，text 是教务系统页面上表格的原文',
      inputSchema: {}, annotations: ro,
    }, async () => json(await program()));
  }
  if (extras.selected) {
    const selected = extras.selected;
    server.registerTool('get_selected_courses', {
      description: '查询选课结果：某学期选上的课（课程、老师、学分、上课时间地点）和总学分；rounds 是选课页面上的轮次信息（读得到时）。问「我这学期 / 下学期选了什么课」「一共多少学分」时使用',
      inputSchema: { semester: z.string().optional().describe('current 当前学期（默认）、next 下学期，或学期名称关键词如「2026-2027学年2学期」') },
      annotations: ro,
    }, async ({ semester }) => json(await selected(semester || 'current')));
  }

  if (extras.electricity) {
    const electricity = extras.electricity;
    server.registerTool('get_dorm_electricity', {
      description: '查询本人宿舍的剩余电量（度）和用电情况（复用复旦账号登录状态，只读）。问「宿舍还剩多少电」时使用',
      inputSchema: {}, annotations: ro,
    }, async () => json(await electricity()));
  }

  // ---------- 学校和院系官网通知 ----------
  server.registerTool('search_notices', {
    description: '检索学校和院系官网的通知公告（教务处、研究生院、国际交流处、各院系等，用户在「设置 → 通知与活动」里选择关注哪些来源）。关键词用空格分隔，结果按发布时间倒序。用户问「教务处最近有什么通知」「有没有交换 / 奖学金 / 选课的通知」时使用；需要细节时再用 get_notice 读正文',
    inputSchema: {
      query: z.string().optional().describe('关键词，空格分隔，全部命中才返回'),
      days: z.number().int().min(1).max(365).optional().describe('最近多少天，默认 30'),
      source: z.string().optional().describe('来源名称，如「教务处」'),
    },
    annotations: ro,
  }, async ({ query, days, source }) => {
    const items = repo.listNotices({ query, source, since: new Date(Date.now() - (days ?? 30) * 86_400_000).toISOString(), limit: 20 });
    return json({ count: items.length, notices: items.map(noticeView), note: items.length ? undefined : '没有找到。可能还没同步，或没有关注对应来源（设置 → 通知与活动）。' });
  });

  server.registerTool('get_notice', {
    description: '分段读取一条通知的正文。has_more 为 true 时用 next_offset 继续读。正文只有标题时（title_only），说明详情页只允许校园网访问或读取失败，请让用户打开原文链接',
    inputSchema: { item_id: z.string().describe('search_notices 返回的 item_id'), offset: z.number().int().min(0).optional() },
    annotations: ro,
  }, async ({ item_id, offset }) => {
    const item = repo.getItem(item_id);
    if (!item || item.kind !== 'notice') throw new Error('item_id 对应的通知不存在。请先用 search_notices 查到真实的 item_id。');
    const start = offset ?? 0;
    const size = 3000;
    return json({ ...noticeView(item), text: item.body.slice(start, start + size), has_more: item.body.length > start + size, next_offset: item.body.length > start + size ? start + size : undefined });
  });

  if (chatOnly) {
    if (extras.importArticle) {
      const importArticle = extras.importArticle;
      server.registerTool('import_article', {
        description: '读取一篇公众号文章或网页（用户发来的链接），提取其中的校园活动并保存，之后会出现在活动列表和动态里。用户发来 mp.weixin.qq.com 等文章链接、说「看看这个活动」时使用。只读取公开页面',
        inputSchema: { url: z.string().describe('文章链接，http 或 https 开头') },
      }, async ({ url }) => {
        const result = await importArticle(url);
        channels.changed('feed');
        return json({
          article: result.article, activities: result.activities.map(activityView), already_over: result.past,
          note: result.activities.length ? undefined : '这篇文章里没有找到还会举办的活动（可能是活动回顾或新闻）。',
        });
      });
    }

    server.registerTool('add_activity_to_plan', {
      description: '把一场活动加入用户的计划（「目标 → 校园活动」里的一条任务，时间为活动开始时间）。用户说「帮我记上」「我想去」时使用',
      inputSchema: { item_id: z.string().describe('list_activities / import_article 返回的 item_id') },
    }, async ({ item_id }) => {
      const task = repo.addActivityToPlan(item_id);
      if (!task) throw new Error('item_id 对应的活动不存在。请先用 list_activities 查到真实的 item_id。');
      channels.changed('goals');
      return json({ ok: true, task });
    });
  }

  // ---------- 搜索 ----------
  server.registerTool('search_all', {
    description: '全局搜索：对话、动态、目标、任务、资源、邮件、作业、记忆',
    inputSchema: { query: z.string() }, annotations: ro,
  }, async ({ query }) => json(repo.search(query)));

  return server;
}
