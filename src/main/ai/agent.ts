import type { CardRef, ChatMessage, ToolCallView } from '../../shared/types';
import type { Repo } from '../db/repo';
import type { Channels } from '../engine/channels';
import { fmt } from '../engine/engine';
import type { McpHub } from '../mcp/hub';
import { buildToday } from '../today';
import type { LlmClient, LlmMessage, LlmTool, ModelRouter } from './llm';
import { parseJsonLoose } from './llm';
import { externalData, memoryExtractPrompt, personaPrompt } from './prompts';

const MAX_STEPS = 8;

export interface LoopResult { content: string; toolCalls: ToolCallView[]; cards: CardRef[] }

/**
 * 通用的工具调用循环：主对话智能体和后台工单执行器共用。
 * 工具结果一律用 <external_data> 包裹后交给模型，防止提示词注入。
 */
export async function runAgentLoop(opts: {
  llm: LlmClient; hub: McpHub; tools: LlmTool[]; messages: LlmMessage[];
  onTool?: (call: ToolCallView) => void;
}): Promise<LoopResult> {
  const { llm, hub, tools, messages } = opts;
  const calls: ToolCallView[] = [];
  const cards: CardRef[] = [];
  for (let step = 0; step < MAX_STEPS; step++) {
    const r = await llm.chat(messages, { tools, temperature: 0.5 });
    if (r.toolCalls.length === 0) return { content: r.content, toolCalls: calls, cards };
    messages.push({
      role: 'assistant', content: r.content || null,
      tool_calls: r.toolCalls.map((t) => ({ id: t.id, type: 'function' as const, function: { name: t.name, arguments: t.arguments } })),
    });
    for (const tc of r.toolCalls) {
      const args = parseJsonLoose<Record<string, unknown>>(tc.arguments) ?? {};
      const [server, tool] = tc.name.split('__');
      const view: ToolCallView = { name: tool ?? tc.name, server: (server ?? '').replace(/_/g, '-'), args };
      opts.onTool?.(view);
      const res = await hub.call(tc.name, args);
      view.ok = res.ok;
      view.summary = res.text.slice(0, 120);
      calls.push(view);
      opts.onTool?.(view);
      cards.push(...cardsFromTool(res.tool, res.text));
      messages.push({ role: 'tool', tool_call_id: tc.id, content: externalData(`${res.server}/${res.tool}`, res.text.slice(0, 12000)) });
    }
  }
  return { content: '这件事步骤有点多，我先停在这里。要我继续吗？', toolCalls: calls, cards };
}

/** 写操作的结果以卡片形式出现在对话里（PRD §5.1：写操作展示结果、可撤销） */
function cardsFromTool(tool: string, text: string): CardRef[] {
  const j = parseJsonLoose<Record<string, string>>(text);
  if (!j || Array.isArray(j)) return [];
  if (tool === 'save_resource' && j.id) return [{ type: 'resource', id: j.id, title: j.title ?? '资源', subtitle: '已存入资源库' }];
  if (tool === 'create_goal' && j.id) return [{ type: 'goal', id: j.id, title: j.title ?? '目标', subtitle: '新目标' }];
  if (tool === 'add_task' && j.id) return [{ type: 'task', id: j.id, title: j.title ?? '任务', subtitle: j.dueAt ? `截止 ${fmt(j.dueAt)}` : '新任务' }];
  if (tool === 'start_background_task' && j.ticketId) return [{ type: 'ticket', id: j.ticketId, title: '后台任务', subtitle: '已开始' }];
  return [];
}

/**
 * 主对话智能体（PRD §5.1）。作为 MCP 客户端调用各平台工具。
 */
export class ChatAgent {
  constructor(
    private readonly repo: Repo,
    private readonly router: ModelRouter,
    private readonly hub: McpHub,
    private readonly channels: Channels,
  ) {}

