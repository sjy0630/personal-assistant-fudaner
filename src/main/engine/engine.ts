import type { Assessment, CardRef, ChatMessage, Decision, EvalRecord, GateResult, Profile, Trigger } from '../../shared/types';
import type { Repo } from '../db/repo';
import type { ModelRouter } from '../ai/llm';
import { morningPrompt } from '../ai/prompts';
import { buildToday } from '../today';
import { assess, heuristic } from './assess';
import { ATTENTION_COST, applyBudget, dailyBudget } from './budget';
import { localDate } from './calendar';
import type { Channels } from './channels';
import { currentPhase, emitClockTriggers } from './clock';
import { gate } from './gate';

/**
 * 主动引擎（PRD §5.7、§7.8）。
 *
 * 参考 dsh-superagent 的领域模型：
 *   Source → Trigger → Thread → Eval（Gate + Assessment）→ Decision → Channel / Ticket
 * 第一原则：占用尽量少的注意力，提供尽量多的价值。
 *
 * 所有方法只依赖 Repo / ModelRouter / Channels，不依赖 Electron，可以在 Node 测试中直接运行。
 */
export class ProactiveEngine {
  private running = false;

  constructor(
    private readonly repo: Repo,
    private readonly router: ModelRouter,
    private readonly channels: Channels,
  ) {}

  /** 一次完整的处理循环：时钟事件 → 评估待处理事件 → 写回 */
  async tick(now = new Date()): Promise<EvalRecord[]> {
    if (this.running) return [];
    this.running = true;
    try {
      emitClockTriggers(this.repo, now);
      return await this.evaluatePending(now);
    } finally {
      this.running = false;
    }
  }

  /** 按线程归并：同一线程的事件合并成一批评估，避免对同一件事反复打扰 */
  async evaluatePending(now: Date): Promise<EvalRecord[]> {
    const pending = this.repo.pendingTriggers();
    const byThread = new Map<string, Trigger[]>();
    for (const t of pending) {
      // 早安单独处理，不和其他事件合并
      const key = t.kind === 'morning' ? `morning:${t.sourceRef}` : t.threadKey;
      byThread.set(key, [...(byThread.get(key) ?? []), t]);
    }
    const out: EvalRecord[] = [];
    // 早安消息最先处理，之后的提醒排在它后面
    const ordered = [...byThread].sort(([a], [b]) => Number(b.startsWith('morning:')) - Number(a.startsWith('morning:')));
    for (const [threadKey, batch] of ordered) {
      out.push(await this.evaluateThread(threadKey, batch, now));
    }
    return out;
  }

  private budgetState(now: Date) {
    const date = localDate(now);
    const profile = this.repo.getProfile();
    const phase = currentPhase(this.repo, date);
    const b = this.repo.getBudget(date, () => ({ budget: dailyBudget(profile.proactivity, phase), phase }));
    return { ...b, remaining: Math.max(0, b.budget - b.spent), phase };
  }

