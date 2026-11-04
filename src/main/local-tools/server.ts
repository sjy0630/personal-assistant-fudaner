import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Repo } from '../db/repo';
import type { Channels } from '../engine/channels';
import { buildToday } from '../today';

const json = (data: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] });

/**
 * fudaner-local MCP 服务（PRD §7.5）：记忆、目标、跟进、动态、资源库、搜索。
 * 只写本地数据，不触碰任何校内平台。写操作会在对话里展示结果，用户可以撤销。
 *
 * scope = 'executor' 时只暴露后台工单可用的工具（PRD §7.8 执行器的受限工具集）。
 */
export function createLocalServer(repo: Repo, channels: Channels, scope: 'chat' | 'executor' = 'chat'): McpServer {
  const server = new McpServer({ name: 'fudaner-local', version: '0.1.0' });
  const ro = { readOnlyHint: true };
  const chatOnly = scope === 'chat';

  // ---------- 记忆 ----------
  server.registerTool('recall', {
    description: '按话题检索关于用户的长期记忆（偏好、固定安排、目标、人物、近况、兴趣）',
    inputSchema: { query: z.string() }, annotations: ro,
  }, async ({ query }) => json(repo.recallMemories(query)));

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
    inputSchema: { title: z.string(), level: z.enum(['long_term', 'week']), due_at: z.string().optional(), description: z.string().optional() },
  }, async (a) => {
    const g = repo.addGoal({ level: a.level, title: a.title, dueAt: a.due_at, description: a.description, createdBy: 'assistant' });
    channels.changed('goals');
    return json(g);
  });

  server.registerTool('add_task', {
    description: '给目标添加一个任务（拆解目标、制定计划时使用）',
    inputSchema: { goal_id: z.string().optional(), title: z.string(), due_at: z.string().optional() },
  }, async (a) => {
    const t = repo.addTask({ goalId: a.goal_id, title: a.title, dueAt: a.due_at, source: 'assistant' });
    channels.changed('goals');
    return json(t);
  });

  if (chatOnly) {
    server.registerTool('update_progress', {
      description: '更新任务状态（用户说「写完了」时）',
      inputSchema: { task_id: z.string(), status: z.enum(['todo', 'done', 'skipped']) },
    }, async ({ task_id, status }) => { repo.setTaskStatus(task_id, status); channels.changed('goals'); return json({ ok: true }); });

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

  // ---------- 搜索 ----------
  server.registerTool('search_all', {
    description: '全局搜索：对话、动态、目标、任务、资源、邮件、作业、记忆',
    inputSchema: { query: z.string() }, annotations: ro,
  }, async ({ query }) => json(repo.search(query)));

  return server;
}