  async handleUserMessage(text: string, refs: CardRef[] = []): Promise<ChatMessage> {
    const userMsg = this.repo.addMessage({ role: 'user', content: text, refs });
    this.channels.messagePosted(userMsg);
    this.channels.thinking(true);
    try {
      const llm = this.router.for('chat');
      const reply = llm ? await this.withModel(llm, text, refs) : this.withoutModel(text);
      this.channels.messagePosted(reply);
      if (llm) void this.extractMemories(userMsg, reply);
      return reply;
    } catch (e) {
      const msg = this.repo.addMessage({ role: 'assistant', content: `出错了：${(e as Error).message}。可以检查一下设置里的模型配置。` });
      this.channels.messagePosted(msg);
      return msg;
    } finally {
      this.channels.thinking(false);
    }
  }

  private async withModel(llm: LlmClient, text: string, refs: CardRef[]): Promise<ChatMessage> {
    const profile = this.repo.getProfile();
    const today = buildToday(this.repo);
    const system = personaPrompt({ profile, memories: this.repo.recallMemories(text), today, nowIso: new Date().toISOString() });
    const history = this.repo.recentMessages(20).filter((m) => m.role !== 'tool');
    // TODO(C)：更早的对话用 conversation_summaries 的滚动摘要代替
    const messages: LlmMessage[] = [
      { role: 'system', content: system },
      ...history.slice(0, -1).map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content })),
      { role: 'user', content: refs.length ? `${text}\n\n${this.refContext(refs)}` : text },
    ];
    const pendingId = `pending-${Date.now()}`;
    const result = await runAgentLoop({
      llm, hub: this.hub, tools: this.hub.llmTools(), messages,
      onTool: (call) => this.channels.toolProgress(pendingId, call),
    });
    return this.repo.addMessage({ role: 'assistant', content: result.content, toolCalls: result.toolCalls, cards: result.cards });
  }

  /** 被引用对象的完整内容（PRD §5.0「引用到对话」） */
  private refContext(refs: CardRef[]): string {
    return refs.map((r) => {
      if (r.type === 'item') {
        const it = this.repo.getItem(r.id);
        return it ? externalData(`item/${it.kind}`, `${it.title}\n${it.dueAt ? `截止 ${it.dueAt}\n` : ''}${it.sender ? `发件人 ${it.sender}\n` : ''}${it.body.slice(0, 3000)}`) : '';
      }
      if (r.type === 'feed') {
        const c = this.repo.getFeedCard(r.id);
        return c ? externalData('feed', `${c.title}\n${c.body}\n推荐理由：${c.reason}`) : '';
      }
      if (r.type === 'resource') {
        const res = this.repo.getResource(r.id);
        return res ? externalData('resource', `${res.title}\n${res.text.slice(0, 6000)}`) : '';
      }
      if (r.type === 'goal') {
        const g = this.repo.getGoal(r.id);
        return g ? `引用的目标：${g.title}（${g.level}）\n任务：${this.repo.listTasks({ goalId: g.id }).map((t) => `${t.title}[${t.status}]`).join('、')}` : '';
      }
      return `引用：${r.title}`;
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
      const existing = this.repo.listMemories().map((m) => `- ${m.content}`).join('\n');
      const r = await llm.chat([{ role: 'user', content: memoryExtractPrompt({ dialog: `用户：${userMsg.content}\n助理：${reply.content}`, existing }) }], { json: true, temperature: 0 });
      const j = parseJsonLoose<{ memories: { op: string; type: string; content: string; expires_days?: number | null }[] }>(r.content);
      const added = (j?.memories ?? []).filter((m) => m.op === 'add' && m.content).map((m) => this.repo.addMemory({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        type: m.type as any, content: m.content, source: 'chat', sourceMsgId: userMsg.id,
        expiresAt: m.expires_days ? new Date(Date.now() + m.expires_days * 86_400_000).toISOString() : undefined,
      }));
      if (added.length) {
        const note = this.repo.addMessage({
          role: 'assistant', content: `📌 已记住：${added.map((m) => m.content).join('；')}`,
          actions: added.map((m) => ({ label: `撤销「${m.content.slice(0, 8)}…」`, action: 'forget_memory', payload: { id: m.id } })),
        });
        this.channels.messagePosted(note);
      }
    } catch {
      // 记忆提取失败不影响对话
    }
  }
}