  private async evaluateThread(threadKey: string, batch: Trigger[], now: Date): Promise<EvalRecord> {
    const settings = this.repo.getSettings();

    // 1. 准入（确定性规则）
    const gates: GateResult[] = batch.map((t) => {
      const itemId = t.payload.itemId ? String(t.payload.itemId) : undefined;
      const item = itemId ? this.repo.getItem(itemId) : undefined;
      const task = itemId ? this.repo.taskForItem(itemId) : undefined;
      const alreadyReminded = !!task && t.kind.startsWith('deadline_') && !this.repo.markReminderSentDryRun(task.id, t.kind);
      return gate(t, { now, settings, item, task, alreadyReminded, mutedKinds: this.repo.getKv<string[]>('muted_kinds', []) });
    });
    const passed = batch.filter((_, i) => gates[i].pass);
    const filtered = batch.filter((_, i) => !gates[i].pass);

    const budget = this.budgetState(now);
    if (passed.length === 0) {
      const ev = this.repo.addEval({
        threadKey, triggerIds: batch.map((t) => t.id), gate: gates, decision: 'record', attentionCost: 0,
        reason: gates.map((g) => g.note).filter(Boolean).join('；') || '未通过准入', modelUsed: 'rules', ruleMode: 'live',
      });
      this.repo.setTriggerDisposition(batch.map((t) => t.id), 'filtered', ev.id);
      return ev;
    }

    // 早安消息：固定发送，单独组装
    if (passed.some((t) => t.kind === 'morning')) {
      return this.morning(threadKey, batch, gates, now, budget.date);
    }

    // 研判前补充事实（确定性数据，不交给模型猜）：提交的作业之前有没有提醒过
    for (const t of passed) {
      if (t.kind === 'assignment_submitted' && t.payload.itemId) {
        const itemId = String(t.payload.itemId);
        const task = this.repo.taskForItem(itemId);
        const followed = this.repo.listFollowupsForItem(itemId).length > 0;
        t.payload.wasReminded = (task ? this.repo.remindersSent(task.id).length > 0 : false) || followed;
      }
    }

    // 2. 研判（本地模型；没有模型时用规则）
    const memories = this.repo.listMemories(['goal', 'interest', 'preference', 'schedule']);
    const { assessment, model } = await assess(passed, {
      llm: this.router.for('assess'), memories, phase: budget.phase, now, describe: (t) => describeTrigger(t),
    });

    // 3. 决定：注意力预算 + 静默时段 + 观察模式
    const quiet = gates.some((g) => g.rule === 'quiet_hours');
    let { decision, note } = applyBudget(assessment.action, assessment.value, budget.remaining, budget.phase);
    if (quiet && (decision === 'chat_notify' || decision === 'chat')) {
      decision = 'digest';
      note = '静默时段，并入早安消息';
    }
    const observed = (settings.observeRules ?? []).some((r) => passed.some((t) => t.kind === r || t.payload.category === r));
    const cost = observed ? 0 : ATTENTION_COST[decision];

    const ev = this.repo.addEval({
      threadKey, triggerIds: batch.map((t) => t.id), gate: gates, assessment, decision, attentionCost: cost,
      reason: [assessment.reason, note, observed ? '观察模式：只记录本来会做什么' : undefined].filter(Boolean).join('；'),
      modelUsed: model, ruleMode: observed ? 'observe' : 'live',
    });
    this.repo.setTriggerDisposition(passed.map((t) => t.id), 'evaluated', ev.id);
    if (filtered.length) this.repo.setTriggerDisposition(filtered.map((t) => t.id), 'filtered', ev.id);

    // 4. 写回
    if (!observed) {
      this.repo.spendBudget(budget.date, cost);
      for (const t of passed) {
        if (t.kind.startsWith('deadline_') && t.payload.itemId) {
          const task = this.repo.taskForItem(String(t.payload.itemId));
          if (task) this.repo.markReminderSent(task.id, t.kind);
        }
      }
      // 同一线程里分数最高的事件用这次的决定写回；其余事件各自生成动态卡片，避免被合并后「消失」
      const ranked = passed
        .map((t) => ({ t, h: heuristic([t], { memories, phase: budget.phase, now, describe: describeTrigger }) }))
        .sort((x, y) => y.h.value - x.h.value);
      // 写回时还要知道：是否在静默时段、扣掉这次成本后今天还剩多少预算（高价值建议是否值得额外在对话里问）
      this.writeBack(decision, assessment, [ranked[0].t], ev, { quiet, remaining: budget.remaining - cost, date: budget.date });
      for (const r of ranked.slice(1)) {
        if (r.h.action === 'record' || r.h.action === 'digest') continue;
        this.addCard([r.t], r.h, refsOf([r.t], this.repo));
        this.repo.spendBudget(budget.date, ATTENTION_COST.card);
      }
    }
    return ev;
  }

