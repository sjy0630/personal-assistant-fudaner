import { randomUUID } from 'node:crypto';
import type { CardRef, ChatMessage, ChatRun, PlatformState, ToolCallView } from '../../shared/types';
import type { Repo } from '../db/repo';
import type { Channels } from '../engine/channels';
import { fmt } from '../engine/engine';
import type { McpHub } from '../mcp/hub';
import { buildToday } from '../today';
import type { LlmClient, LlmMessage, LlmTool, ModelRouter } from './llm';
import { describeModelError, parseJsonLoose } from './llm';
import { externalData, memoryExtractPrompt, personaPrompt } from './prompts';
import { ConversationSummarizer } from './summary';
import { memoryOutput } from './validation';
import { createToolPolicy } from './tool-policy';
import { memoryWriteProblem } from './memory-policy';
import { queryArguments, queryRange, queryResultContext, shanghaiTime } from './query-context';
import { goalReceipt, needsGoalReceipt, focusGoalOperation, goalOperationPrompt, goalOperationTool, goalToolContext, createGoalTurn } from './goal-receipt';
import { changeNoticeFollows } from '../notices/sync';

const MAX_STEPS = 8;

/** 明确的查询问句只读；包含实际写入要求时仍保留原有工具能力。 */
function lookupOnly(text: string): boolean {
  const request = text.replace(/(?:不要|不必|不用|先别|禁止|无需)[^，。；\n]*/gu, '');
  return /查询|查看|查一下|列出|哪些|什么|几点|是否|[?？]/u.test(request)
    && !/创建|新建|添加|新增|保存|存下|存到|记住|删除|移除|标记|设为|设置|修改|改成|更新|提醒我|安排跟进|启动|执行|整理|生成/u.test(request);
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`;
  return JSON.stringify(value);
}

export interface LoopResult {
  content: string; toolCalls: ToolCallView[]; cards: CardRef[];
  finishReason: 'answer' | 'step_limit';
}

/**
 * 通用的工具调用循环：主对话智能体和后台工单执行器共用。
 * 工具结果一律用 <external_data> 包裹后交给模型，防止提示词注入。
 */
export async function runAgentLoop(opts: {
  llm: LlmClient; hub: McpHub; tools: LlmTool[]; messages: LlmMessage[];
  onTool?: (call: ToolCallView) => void;
  onDelta?: (text: string) => void;
  onCards?: (cards: CardRef[]) => void;
  onToolResult?: (result: Awaited<ReturnType<McpHub['call']>>) => void;
  authorizeTool?: (name: string, args: Record<string, unknown>) => string | undefined;
  recoverRepeatedReads?: boolean;
  normalizeToolArgs?: (name: string, args: Record<string, unknown>) => Record<string, unknown>;
  toolContext?: (text: string) => string;
  initialReads?: { name: string; args: Record<string, unknown> }[];
  /** 最多模型轮数，默认 MAX_STEPS。 */
  maxSteps?: number;
  /** 只剩最后两轮时追加一次的收尾提示（例如后台工单要求立即保存成果）。 */
  finishNotice?: string;
  signal?: AbortSignal;
}): Promise<LoopResult> {
  const { llm, hub, tools, messages } = opts;
  const calls: ToolCallView[] = [];
  const cards: CardRef[] = [];
  let streamedContent = '';
  const readResults = new Map<string, Awaited<ReturnType<McpHub['call']>>>();
  const maxSteps = opts.maxSteps ?? MAX_STEPS;
  let noticed = false;
  for (let step = opts.initialReads?.length ? -1 : 0; step < maxSteps; step++) {
    opts.signal?.throwIfAborted();
    if (opts.finishNotice && !noticed && step >= maxSteps - 2) {
      noticed = true;
      messages.push({ role: 'system', content: opts.finishNotice });
    }
    let round = '';
    const emit = (text: string) => {
      if (!text) return;
      if (!round && streamedContent) { streamedContent += '\n\n'; opts.onDelta?.('\n\n'); }
      round += text; streamedContent += text; opts.onDelta?.(text);
    };
    const r = step === -1
      ? { content: '', toolCalls: opts.initialReads!.map(read => {
        if (!hub.isReadOnly(read.name)) throw new Error('预查询只能使用明确标记为只读的工具');
        return { id: `query-${randomUUID()}`, name: read.name, arguments: JSON.stringify(read.args) };
      }) }
      : await llm.chat(messages, { tools, temperature: 0.5, signal: opts.signal, onDelta: opts.onDelta ? emit : undefined });
    opts.signal?.throwIfAborted();
    if (opts.onDelta && !round && r.content) emit(r.content);
    if (r.toolCalls.length === 0) return { content: opts.onDelta ? streamedContent : r.content, toolCalls: calls, cards, finishReason: 'answer' };
    messages.push({
      role: 'assistant', content: r.content || null,
      tool_calls: r.toolCalls.map((t) => ({ id: t.id, type: 'function' as const, function: { name: t.name, arguments: t.arguments } })),
    });
    let repeatedRead = false;
    let executed = false;
    for (const tc of r.toolCalls) {
      opts.signal?.throwIfAborted();
      // Function calling 的参数必须是完整 JSON 对象，不能从残缺文本中“修复”出写操作。
      let parsed: unknown;
      try { parsed = JSON.parse(tc.arguments); } catch { throw new Error('工具参数不完整，未执行'); }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('工具参数不完整，未执行');
      const args = opts.normalizeToolArgs?.(tc.name, parsed as Record<string, unknown>) ?? parsed as Record<string, unknown>;
      const [server, tool] = tc.name.split('__');
      const view: ToolCallView = { id: tc.id, name: tool ?? tc.name, server: (server ?? '').replace(/_/g, '-'), args };
      opts.onTool?.(view);
      const denied = opts.authorizeTool?.(tc.name, args);
      const readOnly = opts.recoverRepeatedReads && opts.hub.isReadOnly?.(tc.name) === true && args.refresh !== true;
      const key = `${server}__${tool}:${canonical(args)}`;
      const cached = !denied && readOnly ? readResults.get(key) : undefined;
      if (!denied && !cached) {
        // 写操作可能改变后续查询结果；即使它报错，也不能继续复用旧快照。
        if (!readOnly) readResults.clear();
        executed = true;
      }
      const res: Awaited<ReturnType<McpHub['call']>> = denied
        ? { server: view.server, tool: view.name, ok: false, text: denied }
        : cached ?? await hub.call(tc.name, args);
      if (cached) repeatedRead = true;
      if (readOnly && res.ok) readResults.set(key, res);
      view.ok = res.ok;
      view.summary = `${cached ? '复用本轮查询结果：' : ''}${res.text}`.slice(0, 120);
      calls.push(view);
      if (res.ok && res.server === 'fudaner-local') {
        const created = cardsFromTool(res.tool, res.text);
        cards.push(...created);
        if (created.length) opts.onCards?.(created);
      }
      if (res.ok) opts.onToolResult?.(res);
      opts.onTool?.(view);
      opts.signal?.throwIfAborted();
      messages.push({ role: 'tool', tool_call_id: tc.id, content: externalData(`${res.server}/${res.tool}`, (opts.toolContext?.(res.text) ?? res.text).slice(0, 12000)) });
      shrinkOldToolResults(messages);
    }
    if (repeatedRead && !executed) {
      // 已有相同查询结果却继续请求时，只给一次不带工具的收尾机会。
      // 不执行模型在收尾阶段仍然提出的写操作，也不将它冒充为成功。
      let finalText = '';
      const emitFinal = (text: string) => {
        if (!text) return;
        if (!finalText && streamedContent) { streamedContent += '\n\n'; opts.onDelta?.('\n\n'); }
        finalText += text; streamedContent += text; opts.onDelta?.(text);
      };
      const final = await llm.chat([...messages, { role: 'system', content: '本轮重复请求的只读查询已经成功，结果就在上方工具消息中。现在停止调用工具，直接依据已查到的数据回答用户原问题；没有查到的部分明确说明未知，不编造，不宣称未执行的写操作成功。' }], {
        tools: [], temperature: 0, maxTokens: 1500, signal: opts.signal, onDelta: opts.onDelta ? emitFinal : undefined,
      });
      opts.signal?.throwIfAborted();
      if (opts.onDelta && !finalText && final.content) emitFinal(final.content);
      if (!final.toolCalls.length && final.content.trim()) return { content: opts.onDelta ? streamedContent : final.content, toolCalls: calls, cards, finishReason: 'answer' };
      const note = '查询结果已取得，但模型仍重复请求工具，尚未完成回答。';
      if (opts.onDelta) emitFinal(`\n\n${note}`);
      return { content: opts.onDelta ? streamedContent : note, toolCalls: calls, cards, finishReason: 'step_limit' };
    }
  }
  const end = '这件事步骤有点多，我先停在这里。要我继续吗？';
  if (opts.onDelta) { const text = `${streamedContent ? '\n\n' : ''}${end}`; streamedContent += text; opts.onDelta(text); }
  return { content: opts.onDelta ? streamedContent : end, toolCalls: calls, cards, finishReason: 'step_limit' };
}

/** 写操作的结果以卡片形式出现在对话里（PRD §5.1：写操作展示结果、可撤销） */
function cardsFromTool(tool: string, text: string): CardRef[] {
  const j = parseJsonLoose<Record<string, unknown>>(text);
  if (!j || Array.isArray(j)) return [];
  if (tool === 'start_background_task' && typeof j.ticketId === 'string') return [{ type: 'ticket', id: j.ticketId, title: '后台任务', subtitle: '已开始' }];
  if (typeof j.id !== 'string' || !j.id) return [];
  const title = typeof j.title === 'string' ? j.title : undefined;
  if (tool === 'save_resource') return [{ type: 'resource', id: j.id, title: title ?? '资源', subtitle: '已存入资源库' }];
  if (tool === 'create_goal') return [{ type: 'goal', id: j.id, title: title ?? '目标', subtitle: '新目标' }];
  if (tool === 'add_task') return [{ type: 'task', id: j.id, title: title ?? '任务', subtitle: [typeof j.goalTitle === 'string' && j.goalTitle ? `所属：${j.goalTitle}` : '', typeof j.dueAt === 'string' && Number.isFinite(Date.parse(j.dueAt)) ? `截止 ${fmt(j.dueAt)}` : ''].filter(Boolean).join(' · ') || '新任务' }];
  return [];
}

function readItemCards(repo: Repo, result: Awaited<ReturnType<McpHub['call']>>): CardRef[] {
  const { server, tool, text } = result;
  const assignments = (server === 'fudaner-local' && tool === 'list_deadlines') ||
    (server === 'fudan-elearning' && ['list_assignments', 'get_assignment'].includes(tool));
  const mail = server === 'fudan-mail' && ['list_action_required', 'search_mail', 'get_mail'].includes(tool);
  if (!assignments && !mail) return [];
  const kind = assignments ? 'assignment' : 'email';
  const value = parseJsonLoose<unknown>(text);
  const records: unknown[] = Array.isArray(value) ? value : [value];
  return records.slice(0, 5).flatMap((record) => {
    if (!record || typeof record !== 'object' || !('id' in record) || typeof record.id !== 'string') return [];
    const item = repo.getItem(record.id);
    if (item?.kind !== kind) return [];
    return [{ type: 'item', id: item.id, title: item.title, subtitle: item.dueAt ? `截止 ${fmt(item.dueAt)}` : item.sender }];
  });
}

/**
 * 主对话智能体（PRD §5.1）。作为 MCP 客户端调用各平台工具。
 */
/** eLearning 没登录、对话又在说登录或同步时，在回复下面放一个「登录复旦账号」按钮 */
export function loginActions(platforms: PlatformState[], dialog: string): { label: string; action: string }[] {
  const elearning = platforms.find((s) => s.platform === 'elearning');
  if (elearning?.status !== 'need_login') return [];
  return /登录|登陆|授权|认证|同步|elearning|连不上|没连上/i.test(dialog) ? [{ label: '登录复旦账号', action: 'login' }] : [];
}

/**
 * 一轮里调用了很多工具时，总长度会超过模型能读的上限：只保留最近几个工具结果的全文，
 * 更早的结果截短（模型已经读过并据此行动了）。
 */
const TOOL_BUDGET = 60_000;
export function shrinkOldToolResults(messages: LlmMessage[]): void {
  const tools = messages.filter((m) => m.role === 'tool');
  let total = tools.reduce((n, m) => n + (m.content?.length ?? 0), 0);
  for (const m of tools.slice(0, -3)) {
    if (total <= TOOL_BUDGET) break;
    const len = m.content?.length ?? 0;
    if (len > 1500) {
      m.content = `${m.content!.slice(0, 1200)}\n…（较早的工具结果已截短）`;
      total -= len - m.content.length;
    }
  }
}

/**
 * 发给模型的对话历史：跳过空消息和失败提示，每条截短，总长度有上限（越新的越优先）。
 * 历史里一条很长的回复不会让之后的每次请求都超长。
 */
export function historyForModel(history: { role: string; content: string }[], opts: { perMessage?: number; total?: number; maxMessages?: number } = {}): { role: 'user' | 'assistant'; content: string }[] {
  const per = opts.perMessage ?? 2000;
  let budget = opts.total ?? 16_000;
  const out: { role: 'user' | 'assistant'; content: string }[] = [];
  for (const m of [...history].reverse().slice(0, opts.maxMessages ?? 20)) {
    if (m.role !== 'user' && m.role !== 'assistant') continue;
    const text = m.content.replace(/\n*> (回复未完成|已停止生成)[^\n]*$/, '').trim();
    if (!text) continue;
    const clipped = text.length > per ? `${text.slice(0, per)}…（较长，已截短）` : text;
    if (clipped.length > budget) break;
    budget -= clipped.length;
    out.unshift({ role: m.role, content: clipped });
  }
  return out;
}

export class ChatAgent {
  private readonly summarizer: ConversationSummarizer;
  private active: { view: ChatRun; controller: AbortController; cards: CardRef[]; itemCards: Map<string, CardRef> } | null = null;
  state(): ChatRun | null { return this.active ? structuredClone(this.active.view) : null; }
  cancel(id: string): void { if (this.active?.view.id === id) this.active.controller.abort(); }
  private publish(): void { const view = this.state(); if (view) this.channels.delta?.(view); }
  constructor(
    private readonly repo: Repo,
    private readonly router: ModelRouter,
    private readonly hub: McpHub,
    private readonly channels: Channels,
    private readonly platformStatus: () => Promise<PlatformState[]> = async () => [],
  ) { this.summarizer = new ConversationSummarizer(repo, router); }

  async handleUserMessage(text: string, refs: CardRef[] = []): Promise<ChatMessage> {
    if (this.active) throw new Error('上一条回复还在生成，请先停止或等待完成。');
    if (!text.trim()) throw new Error('请输入消息。');
    const run = { view: { id: randomUUID(), content: '', toolCalls: [] as ToolCallView[], startedAt: new Date().toISOString(), version: 0 }, controller: new AbortController(), cards: [] as CardRef[], itemCards: new Map<string, CardRef>() };
    this.active = run;
    try {
      const userMsg = this.repo.addMessage({ role: 'user', content: text, refs });
      this.channels.messagePosted(userMsg);
      this.channels.thinking(true);
      const llm = this.router.for('chat');
      if (llm) this.publish();
      const reply = llm ? await this.withModel(llm, text, refs) : this.withoutModel(text);
      this.channels.messagePosted(reply);
      if (llm) void this.extractMemories(userMsg);
      return reply;
    } catch (error) {
      // 超出上下文长度：只带最近几条消息自动重试一次
      if (!run.controller.signal.aborted && describeModelError(error).contextTooLong && !this.shortHistory) {
        console.warn('[Fudaner 对话] 超出上下文长度，缩短历史后重试');
        this.shortHistory = true;
        try {
          const llm = this.router.for('chat');
          if (llm && !run.view.content) {
            const reply = await this.withModel(llm, text, refs);
            this.channels.messagePosted(reply);
            return reply;
          }
        } catch (retryError) {
          error = retryError;
        } finally {
          this.shortHistory = false;
        }
      }
      if (!run.controller.signal.aborted) console.error('[Fudaner 对话] 模型调用失败：', error);
      const note = run.controller.signal.aborted ? '已停止生成。' : `回复未完成：${describeModelError(error).text}。`;
      const toolCalls = run.view.toolCalls.map((t) => t.ok === undefined ? { ...t, ok: false, summary: '调用已中断，未收到完成结果。' } : t);
      const msg = this.repo.addMessage({ id: run.view.id, role: 'assistant', content: `${run.view.content}${run.view.content ? '\n\n' : ''}> ${note}`, toolCalls, cards: [...run.cards, ...run.itemCards.values()] });
      this.channels.messagePosted(msg);
      return msg;
    } finally {
      this.active = null;
      this.channels.thinking(false);
      void this.summarizer.runInBackground();
    }
  }

  /** 这次回复里下载了课件：放「在文件夹中显示」按钮 */
  private downloadActions(since: string): { label: string; action: string; payload: { path: string } }[] {
    const recent = this.repo.getKv<{ path: string; at: string }[]>('recent_downloads', []).filter((d) => d.at >= since);
    if (!recent.length) return [];
    return [{ label: recent.length > 1 ? `在文件夹中显示（${recent.length} 个文件）` : '在文件夹中显示', action: 'reveal_file', payload: { path: recent[0].path } }];
  }

  /** 超长重试时只带最近几条历史 */
  private shortHistory = false;

  /** 正在生成回复 */
  busy(): boolean { return this.active !== null; }

  /**
   * 定时任务：到点后让助理按用户事先写好的要求做一件事，结果作为主动消息发到对话里。
   * 不在对话里伪造一条用户消息；失败时也留下一条说明。
   */
  async runScheduled(title: string, prompt: string): Promise<ChatMessage> {
    if (this.active) throw new Error('上一条回复还在生成。');
    const llm = this.router.for('chat');
    if (!llm) throw new Error('还没有接上大模型。');
    const run = { view: { id: randomUUID(), content: '', toolCalls: [] as ToolCallView[], startedAt: new Date().toISOString(), version: 0 }, controller: new AbortController(), cards: [] as CardRef[], itemCards: new Map<string, CardRef>() };
    this.active = run;
    try {
      this.channels.thinking(true);
      this.publish();
      const text = `【定时任务「${title}」】这是我事先设定的任务，现在到时间了。请直接完成并把结果告诉我，不要反问；需要的数据先用工具查。\n任务：${prompt}`;
      const reply = await this.withModel(llm, text, [], { title });
      this.channels.messagePosted(reply);
      return reply;
    } catch {
      const msg = this.repo.addMessage({ id: run.view.id, role: 'assistant', content: `⏰ ${title}\n\n这次定时任务没有完成（网络或模型没有正常返回），稍后可以直接让我再做一次。`, proactive: true });
      this.channels.messagePosted(msg);
      return msg;
    } finally {
      this.active = null;
      this.channels.thinking(false);
    }
  }

  private async withModel(llm: LlmClient, text: string, refs: CardRef[], scheduled?: { title: string }): Promise<ChatMessage> {
    const receiptMode = needsGoalReceipt(llm.label, text);
    const focusedGoal = focusGoalOperation(llm.label, text, refs.length > 0);
    const goalTurn = receiptMode ? createGoalTurn(this.repo, text, focusedGoal) : undefined;
    const profile = this.repo.getProfile();
    const today = buildToday(this.repo);
    const nowIso = new Date().toISOString();
    const policy = createToolPolicy(this.repo, llm);
    const platforms = await this.platformStatus().catch(() => []);
    const readOnlyRequest = llm.label.startsWith('local:') && lookupOnly(text) && typeof this.hub.isReadOnly === 'function';
    const scheduleLookup = readOnlyRequest && /ddl|截止|作业|课程|课表|几点|什么课/i.test(text)
      && !/邮件|邮箱|资源|资料|目标|记忆|公告|学分|教师|老师|助教|考试范围|课程详情|规划|计划|帮我安排|请安排/u.test(text);
    const scheduleTools = new Set(['fudaner_local__get_today', 'fudaner_local__list_deadlines']);
    const range = scheduleLookup ? queryRange(text, nowIso) : undefined;
    const system = focusedGoal ? goalOperationPrompt(nowIso) : [policy.mailInstructions(), personaPrompt({ profile, memories: this.repo.recallMemories(text), today, nowIso, platforms }), this.summarizer.context(),
      readOnlyRequest ? '本轮用户只要求查询，工具仅可读取。先调用相关查询工具；查今天的课程时间与近期DDL可一次调用 get_today。结果足够后立即回答原问题，不创建目标或任务，不写记忆。' : '',
      scheduleLookup ? '日期展示使用工具返回的 dueAtShanghai（上海本地时间），不要再使用原始 dueAt 的UTC小时。课程 state=已结束 必须写出“已结束”。' : '',
      range ? `本轮明确的查询范围：${shanghaiTime(range.from)} 至 ${shanghaiTime(range.to)}（上海时间；校历周日起算）。list_deadlines 的起止时间由程序按此范围校正。` : '',
    ].filter(Boolean).join('\n\n');
    const standaloneQuery = scheduleLookup && !refs.length && !/刚才|上面|上述|那个|那门|这门|这些|那些/u.test(text)
      && (!!range || !/ddl|截止|作业/i.test(text));
    const history = standaloneQuery || focusedGoal ? [] : this.repo.recentMessages(20).filter((m) => m.role !== 'tool');
    const messages: LlmMessage[] = [
      { role: 'system', content: system },
      // 普通对话：最后一条是刚保存的用户消息，单独放在末尾；定时任务没有保存用户消息
      ...historyForModel(scheduled ? history : history.slice(0, -1), { maxMessages: this.shortHistory ? 6 : 20, total: this.shortHistory ? 6000 : 16_000 }),
      { role: 'user', content: refs.length ? `${text}\n\n${this.refContext(refs, llm.label.startsWith('local:'))}` : text },
    ];
    const run = this.active!;
    const result = await runAgentLoop({
      llm, hub: this.hub, tools: this.hub.llmTools((server, tool) => {
        const name = `${server.replace(/-/g, '_')}__${tool}`;
        return policy.filter(server, tool) && (!readOnlyRequest || this.hub.isReadOnly(name)) && (!scheduleLookup || scheduleTools.has(name)) && (!focusedGoal || goalOperationTool(name));
      }), messages,
      authorizeTool: (name, args) => {
        const denied = policy.authorize(name, args);
        if (denied) return denied;
        if (focusedGoal && !goalOperationTool(name)) return '本轮只处理创建目标、添加任务和核对目标ID，未执行其他操作。';
        const duplicateGoal = goalTurn?.duplicate(name, args);
        if (duplicateGoal) return duplicateGoal;
        if (readOnlyRequest && this.hub.isReadOnly?.(name) !== true) return '本轮仅允许查询，未执行写操作。请根据已查到的数据回答。';
        if (scheduleLookup && !scheduleTools.has(name)) return '本轮课程和DDL查询请使用 get_today、list_deadlines 或 list_assignments。';
        const [server, tool] = name.split('__');
        if (server === 'fudaner_local' && tool === 'remember') return memoryWriteProblem(text, typeof args.content === 'string' ? args.content : '', this.repo.listMemories());
      },
      recoverRepeatedReads: true,
      normalizeToolArgs: scheduleLookup ? (name, args) => queryArguments(text, name, args, nowIso) : goalTurn ? (name, args) => goalTurn.normalize(name, args) : undefined,
      toolContext: scheduleLookup ? result => queryResultContext(result, nowIso) : focusedGoal ? goalToolContext : undefined,
      initialReads: standaloneQuery ? [
        ...(/课程|课表|几点|什么课/u.test(text) ? [{ name: 'fudaner_local__get_today', args: {} }] : []),
        ...(/ddl|截止|作业/i.test(text) ? [{ name: 'fudaner_local__list_deadlines', args: range ?? { from: nowIso, to: new Date(Date.parse(nowIso) + 7 * 86_400_000).toISOString() } }] : []),
      ] : undefined,
      signal: run.controller.signal,
      onCards: (cards) => { run.cards = this.repo.prepareUndoCards(cards, run.cards); },
      onToolResult: (result) => {
        goalTurn?.record(result);
        for (const card of readItemCards(this.repo, result)) if (run.itemCards.size < 5) run.itemCards.set(card.id, card);
      },
      onDelta: (text) => { if (!receiptMode) { run.view.content += text; run.view.version++; this.publish(); } },
      onTool: (call) => {
        const index = run.view.toolCalls.findIndex((t) => t.id === call.id);
        if (index < 0) run.view.toolCalls.push(structuredClone(call)); else run.view.toolCalls[index] = structuredClone(call);
        run.view.version++; this.publish(); this.channels.toolProgress(run.view.id, call);
      },
    });
    const content = receiptMode ? goalReceipt(this.repo, result.cards, text, result.finishReason === 'answer') : result.content || '模型没有返回正文，请重试。';
    if (receiptMode) { run.view.content = content; run.view.version++; this.publish(); }
    return this.repo.addMessage({
      id: run.view.id, role: 'assistant', content: scheduled ? `⏰ ${scheduled.title}\n\n${content}` : content, proactive: !!scheduled,
      toolCalls: result.toolCalls, cards: [...run.cards, ...run.itemCards.values()],
      actions: [...loginActions(platforms, `${text}\n${content}`), ...this.downloadActions(run.view.startedAt)],
    });
  }

  /** 被引用对象的完整内容（PRD §5.0「引用到对话」） */
  private refContext(refs: CardRef[], local: boolean): string {
    const allowMailBody = local || this.repo.getSettings().allowSensitiveToCloud === true;
    return refs.map((r) => {
      if (r.type === 'item') {
        const it = this.repo.getItem(r.id);
        if (!it) return externalData('item', '引用的事项已不存在。');
        const body = it.kind !== 'email' || allowMailBody ? it.body : [
          it.aiSummary && `摘要：${it.aiSummary}`,
          it.aiAction && `建议操作：${it.aiAction}`,
          !it.aiSummary && (allowMailBody ? it.body : '当前只有邮件主题可用，正文保留在本机。'),
        ].filter(Boolean).join('\n');
        return externalData(`item/${it.kind}`, `${it.title}\n${it.dueAt ? `截止 ${it.dueAt}\n` : ''}${it.sender ? `发件人 ${it.sender}\n` : ''}${body.slice(0, 3000)}`);
      }
      if (r.type === 'feed') {
        const c = this.repo.getFeedCard(r.id);
        return c ? externalData('feed', `${c.title}\n${c.body}\n推荐理由：${c.reason}`) : '';
      }
      if (r.type === 'resource') {
        const res = this.repo.getResource(r.id);
        if (!res) return externalData('resource', '引用的资源已不存在。');
        const limit = 6000;
        const continuation = res.text.length > limit
          ? `\n[已显示前 ${limit} 个字符，共 ${res.text.length} 个字符。可用 read_resource 按 ID 从 offset=${limit} 继续读取。]`
          : '';
        return externalData('resource', `${res.title}\n资源 ID：${res.id}\n${res.text.slice(0, limit)}${continuation}`);
      }
      if (r.type === 'goal') {
        const g = this.repo.getGoal(r.id);
        return g ? externalData('goal', `${g.title}（${g.level} · ${g.status}）\n${g.description ?? ''}\n任务：${this.repo.listTasks({ goalId: g.id }).map((t) => `${t.title}[${t.status}]`).join('、')}`) : '';
      }
      if (r.type === 'task') {
        const task = this.repo.getTask(r.id);
        const goal = task?.goalId ? this.repo.getGoal(task.goalId) : undefined;
        return task ? externalData('task', [task.title, `状态：${task.status}`, task.dueAt && `截止：${task.dueAt}`, goal && `所属目标：${goal.title}`].filter(Boolean).join('\n')) : '';
      }
      if (r.type === 'ticket') {
        const ticket = this.repo.getTicket(r.id);
        const resource = ticket?.resultResourceId ? this.repo.getResource(ticket.resultResourceId) : undefined;
        return ticket ? externalData('ticket', [ticket.title, `状态：${ticket.status}`, ticket.request, resource?.text.slice(0, 6000)].filter(Boolean).join('\n')) : '';
      }
      return '';
    }).join('\n\n');
  }

  /** 没有配置模型时的规则回复，保证演示模式下也能基本使用 */
  private withoutModel(text: string): ChatMessage {
    const now = new Date();
    if (/ddl|截止|作业|deadline/i.test(text)) {
      const items = this.repo.listItems({ kind: 'assignment', done: false, dueAfter: now.toISOString(), dueBefore: new Date(now.getTime() + 7 * 86_400_000).toISOString() });
      const content = items.length ? `接下来 7 天还没交的作业有 ${items.length} 个：\n${items.map((i) => `· ${i.title}，${fmt(i.dueAt!)} 截止`).join('\n')}` : '接下来 7 天没有没交的作业 🎉';
      return this.repo.addMessage({
        role: 'assistant', content,
        cards: items.slice(0, 4).map((i) => ({ type: 'item', id: i.id, title: i.title, subtitle: `截止 ${fmt(i.dueAt!)}` })),
        toolCalls: [{ server: 'fudaner-local', name: 'list_deadlines', args: {}, ok: true, summary: `${items.length} 项` }],
      });
    }
    if (/邮件|回复|mail/i.test(text)) {
      const mails = this.repo.listItems({ kind: 'email', category: 'reply', done: false, limit: 5 });
      return this.repo.addMessage({
        role: 'assistant', content: mails.length ? `有 ${mails.length} 封邮件等你回复：\n${mails.map((m) => `· ${m.sender?.replace(/<.*>/, '')}：${m.title}`).join('\n')}` : '目前没有需要回复的邮件。',
        cards: mails.map((m) => ({ type: 'item', id: m.id, title: m.title, subtitle: m.sender })),
        toolCalls: [{ server: 'fudan-mail', name: 'list_action_required', args: {}, ok: true }],
      });
    }
    // 没接模型时也能用一句话关注官网通知（例如点了「也关注国际合作与交流处」）
    const follow = text.match(/^(?:也|帮我)?关注(?:一下)?(.+?)(?:的通知)?[。！!]?$/);
    if (follow) {
      const r = changeNoticeFollows(this.repo, [follow[1].replace(/（.*?）|\(.*?\)/g, '').trim()]);
      return this.repo.addMessage({
        role: 'assistant',
        content: r.added.length ? `好，已关注${r.added.join('、')}的通知。现在关注：${r.following.join('、')}。` : r.unknown.length ? `没找到「${r.unknown[0]}」，可以到「设置 → 通知与活动」看看可选的来源。` : `已经在关注了。现在关注：${r.following.join('、')}。`,
      });
    }
    if (/登录|登陆|授权|认证/.test(text)) {
      return this.repo.addMessage({
        role: 'assistant',
        content: '登录复旦账号：点下面的「登录复旦账号」（或到「设置 → 复旦账号」），会弹出学校官方的统一身份认证页面。在那个窗口里自己输入学号和密码，页面要求时用企业微信扫码或确认。登录成功后窗口会自动关闭，再点「立即同步」。密码只在学校的页面里输入，应用不保存。',
        actions: [{ label: '登录复旦账号', action: 'login' }],
      });
    }
    return this.repo.addMessage({ role: 'assistant', content: '我还没有接上大模型，现在只能回答「这周有什么 DDL」「有哪些邮件要回」这类问题。去「设置 → 模型」填一下 API Key，我就能陪你聊任何事了。' });
  }

  /** 每轮对话后由本地模型判断有没有值得长期记住的信息（PRD §5.6） */
  private async extractMemories(userMsg: ChatMessage): Promise<void> {
    const llm = this.router.for('memory_extract');
    if (!llm) return;
    try {
      const epochKey = 'ai_memory_epoch';
      let epoch = this.repo.getKv<string | null>(epochKey, null);
      if (!epoch) { epoch = randomUUID(); this.repo.setKv(epochKey, epoch); }
      const existing = this.repo.listMemories().map((m) => `- ${m.content}`).join('\n');
      const r = await llm.chat([{ role: 'user', content: memoryExtractPrompt({ dialog: `用户：${userMsg.content}`, existing }) }], { json: true, temperature: 0 });
      const parsed = memoryOutput.safeParse(parseJsonLoose<unknown>(r.content));
      if (!parsed.success || r.toolCalls.length) return;
      const current = this.repo.getMessage(userMsg.id);
      if (this.repo.getKv<string | null>(epochKey, null) !== epoch || !current || current.createdAt !== userMsg.createdAt || current.content !== userMsg.content) return;
      const j = parsed.data;
      const added = (j?.memories ?? []).filter((m) => m.op === 'add' && m.content).flatMap((m) => memoryWriteProblem(userMsg.content, m.content, this.repo.listMemories()) ? [] : [this.repo.addMemory({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        type: m.type as any, content: m.content, source: 'chat', sourceMsgId: userMsg.id,
        expiresAt: m.expires_days ? new Date(Date.now() + m.expires_days * 86_400_000).toISOString() : undefined,
      })]);
      const created = added.filter((memory) => memory.sourceMsgId === userMsg.id);
      if (created.length) {
        const note = this.repo.addMessage({
          role: 'assistant', content: `📌 已记住：${created.map((m) => m.content).join('；')}`,
          actions: created.map((m) => ({ label: `撤销「${m.content.slice(0, 8)}…」`, action: 'forget_memory', payload: { id: m.id } })),
        });
        this.channels.messagePosted(note);
      }
    } catch {
      // 记忆提取失败不影响对话
    }
  }
}
