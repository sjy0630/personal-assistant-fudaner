import { randomUUID } from 'node:crypto';
import type { CardRef, ChatMessage, ChatRun, ToolCallView } from '../../shared/types';
import type { Repo } from '../db/repo';
import type { Channels } from '../engine/channels';
import { fmt } from '../engine/engine';
import type { McpHub } from '../mcp/hub';
import { buildToday } from '../today';
import type { LlmClient, LlmMessage, LlmTool, ModelRouter } from './llm';
import { parseJsonLoose } from './llm';
import { externalData, memoryExtractPrompt, personaPrompt } from './prompts';
import { ConversationSummarizer } from './summary';
import { memoryOutput } from './validation';
import { createToolPolicy } from './tool-policy';

const MAX_STEPS = 8;

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
  signal?: AbortSignal;
}): Promise<LoopResult> {
  const { llm, hub, tools, messages } = opts;
  const calls: ToolCallView[] = [];
  const cards: CardRef[] = [];
  let streamedContent = '';
  for (let step = 0; step < MAX_STEPS; step++) {
    opts.signal?.throwIfAborted();
    let round = '';
    const emit = (text: string) => {
      if (!text) return;
      if (!round && streamedContent) { streamedContent += '\n\n'; opts.onDelta?.('\n\n'); }
      round += text; streamedContent += text; opts.onDelta?.(text);
    };
    const r = await llm.chat(messages, { tools, temperature: 0.5, signal: opts.signal, onDelta: opts.onDelta ? emit : undefined });
    opts.signal?.throwIfAborted();
    if (opts.onDelta && !round && r.content) emit(r.content);
    if (r.toolCalls.length === 0) return { content: opts.onDelta ? streamedContent : r.content, toolCalls: calls, cards, finishReason: 'answer' };
    messages.push({
      role: 'assistant', content: r.content || null,
      tool_calls: r.toolCalls.map((t) => ({ id: t.id, type: 'function' as const, function: { name: t.name, arguments: t.arguments } })),
    });
    for (const tc of r.toolCalls) {
      opts.signal?.throwIfAborted();
      // Function calling 的参数必须是完整 JSON 对象，不能从残缺文本中“修复”出写操作。
      let parsed: unknown;
      try { parsed = JSON.parse(tc.arguments); } catch { throw new Error('工具参数不完整，未执行'); }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('工具参数不完整，未执行');
      const args = parsed as Record<string, unknown>;
      const [server, tool] = tc.name.split('__');
      const view: ToolCallView = { id: tc.id, name: tool ?? tc.name, server: (server ?? '').replace(/_/g, '-'), args };
      opts.onTool?.(view);
      const denied = opts.authorizeTool?.(tc.name, args);
      const res: Awaited<ReturnType<McpHub['call']>> = denied
        ? { server: view.server, tool: view.name, ok: false, text: denied }
        : await hub.call(tc.name, args);
      view.ok = res.ok;
      view.summary = res.text.slice(0, 120);
      calls.push(view);
      if (res.ok && res.server === 'fudaner-local') {
        const created = cardsFromTool(res.tool, res.text);
        cards.push(...created);
        if (created.length) opts.onCards?.(created);
      }
      if (res.ok) opts.onToolResult?.(res);
      opts.onTool?.(view);
      opts.signal?.throwIfAborted();
      messages.push({ role: 'tool', tool_call_id: tc.id, content: externalData(`${res.server}/${res.tool}`, res.text.slice(0, 12000)) });
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
  if (tool === 'add_task') return [{ type: 'task', id: j.id, title: title ?? '任务', subtitle: typeof j.dueAt === 'string' && Number.isFinite(Date.parse(j.dueAt)) ? `截止 ${fmt(j.dueAt)}` : '新任务' }];
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
      if (llm) void this.extractMemories(userMsg, reply);
      return reply;
    } catch {
      const note = run.controller.signal.aborted ? '已停止生成。' : '回复未完成：连接中断或模型未能正常返回，请检查网络和模型配置后重试。';
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

  private async withModel(llm: LlmClient, text: string, refs: CardRef[]): Promise<ChatMessage> {
    const profile = this.repo.getProfile();
    const today = buildToday(this.repo);
    const system = [personaPrompt({ profile, memories: this.repo.recallMemories(text), today, nowIso: new Date().toISOString() }), this.summarizer.context()].filter(Boolean).join('\n\n');
    const history = this.repo.recentMessages(20).filter((m) => m.role !== 'tool');
    const messages: LlmMessage[] = [
      { role: 'system', content: system },
      ...history.slice(0, -1).map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content })),
      { role: 'user', content: refs.length ? `${text}\n\n${this.refContext(refs, llm.label.startsWith('local:'))}` : text },
    ];
    const run = this.active!;
    const policy = createToolPolicy(this.repo, llm);
    const result = await runAgentLoop({
      llm, hub: this.hub, tools: this.hub.llmTools(policy.filter), messages,
      authorizeTool: policy.authorize,
      signal: run.controller.signal,
      onCards: (cards) => { run.cards = this.repo.prepareUndoCards(cards, run.cards); },
      onToolResult: (result) => {
        for (const card of readItemCards(this.repo, result)) if (run.itemCards.size < 5) run.itemCards.set(card.id, card);
      },
      onDelta: (text) => { run.view.content += text; run.view.version++; this.publish(); },
      onTool: (call) => {
        const index = run.view.toolCalls.findIndex((t) => t.id === call.id);
        if (index < 0) run.view.toolCalls.push(structuredClone(call)); else run.view.toolCalls[index] = structuredClone(call);
        run.view.version++; this.publish(); this.channels.toolProgress(run.view.id, call);
      },
    });
    return this.repo.addMessage({ id: run.view.id, role: 'assistant', content: result.content || '模型没有返回正文，请重试。', toolCalls: result.toolCalls, cards: [...run.cards, ...run.itemCards.values()] });
  }

  /** 被引用对象的完整内容（PRD §5.0「引用到对话」） */
  private refContext(refs: CardRef[], local: boolean): string {
    const allowMailBody = local || this.repo.getSettings().allowSensitiveToCloud === true;
    return refs.map((r) => {
      if (r.type === 'item') {
        const it = this.repo.getItem(r.id);
        if (!it) return externalData('item', '引用的事项已不存在。');
        const body = it.kind !== 'email' || local ? it.body : [
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
    return this.repo.addMessage({ role: 'assistant', content: '我还没有接上大模型，现在只能回答「这周有什么 DDL」「有哪些邮件要回」这类问题。去「设置 → 模型」填一下 API Key，我就能陪你聊任何事了。' });
  }

  /** 每轮对话后由本地模型判断有没有值得长期记住的信息（PRD §5.6） */
  private async extractMemories(userMsg: ChatMessage, reply: ChatMessage): Promise<void> {
    const llm = this.router.for('memory_extract');
    if (!llm) return;
    try {
      const epochKey = 'ai_memory_epoch';
      let epoch = this.repo.getKv<string | null>(epochKey, null);
      if (!epoch) { epoch = randomUUID(); this.repo.setKv(epochKey, epoch); }
      const existing = this.repo.listMemories().map((m) => `- ${m.content}`).join('\n');
      const r = await llm.chat([{ role: 'user', content: memoryExtractPrompt({ dialog: `用户：${userMsg.content}\n助理：${reply.content}`, existing }) }], { json: true, temperature: 0 });
      const parsed = memoryOutput.safeParse(parseJsonLoose<unknown>(r.content));
      if (!parsed.success || r.toolCalls.length) return;
      const current = this.repo.getMessage(userMsg.id);
      if (this.repo.getKv<string | null>(epochKey, null) !== epoch || !current || current.createdAt !== userMsg.createdAt || current.content !== userMsg.content) return;
      const j = parsed.data;
      const added = (j?.memories ?? []).filter((m) => m.op === 'add' && m.content).map((m) => this.repo.addMemory({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        type: m.type as any, content: m.content, source: 'chat', sourceMsgId: userMsg.id,
        expiresAt: m.expires_days ? new Date(Date.now() + m.expires_days * 86_400_000).toISOString() : undefined,
      }));
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
