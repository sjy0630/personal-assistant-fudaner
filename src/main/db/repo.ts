import { createHash } from 'node:crypto';
import type {
  Assessment, CardRef, ChatMessage, Course, Decision, EvalRecord, FeedCard, Followup, GateResult, Goal, Item,
  Memory, Profile, QuickAction, Resource, SearchHit, SemesterPhase, Settings, Task, Ticket, ToolCallView,
  Trigger, VerifyCondition,
} from '../../shared/types';
import { Db, fromJson, newId, nowIso, toJson } from './db';

/* eslint-disable @typescript-eslint/no-explicit-any */
type Row = Record<string, any>;

export interface ConversationSummary {
  untilMsgId: string;
  untilCreatedAt: string;
  summary: string;
}
export interface ConversationSummaryBatch {
  epoch: string;
  previous: ConversationSummary | undefined;
  messages: ChatMessage[];
  fingerprint: string;
}
const SUMMARY_EPOCH_KEY = 'conversation_summary_epoch';

/**
 * 所有数据访问都经过 Repo。其他模块不直接写 SQL，方便多人并行开发时只改这一处。
 */
export class Repo {
  constructor(readonly db: Db) {}

  // ---------------- settings / profile ----------------
  getKv<T>(key: string, fallback: T): T {
    const r = this.db.get<Row>('SELECT value FROM settings WHERE key = ?', key);
    return r ? fromJson<T>(r.value, fallback) : fallback;
  }
  setKv(key: string, value: unknown): void {
    this.db.run('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)', key, toJson(value));
  }
  getSettings(): Settings {
    return this.getKv<Settings>('settings', { demoMode: false, quietHours: { start: '23:30', end: '07:30' } });
  }
  setSettings(patch: Partial<Settings>): void {
    this.setKv('settings', { ...this.getSettings(), ...patch });
  }
  getProfile(): Profile {
    return this.getKv<Profile>('profile', { assistantName: '旦旦', style: 'playful', proactivity: 'medium' });
  }
  setProfile(patch: Partial<Profile>): void {
    this.setKv('profile', { ...this.getProfile(), ...patch });
  }

  // ---------------- courses ----------------
  upsertCourse(c: Omit<Course, 'id'> & { id?: string }): Course {
    const existing = c.elearningId ? this.db.get<Row>('SELECT id FROM courses WHERE elearning_id = ?', c.elearningId) : undefined;
    const id = existing?.id ?? c.id ?? newId();
    this.db.run(
      `INSERT INTO courses (id, code, section, name, term, teachers, elearning_id, icourse_id, match_status, assessments)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET code=excluded.code, section=excluded.section, name=excluded.name, term=excluded.term,
         teachers=excluded.teachers, icourse_id=COALESCE(excluded.icourse_id, courses.icourse_id),
         assessments=CASE WHEN excluded.assessments = '[]' THEN courses.assessments ELSE excluded.assessments END`,
      id, c.code, c.section, c.name, c.term, toJson(c.teachers), c.elearningId, c.icourseId, c.matchStatus, toJson(c.assessments ?? []),
    );
    return this.getCourse(id)!;
  }
  /** 课表、考核安排等平台拿不到、需要单独导入的信息 */
  setCourseExtras(id: string, extras: { schedule?: Course['schedule']; assessments?: Course['assessments'] }): void {
    if (extras.schedule) this.db.run('UPDATE courses SET schedule=? WHERE id=?', toJson(extras.schedule), id);
    if (extras.assessments) this.db.run('UPDATE courses SET assessments=? WHERE id=?', toJson(extras.assessments), id);
  }
  getCourse(id: string): Course | undefined {
    const r = this.db.get<Row>('SELECT * FROM courses WHERE id = ?', id);
    return r ? mapCourse(r) : undefined;
  }
  findCourse(codeOrName: string): Course | undefined {
    const q = codeOrName.trim();
    const r = this.db.get<Row>(
      'SELECT * FROM courses WHERE code = ? OR code LIKE ? OR name = ? OR name LIKE ? LIMIT 1',
      q, `${q}%`, q, `%${q}%`,
    );
    return r ? mapCourse(r) : undefined;
  }
  listCourses(): Course[] {
    return this.db.all<Row>('SELECT * FROM courses ORDER BY name').map(mapCourse);
  }