  private writeBack(decision: Decision, a: Assessment, batch: Trigger[], ev: EvalRecord, ctx: { quiet: boolean; remaining: number; date: string }): void {
    const refs = refsOf(batch, this.repo);
    const text = a.messageDraft || batch.map(describeTrigger).join('\n');
    switch (decision) {
      case 'chat_notify':
      case 'chat': {
        const actions = batch.some((t) => t.kind === 'auth_expired') ? [{ label: '重新登录', action: 'login' }] : [];
        const msg = this.post({ content: text, cards: refs, trigger: `eval:${ev.id}`, actions });
        if (decision === 'chat_notify') this.channels.notify(this.repo.getProfile().assistantName, text, msg.id);
        // 来自校内平台的重要事件同时留在「动态」里：对话只放需要你注意的，动态是完整的记录（不额外占用注意力预算）
        if (batch.some((t) => PLATFORM_SOURCES.includes(t.source) && t.kind !== 'auth_expired' && t.kind !== 'assignment_submitted')) {
          this.addCard(batch, a, refs);
        }
        break;
      }
      case 'card':
        this.addCard(batch, a, refs);
        break;
      case 'digest':
        this.repo.addDigest(text, refs, ev.id);
        break;
      case 'suggest_ticket': {
        const ticket = this.repo.addTicket({
          title: a.ticket?.title ?? '帮你整理一下', request: a.ticket?.request ?? text, mandate: 'inferred', status: 'suggested', threadKey: ev.threadKey,
        });
        this.repo.addFeedCard({
          type: 'suggest_ticket', title: ticket.title, body: text, reason: a.reason, refs,
          actions: [{ label: '好，帮我做', action: 'accept_ticket', payload: { ticketId: ticket.id } }, { label: '不用', action: 'dismiss' }],
          score: a.value, dedupeKey: `ticket:${ticket.id}`,
        });
        this.channels.changed('feed');
        // 价值很高的建议（如考试周前的复习计划）直接在对话里问一句，而不只是放在动态里
        // 这次额外的对话消息同样要遵守静默时段和当天剩余预算：
        // 静默时段 → 攒到早安消息里说；预算不够 → 只留在动态里
        if (a.value >= HIGH_VALUE_SUGGESTION) {
          if (ctx.quiet) {
            this.repo.addDigest(text, refs, ev.id);
          } else if (ctx.remaining >= ATTENTION_COST.chat) {
            this.post({
              content: text, cards: refs, trigger: `eval:${ev.id}`,
              actions: [{ label: '好，帮我做', action: 'accept_ticket', payload: { ticketId: ticket.id } }, { label: '先不用', action: 'decline_ticket', payload: { ticketId: ticket.id } }],
            });
            this.repo.spendBudget(ctx.date, ATTENTION_COST.chat);
          }
        }
        break;
      }
      case 'record':
        break;
    }
  }

  private addCard(batch: Trigger[], a: Assessment, refs: CardRef[]): void {
    const t = batch[0];
    const type = t.kind === 'activity_new' ? 'opportunity'
      : t.kind === 'notice_new' ? 'campus_notice'
      : t.kind === 'exam_soon' ? 'assignment'
      : t.kind === 'card_low' || t.kind === 'power_low' ? 'insight'
      : t.kind === 'announcement_new' ? 'announcement'
      : t.kind === 'mail_new' ? (t.payload.category === 'course' ? 'course_mail' : t.payload.category === 'notice' ? 'opportunity' : 'mail_action')
      : t.kind.startsWith('assignment') || t.kind.startsWith('deadline') ? 'assignment' : 'insight';
    const done = t.kind === 'assignment_new' ? '已加入课程目标' : t.payload.linkedTitle ? `已关联到作业「${t.payload.linkedTitle}」` : undefined;
    // 需要处理的邮件和未完成的作业，卡片上可以直接在本地标记（不改邮箱 / eLearning）
    const itemId = typeof t.payload.itemId === 'string' ? t.payload.itemId : undefined;
    const markable = itemId && (
      (t.kind === 'mail_new' && ['reply', 'action', 'course'].includes(String(t.payload.category))) ||
      t.kind === 'assignment_new' || t.kind.startsWith('deadline_'));
    const markAction = markable
      ? [{ label: t.kind === 'mail_new' ? '标记已处理' : '标记完成', action: 'mark_done', payload: { itemId } }]
      : t.kind === 'activity_new' && itemId ? [{ label: '加入计划', action: 'add_to_plan', payload: { itemId } }] : [];
    this.repo.addFeedCard({
      type, title: String(t.payload.title ?? t.payload.subject ?? describeTrigger(t)), body: a.messageDraft, reason: a.reason, done, refs,
      actions: [{ label: '引用到对话', action: 'quote' }, ...markAction, { label: '不感兴趣', action: 'dismiss' }],
      score: a.value, dedupeKey: `${t.kind}:${t.sourceRef}`,
    });
    this.channels.changed('feed');
  }

  private post(m: { content: string; cards?: CardRef[]; trigger?: string; actions?: ChatMessage['actions'] }): ChatMessage {
    const msg = this.repo.addMessage({ role: 'assistant', content: m.content, cards: m.cards, actions: m.actions, proactive: true, trigger: m.trigger });
    this.channels.messagePosted(msg);
    return msg;
  }

  /** 早安消息（PRD §5.1）：程序整理事实，模型只负责用助理的口吻写出来 */
  private async morning(threadKey: string, batch: Trigger[], gates: GateResult[], now: Date, date: string): Promise<EvalRecord> {
    const today = buildToday(this.repo, now);
    const profile = this.repo.getProfile();
    const urgent = today.deadlines.filter((d) => !d.done && Date.parse(d.dueAt) - now.getTime() < 72 * 3_600_000);
    const replyMails = this.repo.listItems({ kind: 'email', category: 'reply', done: false, limit: 3 });
    const digest = this.repo.takeDigest();
    const followups = this.repo.pendingFollowups().filter((f) => f.dueAt <= new Date(now.getTime() + 18 * 3_600_000).toISOString());

    const facts = [
      `日期：${today.date}${today.weekNo ? `，第 ${today.weekNo} 周` : ''}，阶段：${today.phase}`,
      today.courses.length ? `今天的课：${today.courses.map((c) => `${c.time} ${c.name}${c.location ? `（${c.location}）` : ''}`).join('；')}` : '今天没有课（或未导入课表）',
      today.freeSlots.length ? `空闲时段：${today.freeSlots.map((f) => `${f.start}–${f.end}`).join('、')}` : '',
      urgent.length ? `72 小时内未交的作业：\n${urgent.map((d) => `- ${d.title}（${d.course ?? ''}）截止 ${d.dueAt}`).join('\n')}` : '72 小时内没有未交的作业',
      replyMails.length ? `需要回复的邮件：\n${replyMails.map((m) => `- ${m.sender ?? ''}：${m.title}`).join('\n')}` : '',
      followups.length ? `要跟进的事：\n${followups.map((f) => `- ${f.topic}`).join('\n')}` : '',
      digest.length ? `攒下来的动态：\n${digest.map((d) => `- ${d.text}`).join('\n')}` : '',
    ].filter(Boolean).join('\n\n');

    let content = '';
    let model = 'template';
    const llm = this.router.for('brief');
    if (llm) {
      try {
        const r = await llm.chat([{ role: 'user', content: morningPrompt({ facts, styleHint: styleHint(profile) }) }], { temperature: 0.7, maxTokens: 400 });
        content = r.content.trim();
        model = llm.label;
      } catch {
        content = '';
      }
    }
    if (!content) content = templateMorning(profile, today.weekNo, today.courses, urgent, replyMails.length, digest.map((d) => d.text), followups.map((f) => f.topic));

    const cards: CardRef[] = [
      ...urgent.slice(0, 3).map((d) => ({ type: 'item' as const, id: d.itemId, title: d.title, subtitle: `${d.course ?? ''} · 截止 ${fmt(d.dueAt)}` })),
      ...replyMails.slice(0, 2).map((m) => ({ type: 'item' as const, id: m.id, title: m.title, subtitle: `邮件 · ${m.sender ?? ''}` })),
      ...digest.flatMap((d) => d.refs).slice(0, 2),
    ];
    const ev = this.repo.addEval({
      threadKey, triggerIds: batch.map((t) => t.id), gate: gates, decision: 'chat_notify', attentionCost: ATTENTION_COST.chat_notify,
      reason: `每日早安（合并了 ${digest.length} 条攒下的动态）`, modelUsed: model, ruleMode: 'live',
    });
    this.repo.setTriggerDisposition(batch.map((t) => t.id), 'evaluated', ev.id);
    this.repo.spendBudget(date, ATTENTION_COST.chat_notify);
    const msg = this.post({ content, cards, trigger: 'morning' });
    this.channels.notify(profile.assistantName, content.slice(0, 60), msg.id);
    return ev;
  }

  /**
   * 可验证的闭环（PRD §5.7 第 5 步）：每次同步之后调用。
   * 作业在 eLearning 上显示已提交 → 结束提醒、完成任务、跟进自动关闭。
   */
  verifyAfterSync(): void {
    let changed = false;
    for (const task of this.repo.listTasks({ status: 'todo' })) {
      if (task.verify?.type === 'assignment_submitted') {
        const item = this.repo.getItem(task.verify.itemId);
        if (item?.done) {
          this.repo.setTaskStatus(task.id, 'done', 'platform');
          changed = true;
        }
      }
    }
    for (const f of this.repo.pendingFollowups()) {
      if (f.verify?.type === 'assignment_submitted' && this.repo.getItem(f.verify.itemId)?.done) {
        this.repo.setFollowupStatus(f.id, 'done');
      }
    }
    if (changed) this.channels.changed('goals');
  }
}