  // ---------------- items ----------------
  /** 写入或更新事项。返回 { item, created, changed } 供同步层生成事件。 */
  upsertItem(i: Omit<Item, 'id'>): { item: Item; created: boolean; changedFields: string[] } {
    const prev = this.db.get<Row>('SELECT * FROM items WHERE source = ? AND kind = ? AND source_id = ?', i.source, i.kind, i.sourceId);
    if (!prev) {
      const id = newId();
      this.db.run(
        `INSERT INTO items (id, source, kind, source_id, title, body, url, published_at, due_at, course_id, done, sender)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        id, i.source, i.kind, i.sourceId, i.title, i.body, i.url, i.publishedAt, i.dueAt, i.courseId, i.done ? 1 : 0, i.sender,
      );
      this.indexForSearch('item', id, i.title, i.body);
      return { item: this.getItem(id)!, created: true, changedFields: [] };
    }
    const changed: string[] = [];
    if ((prev.due_at ?? undefined) !== i.dueAt) changed.push('dueAt');
    if (!!prev.done !== i.done) changed.push('done');
    if (prev.title !== i.title) changed.push('title');
    this.db.run(
      'UPDATE items SET title=?, body=?, url=?, due_at=?, course_id=?, done=? WHERE id=?',
      i.title, i.body, i.url, i.dueAt, i.courseId, i.done ? 1 : 0, prev.id,
    );
    return { item: this.getItem(prev.id)!, created: false, changedFields: changed };
  }
  /**
   * 用户在本地把事项标记为完成 / 已处理，只改应用里的状态，不改邮箱或 eLearning：
   * - 邮件：done = 已处理（不再出现在「待回复」里）；同步时保留（见 mail-sync）。
   * - 作业：平台状态以 eLearning 为准，本地完成记在对应任务上（同步不会覆盖已完成的任务）。
   */
  markItemDone(id: string, done: boolean): Item | undefined {
    const item = this.getItem(id);
    if (!item) return undefined;
    if (item.kind === 'assignment') {
      const task = this.taskForItem(id);
      if (task) this.setTaskStatus(task.id, done ? 'done' : 'todo');
    } else {
      this.db.run('UPDATE items SET done=? WHERE id=?', done ? 1 : 0, id);
      if (done) this.cancelFollowupsForItem(id);
    }
    return this.getItem(id);
  }
  findSourceItem(source: string, kind: string, sourceId: string): Item | undefined {
    const row = this.db.get<Row>('SELECT * FROM items WHERE source = ? AND kind = ? AND source_id = ?', source, kind, sourceId);
    return row ? mapItem(row) : undefined;
  }
  setItemAi(id: string, ai: { category?: string; summary?: string; action?: string; model?: string }): void {
    this.db.run('UPDATE items SET ai_category=?, ai_summary=?, ai_action=?, ai_model_used=? WHERE id=?', ai.category, ai.summary, ai.action, ai.model, id);
  }
  setItemCourse(id: string, courseId: string): void {
    this.db.run('UPDATE items SET course_id=? WHERE id=?', courseId, id);
  }
  getItem(id: string): Item | undefined {
    const r = this.db.get<Row>('SELECT * FROM items WHERE id = ?', id);
    return r ? mapItem(r) : undefined;
  }
  listItems(filter: { kind?: string; courseId?: string; dueBefore?: string; dueAfter?: string; done?: boolean; category?: string; query?: string; since?: string; limit?: number } = {}): Item[] {
    const where: string[] = [];
    const params: (string | number)[] = [];
    if (filter.kind) { where.push('kind = ?'); params.push(filter.kind); }
    if (filter.courseId) { where.push('course_id = ?'); params.push(filter.courseId); }
    if (filter.dueBefore) { where.push('due_at IS NOT NULL AND due_at <= ?'); params.push(filter.dueBefore); }
    if (filter.dueAfter) { where.push('due_at IS NOT NULL AND due_at >= ?'); params.push(filter.dueAfter); }
    if (filter.done !== undefined) { where.push('done = ?'); params.push(filter.done ? 1 : 0); }
    if (filter.category) { where.push('ai_category = ?'); params.push(filter.category); }
    if (filter.since) { where.push('published_at >= ?'); params.push(filter.since); }
    if (filter.query) {
      where.push('(title LIKE ? OR body LIKE ? OR sender LIKE ?)');
      params.push(`%${filter.query}%`, `%${filter.query}%`, `%${filter.query}%`);
    }
    const sql = `SELECT * FROM items ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY COALESCE(due_at, published_at) ${filter.dueBefore || filter.dueAfter ? 'ASC' : 'DESC'} LIMIT ?`;
    return this.db.all<Row>(sql, ...params, filter.limit ?? 100).map(mapItem);
  }

  addLink(fromItemId: string, toItemId: string, reason: string, confidence: number): void {
    this.db.run(
      'INSERT OR IGNORE INTO links (id, from_item_id, to_item_id, reason, confidence, confirmed) VALUES (?, ?, ?, ?, ?, ?)',
      newId(), fromItemId, toItemId, reason, confidence, confidence >= 0.7 ? 1 : 0,
    );
  }
  linksOf(itemId: string): { item: Item; reason: string }[] {
    return this.db
      .all<Row>('SELECT * FROM links WHERE (from_item_id = ? OR to_item_id = ?) AND confirmed = 1', itemId, itemId)
      .map((l) => ({ item: this.getItem(l.from_item_id === itemId ? l.to_item_id : l.from_item_id)!, reason: l.reason as string }))
      .filter((x) => x.item);
  }

  // ---------------- chat ----------------
  addMessage(m: Partial<ChatMessage> & { role: ChatMessage['role']; content: string }): ChatMessage {
    const msg: ChatMessage = {
      id: m.id ?? newId(), role: m.role, content: m.content, cards: m.cards ?? [], refs: m.refs ?? [], actions: m.actions ?? [],
      toolCalls: m.toolCalls ?? [], proactive: m.proactive ?? false, trigger: m.trigger, createdAt: m.createdAt ?? nowIso(),
    };
    this.db.run(
      `INSERT INTO chat_messages (id, role, content, cards, refs, actions, tool_calls, proactive, trigger, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      msg.id, msg.role, msg.content, toJson(msg.cards), toJson(msg.refs), toJson(msg.actions), toJson(msg.toolCalls),
      msg.proactive ? 1 : 0, msg.trigger, msg.createdAt,
    );
    if (msg.role !== 'tool') this.indexForSearch('message', msg.id, msg.content.slice(0, 40), msg.content);
    return msg;
  }
  updateMessageToolCalls(id: string, calls: ToolCallView[]): void {
    this.db.run('UPDATE chat_messages SET tool_calls=? WHERE id=?', toJson(calls), id);
  }
  getMessage(id: string): ChatMessage | undefined {
    const r = this.db.get<Row>('SELECT * FROM chat_messages WHERE id = ?', id);
    return r ? mapMessage(r) : undefined;
  }
  recentMessages(limit = 50): ChatMessage[] {
    return this.db.all<Row>('SELECT * FROM chat_messages ORDER BY created_at DESC,rowid DESC LIMIT ?', limit).map(mapMessage).reverse();
  }
  countProactiveToday(dayStartIso: string): number {
    return this.db.get<Row>('SELECT COUNT(*) AS n FROM chat_messages WHERE proactive = 1 AND created_at >= ?', dayStartIso)?.n ?? 0;
  }
  messagesAround(id: string, limit = 100): ChatMessage[] {
    const target = this.db.get<{ created_at: string; rowid: number }>('SELECT created_at, rowid FROM chat_messages WHERE id = ?', id);
    if (!target) return [];
    const size = Math.max(1, Math.min(200, Number.isFinite(limit) ? Math.floor(limit) : 100));
    const before = this.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM chat_messages WHERE created_at < ? OR (created_at = ? AND rowid < ?)', target.created_at, target.created_at, target.rowid)?.n ?? 0;
    return this.db.all<Row>('SELECT * FROM chat_messages ORDER BY created_at ASC, rowid ASC LIMIT ? OFFSET ?', size, Math.max(0, before - Math.floor(size / 2))).map(mapMessage);
  }
  messagePage(beforeId?: string, limit = 50): { messages: ChatMessage[]; hasMore: boolean } {
    const size = Math.max(1, Math.min(100, Number.isFinite(limit) ? Math.floor(limit) : 50));
    const before = beforeId ? this.db.get<{ created_at: string; rowid: number }>('SELECT created_at,rowid FROM chat_messages WHERE id=?', beforeId) : undefined;
    if (beforeId && !before) return { messages: [], hasMore: false };
    const rows = before
      ? this.db.all<Row>('SELECT * FROM chat_messages WHERE created_at < ? OR (created_at = ? AND rowid < ?) ORDER BY created_at DESC,rowid DESC LIMIT ?', before.created_at, before.created_at, before.rowid, size + 1)
      : this.db.all<Row>('SELECT * FROM chat_messages ORDER BY created_at DESC,rowid DESC LIMIT ?', size + 1);
    return { messages: rows.slice(0, size).map(mapMessage).reverse(), hasMore: rows.length > size };
  }

  /** 只由聊天执行器为本轮真实创建的结果调用；不继承传入卡片的撤销权限。 */
  prepareUndoCards(cards: CardRef[], previous: CardRef[] = []): CardRef[] {
    return this.db.tx(() => {
      const next = [...previous];
      for (const card of cards) {
        const { undoToken: _token, undone: _undone, ...ref } = card;
        const undoToken = this.undoFingerprint(card.type, card.id);
        const parentId = card.type === 'task' && undoToken ? this.getTask(card.id)?.goalId : undefined;
        if (parentId) {
          const parent = next.findIndex((candidate) => candidate.type === 'goal' && candidate.id === parentId);
          const beforeAppend = this.undoFingerprint('goal', parentId, card.id);
          if (parent >= 0 && beforeAppend && next[parent].undoToken === beforeAppend) {
            next[parent] = { ...next[parent], undoToken: this.undoFingerprint('goal', parentId) };
          }
        }
        next.push(undoToken ? { ...ref, undoToken } : ref);
      }
      return next;
    });
  }

  decideSuggestedTicket(ticketId: string, accept: boolean, feedId?: string): ChatMessage[] {
    return this.db.tx(() => {
      if (this.getTicket(ticketId)?.status !== 'suggested') throw new Error('这个工单已经处理过了。');
      this.setTicketStatus(ticketId, accept ? 'queued' : 'dropped');
      this.db.run("UPDATE feed_cards SET status=? WHERE (dedupe_key=? OR id=?) AND status!='dismissed'", accept ? 'accepted' : 'dismissed', `ticket:${ticketId}`, feedId);
      const rows = this.db.all<Row>(`SELECT m.* FROM chat_messages m WHERE m.role='assistant' AND EXISTS (
        SELECT 1 FROM json_each(m.actions) a WHERE json_extract(a.value, '$.payload.ticketId')=?
        AND json_extract(a.value, '$.action') IN ('accept_ticket', 'decline_ticket')
      )`, ticketId);
      return rows.map((row) => {
        const message = mapMessage(row);
        message.actions = message.actions.map((action) =>
          action.payload?.ticketId === ticketId && (action.action === 'accept_ticket' || action.action === 'decline_ticket')
            ? { ...action, used: true } : action);
        this.updateMessageActions(message.id, message.actions);
        return message;
      });
    });
  }

  updateMessageActions(id: string, actions: QuickAction[]): void {
    this.db.run('UPDATE chat_messages SET actions=? WHERE id=?', toJson(actions), id);
  }

  /** 权限始终来自数据库中的原助理消息，客户端只提供消息和对象标识。 */
  undoMessageResult(messageId: string, type: CardRef['type'], id: string): ChatMessage {
    return this.db.tx(() => {
      const message = this.getMessage(messageId);
      if (!message || message.role !== 'assistant') throw new Error('只能撤销原助理消息创建的结果。');
      const target = message.cards.find(card => card.type === type && card.id === id);
      if (!target?.undoToken || !['goal', 'task', 'resource'].includes(type)) throw new Error('这条消息没有该结果的撤销权限。');
      if (target.undone) return message;
      if (this.undoFingerprint(type, id) !== target.undoToken) throw new Error('结果已被修改、关联其他内容或不再允许撤销，请保留现有数据。');

      const deletedTasks = new Set<string>();
      // 单个任务的正常撤销会改变父目标快照。仅保留操作前仍然匹配的本消息父卡片。
      const task = type === 'task' ? this.getTask(id) : undefined;
      const parentFingerprint = task?.goalId ? this.undoFingerprint('goal', task.goalId) : undefined;
      const refreshParents = new Set(message.cards.filter(card => card.type === 'goal' && card.id === task?.goalId &&
        !card.undone && !!parentFingerprint && card.undoToken === parentFingerprint));

      if (type === 'goal') {
        const tasks = this.db.all<Row>('SELECT id FROM tasks WHERE goal_id=?', id);
        for (const child of tasks) {
          deletedTasks.add(child.id);
          this.removeFromSearch('task', child.id);
        }
        this.db.run('DELETE FROM tasks WHERE goal_id=?', id);
        this.db.run('DELETE FROM goals WHERE id=?', id);
      } else if (type === 'task') {
        deletedTasks.add(id);
        this.db.run('DELETE FROM tasks WHERE id=?', id);
      } else {
        // 资源文件可能被其他本地流程引用，此处仅撤销数据库内容。
        this.db.run('DELETE FROM resource_chunks WHERE resource_id=?', id);
        this.db.run('DELETE FROM resources WHERE id=?', id);
      }
      this.removeFromSearch(type, id);
      const nextParentFingerprint = refreshParents.size && task?.goalId ? this.undoFingerprint('goal', task.goalId) : undefined;
      message.cards = message.cards.map(card => {
        if ((card.type === type && card.id === id) || (card.type === 'task' && deletedTasks.has(card.id))) return { ...card, undone: true };
        return refreshParents.has(card) ? { ...card, undoToken: nextParentFingerprint } : card;
      });
      this.db.run('UPDATE chat_messages SET cards=? WHERE id=?', toJson(message.cards), messageId);
      return message;
    });
  }

  private undoFingerprint(type: CardRef['type'], id: string, excludeTaskId?: string): string | undefined {
    let snapshot: unknown;
    if (type === 'goal') {
      const goal = this.db.get<Row>('SELECT * FROM goals WHERE id=?', id);
      if (!goal || goal.created_by !== 'assistant' || goal.level === 'course' ||
        this.db.get<Row>('SELECT id FROM tickets WHERE goal_id=? LIMIT 1', id)) return undefined;
      const tasks = this.db.all<Row>('SELECT * FROM tasks WHERE goal_id=? ORDER BY id', id).filter((task) => task.id !== excludeTaskId);
      if (tasks.some(task => task.source !== 'assistant' || task.item_id !== null)) return undefined;
      snapshot = { goal, tasks };
    } else if (type === 'task') {
      const task = this.db.get<Row>('SELECT * FROM tasks WHERE id=?', id);
      if (!task || task.source !== 'assistant' || task.item_id !== null) return undefined;
      snapshot = task;
    } else if (type === 'resource') {
      const resource = this.db.get<Row>('SELECT * FROM resources WHERE id=?', id);
      if (!resource || resource.kind !== 'assistant_output' ||
        this.db.get<Row>('SELECT id FROM tickets WHERE result_resource_id=? LIMIT 1', id)) return undefined;
      snapshot = { resource, chunks: this.db.all<Row>('SELECT * FROM resource_chunks WHERE resource_id=? ORDER BY seq,id', id) };
    } else return undefined;
    return createHash('sha256').update(toJson({ type, snapshot })).digest('hex');
  }

  /** 摘要按消息时间及插入顺序排序，同毫秒的消息也有确定的覆盖边界。 */
  latestSummary(): ConversationSummary | undefined {
    const row = this.db.get<Row>(`SELECT s.until_msg_id, s.summary, m.created_at FROM conversation_summaries s
      JOIN chat_messages m ON m.id=s.until_msg_id ORDER BY m.created_at DESC,m.rowid DESC,s.rowid DESC LIMIT 1`);
    return row ? { untilMsgId: row.until_msg_id, untilCreatedAt: row.created_at, summary: row.summary } : undefined;
  }
  addSummary(untilMsgId: string, summary: string): void {
    const content = Array.from(summary.trim()).slice(0, 300).join('');
    if (!content || !this.getMessage(untilMsgId)) throw new Error('摘要内容或覆盖消息无效。');
    this.db.run('INSERT INTO conversation_summaries (id,until_msg_id,summary) VALUES (?,?,?)', newId(), untilMsgId, content);
  }
  /** 保留最近 20 条原文；每批最多处理 80 条旧消息，避免积压历史撑满上下文。 */
  summaryBatch(): ConversationSummaryBatch | undefined {
    const cutoff = this.db.get<{ created_at: string; rowid: number }>('SELECT created_at,rowid FROM chat_messages ORDER BY created_at DESC,rowid DESC LIMIT 1 OFFSET 19');
    if (!cutoff) return undefined;
    const previous = this.latestSummary();
    const rows = this.summaryRows(previous, cutoff, false).slice(0, 80);
    if (rows.length < 20) return undefined;
    // wipe() 会删除此内部键；即使新对话重用相同消息 ID，旧异步任务也不能写回。
    let epoch = this.getKv<string | undefined>(SUMMARY_EPOCH_KEY, undefined);
    if (!epoch) { epoch = newId(); this.setKv(SUMMARY_EPOCH_KEY, epoch); }
    return { epoch, previous, messages: rows.map(mapMessage), fingerprint: this.summaryFingerprint(rows) };
  }
  /** 仅在清空代次、原摘要和待覆盖消息均未变化时原子保存，防止重复或过期摘要覆盖。 */
  commitSummary(batch: ConversationSummaryBatch, summary: string): boolean {
    return this.db.tx(() => {
      if (this.getKv<string | undefined>(SUMMARY_EPOCH_KEY, undefined) !== batch.epoch ||
        toJson(this.latestSummary()) !== toJson(batch.previous)) return false;
      const until = batch.messages.at(-1);
      const boundary = until && this.db.get<{ created_at: string; rowid: number }>('SELECT created_at,rowid FROM chat_messages WHERE id=?', until.id);
      const cutoff = this.db.get<{ created_at: string; rowid: number }>('SELECT created_at,rowid FROM chat_messages ORDER BY created_at DESC,rowid DESC LIMIT 1 OFFSET 19');
      if (!boundary || !cutoff || boundary.created_at > cutoff.created_at ||
        (boundary.created_at === cutoff.created_at && boundary.rowid >= cutoff.rowid)) return false;
      if (this.summaryFingerprint(this.summaryRows(batch.previous, boundary, true)) !== batch.fingerprint) return false;
      this.addSummary(until!.id, summary);
      return true;
    });
  }
  private summaryRows(previous: ConversationSummary | undefined, boundary: { created_at: string; rowid: number }, inclusive: boolean): Row[] {
    const cursor = previous && this.db.get<{ created_at: string; rowid: number }>('SELECT created_at,rowid FROM chat_messages WHERE id=?', previous.untilMsgId);
    const after = cursor ? 'AND (created_at > ? OR (created_at = ? AND rowid > ?))' : '';
    const params = cursor ? [cursor.created_at, cursor.created_at, cursor.rowid] : [];
    return this.db.all<Row>(`SELECT rowid AS summary_rowid,* FROM chat_messages
      WHERE (created_at < ? OR (created_at = ? AND rowid ${inclusive ? '<=' : '<'} ?)) ${after}
      ORDER BY created_at ASC,rowid ASC`, boundary.created_at, boundary.created_at, boundary.rowid, ...params);
  }
  private summaryFingerprint(rows: Row[]): string {
    return createHash('sha256').update(toJson(rows.map(row => ({ rowid: row.summary_rowid, id: row.id,
      role: row.role, content: row.content, createdAt: row.created_at })))).digest('hex');
  }

  // ---------------- memories ----------------
  addMemory(m: { type: Memory['type']; content: string; source: Memory['source']; sourceMsgId?: string; expiresAt?: string }): Memory {
    const dup = this.db.get<Row>('SELECT * FROM memories WHERE content = ?', m.content);
    if (dup) return mapMemory(dup);
    const id = newId();
    const now = nowIso();
    this.db.run(
      'INSERT INTO memories (id, type, content, source, source_msg_id, pinned, expires_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?)',
      id, m.type, m.content, m.source, m.sourceMsgId, m.expiresAt, now, now,
    );
    this.indexForSearch('memory', id, m.content, m.content);
    return mapMemory(this.db.get<Row>('SELECT * FROM memories WHERE id = ?', id)!);
  }
  updateMemory(id: string, content: string): void {
    this.db.run('UPDATE memories SET content=?, updated_at=? WHERE id=?', content, nowIso(), id);
  }
  removeMemory(id: string): void {
    this.db.run('DELETE FROM memories WHERE id=?', id);
    this.removeFromSearch('memory', id);
  }
  listMemories(types?: Memory['type'][]): Memory[] {
    const now = nowIso();
    const rows = this.db.all<Row>('SELECT * FROM memories WHERE expires_at IS NULL OR expires_at > ? ORDER BY pinned DESC, updated_at DESC', now);
    return rows.map(mapMemory).filter((m) => !types || types.includes(m.type));
  }
  /** 初赛：关键词 + 类型匹配；P1 换成向量检索 */
  recallMemories(query: string, limit = 10): Memory[] {
    const all = this.listMemories();
    const words = query.split(/[\s，。,.!?？！]+/).filter((w) => w.length >= 2);
    const scored = all.map((m) => ({
      m,
      s: (m.pinned ? 2 : 0) + (m.type === 'schedule' || m.type === 'preference' ? 1 : 0) + words.filter((w) => m.content.includes(w)).length * 3,
    }));
    return scored.sort((a, b) => b.s - a.s).slice(0, limit).map((x) => x.m);
  }

  // ---------------- goals / tasks ----------------
  addGoal(g: Omit<Goal, 'id' | 'createdAt' | 'status'> & { status?: Goal['status'] }): Goal {
    const id = newId();
    this.db.run(
      'INSERT INTO goals (id, level, title, description, course_id, due_at, status, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      id, g.level, g.title, g.description, g.courseId, g.dueAt, g.status ?? 'active', g.createdBy, nowIso(),
    );
    this.indexForSearch('goal', id, g.title, g.description ?? '');
    return this.getGoal(id)!;
  }
  getGoal(id: string): Goal | undefined {
    const r = this.db.get<Row>('SELECT * FROM goals WHERE id = ?', id);
    return r ? mapGoal(r) : undefined;
  }
  courseGoal(courseId: string): Goal | undefined {
    const r = this.db.get<Row>("SELECT * FROM goals WHERE level = 'course' AND course_id = ?", courseId);
    return r ? mapGoal(r) : undefined;
  }
  listGoals(): Goal[] {
    return this.db.all<Row>("SELECT * FROM goals WHERE status != 'archived' ORDER BY level, created_at").map(mapGoal);
  }
  upsertTaskForItem(t: { goalId?: string; itemId: string; title: string; dueAt?: string; done: boolean; verify?: VerifyCondition }): Task {
    const prev = this.db.get<Row>('SELECT * FROM tasks WHERE item_id = ?', t.itemId);
    if (prev) {
      // 平台上完成，或用户在本地标记过完成 → done；平台上撤销了完成且本地没标记 → 回到 todo；用户跳过的保持跳过
      this.db.run(
        `UPDATE tasks SET title=?, due_at=?,
           status=CASE WHEN ? OR local_done = 1 THEN 'done' WHEN status = 'skipped' THEN 'skipped' ELSE 'todo' END
         WHERE id=?`,
        t.title, t.dueAt, t.done ? 1 : 0, prev.id);
      return this.getTask(prev.id)!;
    }
    const id = newId();
    this.db.run(
      'INSERT INTO tasks (id, goal_id, item_id, title, due_at, status, source, verify) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      id, t.goalId, t.itemId, t.title, t.dueAt, t.done ? 'done' : 'todo', 'elearning', toJson(t.verify),
    );
    return this.getTask(id)!;
  }
  addTask(t: { goalId?: string; title: string; dueAt?: string; source: Task['source'] }): Task {
    const id = newId();
    this.db.run('INSERT INTO tasks (id, goal_id, title, due_at, status, source) VALUES (?, ?, ?, ?, ?, ?)', id, t.goalId, t.title, t.dueAt, 'todo', t.source);
    this.indexForSearch('task', id, t.title, '');
    return this.getTask(id)!;
  }
  getTask(id: string): Task | undefined {
    const r = this.db.get<Row>('SELECT * FROM tasks WHERE id = ?', id);
    return r ? mapTask(r) : undefined;
  }
  taskForItem(itemId: string): Task | undefined {
    const r = this.db.get<Row>('SELECT * FROM tasks WHERE item_id = ?', itemId);
    return r ? mapTask(r) : undefined;
  }
  /**
   * 更新任务状态。
   * - by = 'user'（默认）：用户的操作（目标页打勾、对话里说「写完了」、标记完成）。对平台作业对应的任务，
   *   同时记下「本地标记完成」，之后同步不会被平台状态覆盖；标记完成时取消这件事的待跟进。
   * - by = 'platform'：根据平台状态更新（闭环验证），不改本地标记。
   */
  setTaskStatus(id: string, status: Task['status'], by: 'user' | 'platform' = 'user'): void {
    if (by === 'platform') {
      this.db.run('UPDATE tasks SET status=? WHERE id=?', status, id);
      return;
    }
    this.db.run('UPDATE tasks SET status=?, local_done=CASE WHEN item_id IS NULL THEN local_done ELSE ? END WHERE id=?', status, status === 'done' ? 1 : 0, id);
    const itemId = this.getTask(id)?.itemId;
    if (status === 'done' && itemId) this.cancelFollowupsForItem(itemId);
  }
  /** 事项已完成 / 已处理：这件事的待跟进不再需要问 */
  cancelFollowupsForItem(itemId: string): void {
    this.db.run("UPDATE followups SET status='done' WHERE status='pending' AND item_id=?", itemId);
  }
  listTasks(filter: { goalId?: string; dueBefore?: string; status?: Task['status'] } = {}): Task[] {
    const where: string[] = [];
    const p: string[] = [];
    if (filter.goalId) { where.push('goal_id = ?'); p.push(filter.goalId); }
    if (filter.dueBefore) { where.push('due_at <= ?'); p.push(filter.dueBefore); }
    if (filter.status) { where.push('status = ?'); p.push(filter.status); }
    return this.db.all<Row>(`SELECT * FROM tasks ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY due_at`, ...p).map(mapTask);
  }
  /** 某个提醒是否还没发过（不写入） */
  markReminderSentDryRun(taskId: string, tag: string): boolean {
    const t = this.db.get<Row>('SELECT reminders_sent FROM tasks WHERE id=?', taskId);
    return !fromJson<string[]>(t?.reminders_sent, []).includes(tag);
  }
  remindersSent(taskId: string): string[] {
    return fromJson<string[]>(this.db.get<Row>('SELECT reminders_sent FROM tasks WHERE id=?', taskId)?.reminders_sent, []);
  }
  markReminderSent(taskId: string, tag: string): boolean {
    const t = this.db.get<Row>('SELECT reminders_sent FROM tasks WHERE id=?', taskId);
    const sent = fromJson<string[]>(t?.reminders_sent, []);
    if (sent.includes(tag)) return false;
    sent.push(tag);
    this.db.run('UPDATE tasks SET reminders_sent=? WHERE id=?', toJson(sent), taskId);
    return true;
  }

  addFollowup(f: { topic: string; dueAt: string; itemId?: string; verify?: VerifyCondition; fromMsgId?: string }): Followup {
    const id = newId();
    this.db.run('INSERT INTO followups (id, topic, due_at, item_id, status, verify, created_from_msg_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
      id, f.topic, f.dueAt, f.itemId, 'pending', toJson(f.verify), f.fromMsgId);
    return { id, topic: f.topic, dueAt: f.dueAt, itemId: f.itemId, status: 'pending', verify: f.verify };
  }
  dueFollowups(now: string): Followup[] {
    return this.db.all<Row>("SELECT * FROM followups WHERE status = 'pending' AND due_at <= ?", now).map(mapFollowup);
  }
  listFollowupsForItem(itemId: string): Followup[] {
    return this.db.all<Row>('SELECT * FROM followups WHERE item_id = ?', itemId).map(mapFollowup);
  }
  pendingFollowups(): Followup[] {
    return this.db.all<Row>("SELECT * FROM followups WHERE status = 'pending' ORDER BY due_at").map(mapFollowup);
  }
  setFollowupStatus(id: string, status: Followup['status']): void {
    this.db.run('UPDATE followups SET status=? WHERE id=?', status, id);
  }

  // ---------------- feed ----------------
  addFeedCard(c: Omit<FeedCard, 'id' | 'createdAt' | 'status'> & { dedupeKey?: string }): FeedCard | undefined {
    if (c.dedupeKey && this.db.get<Row>('SELECT id FROM feed_cards WHERE dedupe_key = ?', c.dedupeKey)) return undefined;
    const id = newId();
    this.db.run(
      `INSERT INTO feed_cards (id, type, title, body, reason, done, refs, actions, score, status, dedupe_key, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'new', ?, ?)`,
      id, c.type, c.title, c.body, c.reason, c.done, toJson(c.refs), toJson(c.actions), c.score, c.dedupeKey, nowIso(),
    );
    this.indexForSearch('feed', id, c.title, `${c.body}\n${c.reason}`);
    return this.getFeedCard(id);
  }
  getFeedCard(id: string): FeedCard | undefined {
    const r = this.db.get<Row>('SELECT * FROM feed_cards WHERE id = ?', id);
    return r ? mapFeed(r) : undefined;
  }
  listFeed(type?: string): FeedCard[] {
    return this.db
      .all<Row>(`SELECT * FROM feed_cards WHERE status != 'dismissed' ${type ? 'AND type = ?' : ''} ORDER BY created_at DESC, score DESC LIMIT 200`, ...(type ? [type] : []))
      .map(mapFeed);
  }
  setFeedStatus(id: string, status: FeedCard['status'], reason?: string): void {
    this.db.run('UPDATE feed_cards SET status=?, dismiss_reason=? WHERE id=?', status, reason, id);
  }

  // ---------------- resources ----------------
  addResource(r: { title: string; kind: Resource['kind']; courseId?: string; mime: string; text: string; path?: string }): Resource {
    const id = newId();
    this.db.run('INSERT INTO resources (id, title, kind, course_id, mime, path, text, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      id, r.title, r.kind, r.courseId, r.mime, r.path, r.text, nowIso());
    const chunks = chunkText(r.text);
    chunks.forEach((t, i) => this.db.run('INSERT INTO resource_chunks (id, resource_id, seq, text) VALUES (?, ?, ?, ?)', newId(), id, i, t));
    this.indexForSearch('resource', id, r.title, r.text.slice(0, 20000));
    return this.getResource(id)!;
  }
  getResource(id: string): Resource | undefined {
    const r = this.db.get<Row>('SELECT * FROM resources WHERE id = ?', id);
    return r ? mapResource(r) : undefined;
  }
  removeResource(id: string): void {
    this.db.tx(() => {
      this.db.run('DELETE FROM resource_chunks WHERE resource_id = ?', id);
      this.removeFromSearch('resource', id);
      this.db.run('DELETE FROM resources WHERE id = ?', id);
    });
  }
  listResources(courseId?: string): Resource[] {
    return this.db.all<Row>(`SELECT * FROM resources ${courseId ? 'WHERE course_id = ?' : ''} ORDER BY created_at DESC`, ...(courseId ? [courseId] : [])).map(mapResource);
  }

  // ---------------- search ----------------
  indexForSearch(type: SearchHit['type'], id: string, title: string, body: string): void {
    this.removeFromSearch(type, id);
    this.db.run('INSERT INTO search_index (object_type, object_id, title, body) VALUES (?, ?, ?, ?)', type, id, title, body);
  }
  removeFromSearch(type: string, id: string): void {
    this.db.run('DELETE FROM search_index WHERE object_type = ? AND object_id = ?', type, id);
  }
  search(query: string, types?: SearchHit['type'][], limit = 50): SearchHit[] {
    const q = query.trim();
    if (!q) return [];
    let rows: Row[];
    const terms = q.split(/\s+/);
    if (terms.every((term) => [...term].length >= 3)) {
      // trigram 分词需要至少 3 个字符
      const fts = terms.map((w) => `"${w.replace(/"/g, '""')}"`).join(' ');
      rows = this.db.all<Row>(
        `SELECT object_type, object_id, title, snippet(search_index, 3, '', '', '…', 16) AS snip
         FROM search_index WHERE search_index MATCH ? ORDER BY rank LIMIT ?`, fts, limit,
      );
    } else {
      const matches = terms.map(() => '(instr(lower(title), lower(?)) > 0 OR instr(lower(body), lower(?)) > 0)').join(' AND ');
      rows = this.db.all<Row>(
        `SELECT object_type, object_id, title, substr(body, max(1, instr(lower(body), lower(?)) - 20), 100) AS snip
         FROM search_index WHERE ${matches} LIMIT ?`, terms[0], ...terms.flatMap((term) => [term, term]), limit,
      );
    }
    return rows
      .map((r) => ({ type: r.object_type, id: r.object_id, title: r.title, snippet: r.snip ?? '' }) as SearchHit)
      .filter((h) => !types || types.includes(h.type));
  }

  // ---------------- 主动引擎 ----------------
  /** 写入事件（幂等：同一来源、同一类型、同一原始 ID 只写一次）。返回是否为新事件。 */
  addTrigger(t: Omit<Trigger, 'id' | 'disposition' | 'occurredAt'> & { occurredAt?: string }): boolean {
    const r = this.db.run(
      `INSERT OR IGNORE INTO triggers (id, source, kind, source_ref, thread_key, payload, occurred_at, disposition)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')`,
      newId(), t.source, t.kind, t.sourceRef, t.threadKey, toJson(t.payload), t.occurredAt ?? nowIso(),
    );
    return r.changes > 0;
  }
  pendingTriggers(): Trigger[] {
    return this.db.all<Row>("SELECT * FROM triggers WHERE disposition = 'pending' ORDER BY occurred_at").map(mapTrigger);
  }
  setTriggerDisposition(ids: string[], disposition: Trigger['disposition'], evalId?: string): void {
    for (const id of ids) this.db.run('UPDATE triggers SET disposition=?, eval_id=? WHERE id=?', disposition, evalId, id);
  }
  addEval(e: Omit<EvalRecord, 'id' | 'createdAt'>): EvalRecord {
    const id = newId();
    const createdAt = nowIso();
    this.db.run(
      `INSERT INTO evals (id, thread_key, trigger_ids, gate_result, assessment, decision, attention_cost, reason, model_used, rule_mode, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id, e.threadKey, toJson(e.triggerIds), toJson(e.gate), toJson(e.assessment), e.decision, e.attentionCost, e.reason, e.modelUsed, e.ruleMode, createdAt,
    );
    return { ...e, id, createdAt };
  }
  listEvals(limit = 100): EvalRecord[] {
    return this.db.all<Row>('SELECT * FROM evals ORDER BY created_at DESC LIMIT ?', limit).map(mapEval);
  }
  addDigest(text: string, refs: CardRef[], evalId?: string): void {
    this.db.run('INSERT INTO digest_queue (id, eval_id, text, refs, created_at) VALUES (?, ?, ?, ?, ?)', newId(), evalId, text, toJson(refs), nowIso());
  }
  takeDigest(): { text: string; refs: CardRef[] }[] {
    const rows = this.db.all<Row>('SELECT * FROM digest_queue WHERE used = 0 ORDER BY created_at');
    this.db.run('UPDATE digest_queue SET used = 1 WHERE used = 0');
    return rows.map((r) => ({ text: r.text, refs: fromJson<CardRef[]>(r.refs, []) }));
  }

  getBudget(date: string, init: () => { budget: number; phase: SemesterPhase }): { date: string; budget: number; spent: number; phase: SemesterPhase } {
    let r = this.db.get<Row>('SELECT * FROM attention_budget WHERE date = ?', date);
    if (!r) {
      const { budget, phase } = init();
      this.db.run('INSERT INTO attention_budget (date, budget, spent, semester_phase) VALUES (?, ?, 0, ?)', date, budget, phase);
      r = this.db.get<Row>('SELECT * FROM attention_budget WHERE date = ?', date)!;
    }
    return { date: r.date, budget: r.budget, spent: r.spent, phase: r.semester_phase };
  }
  spendBudget(date: string, cost: number): void {
    this.db.run('UPDATE attention_budget SET spent = spent + ? WHERE date = ?', cost, date);
  }
  resetBudget(date: string): void {
    this.db.run('DELETE FROM attention_budget WHERE date = ?', date);
  }

  /** 整体替换校历（校历是由 calendar.ts 生成的派生数据，旧的日期行要一起清掉） */
  setCalendar(days: { date: string; weekNo?: number; phase: SemesterPhase; note?: string }[]): void {
    this.db.tx(() => {
      this.db.run('DELETE FROM calendar');
      for (const d of days) this.db.run('INSERT OR REPLACE INTO calendar (date, week_no, phase, note) VALUES (?, ?, ?, ?)', d.date, d.weekNo, d.phase, d.note);
    });
  }
  calendarDay(date: string): { weekNo?: number; phase: SemesterPhase; note?: string } | undefined {
    const r = this.db.get<Row>('SELECT * FROM calendar WHERE date = ?', date);
    return r ? { weekNo: r.week_no ?? undefined, phase: r.phase, note: r.note ?? undefined } : undefined;
  }

  addTicket(t: { title: string; request: string; mandate: Ticket['mandate']; status: Ticket['status']; threadKey?: string; goalId?: string }): Ticket {
    const id = newId();
    this.db.run('INSERT INTO tickets (id, title, request, mandate, status, thread_key, goal_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      id, t.title, t.request, t.mandate, t.status, t.threadKey, t.goalId, nowIso());
    return this.getTicket(id)!;
  }
  getTicket(id: string): Ticket | undefined {
    const r = this.db.get<Row>('SELECT * FROM tickets WHERE id = ?', id);
    return r ? mapTicket(r) : undefined;
  }
  listTickets(status?: Ticket['status']): Ticket[] {
    return this.db.all<Row>(`SELECT * FROM tickets ${status ? 'WHERE status = ?' : ''} ORDER BY created_at DESC`, ...(status ? [status] : [])).map(mapTicket);
  }
  setTicketStatus(id: string, status: Ticket['status'], resultResourceId?: string): void {
    const ended = ['done', 'failed', 'dropped'].includes(status) ? nowIso() : null;
    this.db.run('UPDATE tickets SET status=?, result_resource_id=COALESCE(?, result_resource_id), ended_at=? WHERE id=?', status, resultResourceId, ended, id);
  }
  addTicketReport(ticketId: string, kind: string, content: string, question?: unknown): void {
    this.db.run('INSERT INTO ticket_reports (id, ticket_id, kind, content, question, created_at) VALUES (?, ?, ?, ?, ?, ?)', newId(), ticketId, kind, content, toJson(question), nowIso());
  }

  /**
   * 清除所有个人数据（PRD：一键清除）。
   * 只保留应用设置（模型配置、演示模式开关）；同步进度、邮箱密码、画像等也一并清除，
   * 这样清除后的下一次同步按「首次同步」处理，不会把整个学期的历史当成新事件。
   */
  wipe(): void {
    const tables = ['courses', 'items', 'links', 'chat_messages', 'conversation_summaries', 'memories', 'goals', 'tasks', 'followups',
      'feed_cards', 'resources', 'resource_chunks', 'triggers', 'evals', 'digest_queue', 'tickets', 'ticket_reports', 'attention_budget', 'search_index'];
    this.db.tx(() => {
      tables.forEach((t) => this.db.run(`DELETE FROM ${t}`));
      this.db.run("DELETE FROM settings WHERE key != 'settings'");
    });
  }
}

// ---------------- 行映射 ----------------
const opt = <T>(v: T | null): T | undefined => (v === null ? undefined : v);

function mapCourse(r: Row): Course {
  return {
    id: r.id, code: r.code, section: opt(r.section), name: r.name, term: opt(r.term), teachers: fromJson(r.teachers, []),
    elearningId: opt(r.elearning_id), icourseId: opt(r.icourse_id), matchStatus: r.match_status, assessments: fromJson(r.assessments, []),
    schedule: fromJson(r.schedule, []),
  };
}
function mapItem(r: Row): Item {
  return {
    id: r.id, source: r.source, kind: r.kind, sourceId: r.source_id, title: r.title, body: r.body, url: opt(r.url),
    publishedAt: r.published_at, dueAt: opt(r.due_at), courseId: opt(r.course_id), done: !!r.done, sender: opt(r.sender),
    aiCategory: opt(r.ai_category), aiSummary: opt(r.ai_summary), aiAction: opt(r.ai_action), aiModelUsed: opt(r.ai_model_used),
  };
}
function mapMessage(r: Row): ChatMessage {
  return {
    id: r.id, role: r.role, content: r.content, cards: fromJson(r.cards, []), refs: fromJson(r.refs, []),
    actions: fromJson<QuickAction[]>(r.actions, []), toolCalls: fromJson(r.tool_calls, []), proactive: !!r.proactive,
    trigger: opt(r.trigger), createdAt: r.created_at,
  };
}
function mapMemory(r: Row): Memory {
  return { id: r.id, type: r.type, content: r.content, source: r.source, sourceMsgId: opt(r.source_msg_id), pinned: !!r.pinned, expiresAt: opt(r.expires_at), createdAt: r.created_at, updatedAt: r.updated_at };
}
function mapGoal(r: Row): Goal {
  return { id: r.id, level: r.level, title: r.title, description: opt(r.description), courseId: opt(r.course_id), dueAt: opt(r.due_at), status: r.status, createdBy: r.created_by, createdAt: r.created_at };
}
function mapTask(r: Row): Task {
  return { id: r.id, goalId: opt(r.goal_id), itemId: opt(r.item_id), title: r.title, dueAt: opt(r.due_at), status: r.status, source: r.source, verify: fromJson(r.verify, undefined), localDone: !!r.local_done };
}
function mapFollowup(r: Row): Followup {
  return { id: r.id, topic: r.topic, dueAt: r.due_at, itemId: opt(r.item_id), status: r.status, verify: fromJson(r.verify, undefined) };
}
function mapFeed(r: Row): FeedCard {
  return { id: r.id, type: r.type, title: r.title, body: r.body, reason: r.reason, done: opt(r.done), refs: fromJson(r.refs, []), actions: fromJson(r.actions, []), score: r.score, status: r.status, dismissReason: opt(r.dismiss_reason), createdAt: r.created_at };
}
function mapResource(r: Row): Resource {
  return { id: r.id, title: r.title, kind: r.kind, courseId: opt(r.course_id), mime: r.mime, text: r.text, createdAt: r.created_at };
}
function mapTrigger(r: Row): Trigger {
  return { id: r.id, source: r.source, kind: r.kind, sourceRef: r.source_ref, threadKey: r.thread_key, payload: fromJson(r.payload, {}), occurredAt: r.occurred_at, disposition: r.disposition, evalId: opt(r.eval_id) };
}
function mapEval(r: Row): EvalRecord {
  return {
    id: r.id, threadKey: r.thread_key, triggerIds: fromJson(r.trigger_ids, []), gate: fromJson<GateResult[]>(r.gate_result, []),
    assessment: fromJson<Assessment | undefined>(r.assessment, undefined), decision: r.decision as Decision, attentionCost: r.attention_cost,
    reason: r.reason, modelUsed: r.model_used, ruleMode: r.rule_mode, createdAt: r.created_at,
  };
}
function mapTicket(r: Row): Ticket {
  return { id: r.id, title: r.title, request: r.request, mandate: r.mandate, status: r.status, threadKey: opt(r.thread_key), goalId: opt(r.goal_id), resultResourceId: opt(r.result_resource_id), createdAt: r.created_at, endedAt: opt(r.ended_at) };
}

/** 按段落切分，每块约 800 字 */
export function chunkText(text: string, size = 800): string[] {
  const paras = text.split(/\n{2,}/);
  const out: string[] = [];
  let cur = '';
  for (const p of paras) {
    if ((cur + p).length > size && cur) { out.push(cur); cur = ''; }
    cur += (cur ? '\n\n' : '') + p;
    while (cur.length > size * 1.5) { out.push(cur.slice(0, size)); cur = cur.slice(size); }
  }
  if (cur.trim()) out.push(cur);
  return out;
}