/** 来自校内平台的事件来源 */
const PLATFORM_SOURCES: Trigger['source'][] = ['elearning', 'mail', 'icourse', 'notice'];
/** 建议工单的价值达到这个值时，除了动态卡片，还会在对话里直接问 */
const HIGH_VALUE_SUGGESTION = 0.8;

export function describeTrigger(t: Trigger): string {
  const p = t.payload as Record<string, string | undefined>;
  switch (t.kind) {
    case 'mail_new': return `[邮件/${p.category}] ${p.from}：${p.subject}。${p.summary ?? ''}${p.linkedTitle ? `（关联作业：${p.linkedTitle}）` : ''}`;
    case 'assignment_new': return `[新作业] ${p.course}：${p.title}，截止 ${p.dueText}`;
    case 'assignment_changed': return `[作业变更] ${p.course}：${p.title}，新截止 ${p.dueText}`;
    case 'assignment_submitted': return `[已提交] ${p.title}`;
    case 'announcement_new': return `[公告] ${p.course}：${p.title}`;
    case 'exam_soon': return `[考试] ${p.course}，${p.timeText ?? ''}，考场 ${p.location ?? '未知'}，还有 ${p.daysLeft} 天`;
    case 'card_low': return `[校园卡] 余额 ¥${p.balance}`;
    case 'power_low': return `[宿舍电量] ${p.room} 剩 ${p.remaining} 度`;
    case 'notice_new': return `[学校通知/${p.sourceName}] ${p.title}${p.own ? '（本人院系）' : ''}${p.excerpt ? `\n正文开头：${p.excerpt}` : ''}`;
    case 'activity_new': return `[校园活动/${p.category ?? '其他'}] ${p.title}；时间 ${p.timeText ?? '未写明'}；地点 ${p.location ?? '未写明'}${p.campus ? `（${p.campus}）` : ''}；主办 ${p.organizer ?? '未写明'}。${p.summary ?? ''}${p.excerpt ? `\n原文开头：${p.excerpt}` : ''}`;
    default: return `[${t.kind}] ${p.title ?? p.topic ?? ''}`;
  }
}

function refsOf(batch: Trigger[], repo: Repo): CardRef[] {
  const refs: CardRef[] = [];
  for (const t of batch) {
    const id = t.payload.itemId as string | undefined;
    if (id) {
      const it = repo.getItem(id);
      const activityLine = it?.activity ? [it.activity.startsAt ? fmt(it.activity.startsAt) : it.activity.timeText, it.activity.location].filter(Boolean).join(' · ') : '';
      if (it && !refs.some((r) => r.id === id)) refs.push({ type: 'item', id, title: it.title, subtitle: activityLine || (it.dueAt ? `截止 ${fmt(it.dueAt)}` : it.sender) });
    }
    const linked = t.payload.linkedItemId as string | undefined;
    if (linked && !refs.some((r) => r.id === linked)) {
      const it = repo.getItem(linked);
      if (it) refs.push({ type: 'item', id: linked, title: it.title, subtitle: '关联作业' });
    }
  }
  return refs;
}

export function fmt(iso: string): string {
  const d = new Date(iso);
  const wd = '日一二三四五六'[d.getDay()];
  return `${d.getMonth() + 1}/${d.getDate()} 周${wd} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function styleHint(p: Profile): string {
  return { warm: '语气温和体贴。', concise: '语气简洁干练。', playful: '语气轻松幽默，可以用一个表情。' }[p.style];
}

function templateMorning(
  p: Profile, week: number | undefined, courses: { name: string; time?: string; location?: string }[],
  urgent: { title: string; dueAt: string }[], replies: number, digest: string[], followups: string[],
): string {
  const parts = [`早${p.nickname ? `，${p.nickname}` : ''}～${week ? `第 ${week} 周，` : ''}今天${courses.length ? ` ${courses.length} 节课：${courses.map((c) => `${c.time?.split('–')[0]} ${c.name}${c.location ? `（${c.location}）` : ''}`).join('，')}` : '没有课'}。`];
  parts.push('今天的重点：');
  if (urgent.length) parts.push(urgent.slice(0, 3).map((d) => `「${d.title}」${fmt(d.dueAt)} 截止还没交`).join('；') + '。');
  else parts.push('72 小时内没有要交的作业，可以喘口气。');
  if (replies) parts.push(`有 ${replies} 封邮件等你回复。`);
  if (followups.length) parts.push(`昨天说的「${followups[0]}」，进展怎么样？`);
  if (digest.length) parts.push(`另外：${digest.slice(0, 2).join('；')}`);
  return parts.join('\n');
}
