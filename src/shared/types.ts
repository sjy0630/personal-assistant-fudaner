/**
 * 前后端共享的领域类型。字段与 PRD §7.7 的数据模型一一对应。
 * 修改这里的类型时，请同步修改 src/main/db/schema.ts。
 */

export type ItemSource = 'elearning' | 'mail' | 'icourse' | 'notice' | 'demo';
export type ItemKind = 'assignment' | 'announcement' | 'email' | 'replay' | 'notice';
export type MailCategory = 'reply' | 'action' | 'course' | 'notice' | 'other';

/** 统一的「事项」：来自各平台的一条信息 */
export interface Item {
  id: string;
  source: ItemSource;
  kind: ItemKind;
  sourceId: string;
  title: string;
  body: string;
  url?: string;
  publishedAt: string;
  dueAt?: string;
  courseId?: string;
  /** 作业：是否已提交；邮件：是否已处理 */
  done: boolean;
  /** 邮件发件人（email 类） */
  sender?: string;
  aiCategory?: MailCategory;
  aiSummary?: string;
  aiAction?: string;
  aiModelUsed?: string;
}

export interface CourseTeacher { name: string; email?: string; role: 'teacher' | 'ta' }

export interface Course {
  id: string;
  code: string;
  section?: string;
  name: string;
  term?: string;
  teachers: CourseTeacher[];
  elearningId?: string;
  icourseId?: string;
  matchStatus: 'auto' | 'pending' | 'manual';
  /** 考核安排，例如 [{ kind: 'midterm', date: '2026-11-20' }]，用于学期节奏感知 */
  assessments?: { kind: 'midterm' | 'final' | 'quiz'; date: string }[];
  /** 每周上课时间（来自课表导入或手动填写；演示模式由演示数据提供） */
  schedule?: CourseSlot[];
}

/** weekday：1 = 周一 … 7 = 周日；时间为 HH:MM */
export interface CourseSlot { weekday: number; start: string; end: string; location?: string }

export interface Link { id: string; fromItemId: string; toItemId: string; reason: string; confidence: number; confirmed: boolean }

// ---------- 对话 ----------
export type Role = 'user' | 'assistant' | 'tool';

/** 嵌在消息里的卡片 */
export interface CardRef {
  type: 'item' | 'goal' | 'task' | 'resource' | 'feed' | 'ticket'; id: string; title: string; subtitle?: string;
  /** 仅服务端为本轮真实创建的结果生成；客户端不能凭此撤销任意对象。 */
  undoToken?: string;
  undone?: boolean;
}
export interface ReferenceDetail {
  title: string;
  label: string;
  body: string;
  fields?: { label: string; value: string }[];
  related?: CardRef[];
}
export type ReferenceOpenResult =
  | { kind: 'external'; url: string }
  | { kind: 'page'; page: 'goals' | 'library' | 'feed'; id: string }
  | { kind: 'detail'; detail: ReferenceDetail };

/** 消息里的快捷按钮 */
export interface QuickAction { label: string; action: string; payload?: Record<string, unknown>; used?: boolean }

export interface ToolCallView { id?: string; name: string; server: string; args: unknown; ok?: boolean; summary?: string }

/** 版本递增，避免页面恢复时旧快照覆盖新进度。 */
export interface ChatRun { id: string; content: string; toolCalls: ToolCallView[]; startedAt: string; version: number }

export interface ChatMessage {
  id: string;
  role: Role;
  content: string;
  cards: CardRef[];
  /** 用户引用的对象 */
  refs: CardRef[];
  actions: QuickAction[];
  toolCalls: ToolCallView[];
  /** 是否为助理主动发起的消息 */
  proactive: boolean;
  trigger?: string;
  createdAt: string;
}

// ---------- 记忆 ----------
export type MemoryType = 'preference' | 'schedule' | 'goal' | 'person' | 'status' | 'interest';
export interface Memory {
  id: string;
  type: MemoryType;
  content: string;
  source: 'chat' | 'manual' | 'feedback';
  sourceMsgId?: string;
  pinned: boolean;
  expiresAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface Profile {
  nickname?: string;
  school?: string;
  major?: string;
  grade?: string;
  degree?: '本科' | '硕士' | '博士';
  freeText?: string;
  assistantName: string;
  style: 'warm' | 'concise' | 'playful';
  /** 主动程度：对应注意力预算 少 / 中 / 多 */
  proactivity: 'low' | 'medium' | 'high';
}

// ---------- 目标 ----------
export type GoalLevel = 'long_term' | 'course' | 'week';
export interface Goal {
  id: string;
  level: GoalLevel;
  title: string;
  description?: string;
  courseId?: string;
  dueAt?: string;
  status: 'active' | 'done' | 'archived';
  createdBy: 'user' | 'assistant' | 'system';
  createdAt: string;
}

export interface Task {
  id: string;
  goalId?: string;
  itemId?: string;
  title: string;
  dueAt?: string;
  status: 'todo' | 'done' | 'skipped';
  source: 'elearning' | 'assistant' | 'user';
  /** 可验证的闭环条件（PRD §5.7） */
  verify?: VerifyCondition;
}

export type VerifyCondition = { type: 'assignment_submitted'; itemId: string };

// ---------- 动态 ----------
export type FeedCardType = 'assignment' | 'announcement' | 'course_mail' | 'mail_action' | 'opportunity' | 'replay' | 'insight' | 'suggest_ticket';
export interface FeedCard {
  id: string;
  type: FeedCardType;
  title: string;
  body: string;
  /** 为什么推给你 */
  reason: string;
  /** 助理已经做了什么，如「已关联到作业 Lab 5」 */
  done?: string;
  refs: CardRef[];
  actions: QuickAction[];
  score: number;
  status: 'new' | 'seen' | 'dismissed' | 'accepted';
  dismissReason?: string;
  createdAt: string;
}

// ---------- 资源库 ----------
export type ResourceKind = 'assistant_output' | 'upload' | 'replay_note' | 'courseware';
export interface Resource {
  id: string;
  title: string;
  kind: ResourceKind;
  courseId?: string;
  mime: string;
  text: string;
  createdAt: string;
}

// ---------- 主动引擎（PRD §5.7、§7.8，参考 dsh-superagent） ----------
export type TriggerSourceKind = 'elearning' | 'mail' | 'icourse' | 'clock' | 'chat';
export type TriggerKind =
  | 'assignment_new' | 'assignment_changed' | 'assignment_submitted' | 'announcement_new'
  | 'mail_new'
  | 'deadline_72h' | 'deadline_24h' | 'deadline_3h'
  | 'morning' | 'weekly_plan' | 'followup_due' | 'phase_change'
  | 'user_commitment'
  | 'auth_expired';

export interface Trigger {
  id: string;
  source: TriggerSourceKind;
  kind: TriggerKind;
  /** 来源内的原始 ID，用于去重（幂等） */
  sourceRef: string;
  /** 线程键：course:<code> / goal:<id> / mail-thread:<id> / daily */
  threadKey: string;
  payload: Record<string, unknown>;
  occurredAt: string;
  disposition: 'pending' | 'filtered' | 'evaluated';
  evalId?: string;
}

export type Decision = 'chat_notify' | 'chat' | 'card' | 'digest' | 'suggest_ticket' | 'record';

export interface GateResult { pass: boolean; rule?: string; note?: string }

export interface Assessment {
  value: number;        // 0–1：对用户的价值
  urgency: number;      // 0–1
  action: Decision;     // 研判建议的处理方式（预算可能会降级它）
  messageDraft: string;
  reason: string;
  verify?: VerifyCondition;
  ticket?: { title: string; request: string };
}

export interface EvalRecord {
  id: string;
  threadKey: string;
  triggerIds: string[];
  gate: GateResult[];
  assessment?: Assessment;
  decision: Decision;
  attentionCost: number;
  reason: string;
  modelUsed: string;
  ruleMode: 'observe' | 'live';
  createdAt: string;
}

export type TicketStatus = 'suggested' | 'queued' | 'working' | 'waiting_user' | 'done' | 'failed' | 'dropped';
export interface Ticket {
  id: string;
  title: string;
  request: string;
  mandate: 'explicit' | 'inferred';
  status: TicketStatus;
  threadKey?: string;
  goalId?: string;
  resultResourceId?: string;
  createdAt: string;
  endedAt?: string;
}

export type SemesterPhase = 'regular' | 'course_selection' | 'midterm' | 'pre_exam' | 'exam' | 'holiday';

export interface Followup {
  id: string;
  topic: string;
  dueAt: string;
  itemId?: string;
  status: 'pending' | 'done' | 'snoozed' | 'cancelled';
  verify?: VerifyCondition;
}

// ---------- 设置与连接 ----------
export interface ModelConfig { baseURL: string; apiKey: string; model: string }
export interface Settings {
  /** 首次使用引导已完成；旧配置缺省时展示引导。 */
  onboardingCompleted?: boolean;
  cloud?: ModelConfig;
  local?: ModelConfig;
  demoMode: boolean;
  /** 本地模型不可用时，是否允许把邮件正文等敏感任务交给云端模型（PRD §6.2，默认否） */
  allowSensitiveToCloud?: boolean;
  /** 处于观察模式的主动规则（只记录、不打扰），如 ['opportunity'] */
  observeRules?: string[];
  quietHours: { start: string; end: string };
  mail?: { host: string; port: number; user: string };
}

export type PlatformName = 'elearning' | 'icourse' | 'mail';
export interface PlatformState { platform: PlatformName; status: 'ok' | 'need_login' | 'unavailable' | 'not_configured' | 'demo'; message?: string; checkedAt?: string }

export interface TodayOverview {
  date: string;
  weekNo?: number;
  phase: SemesterPhase;
  courses: { name: string; time?: string; location?: string }[];
  /** 今天 08:00–22:00 之间不少于 1 小时的空闲时段（按课表计算） */
  freeSlots: { start: string; end: string }[];
  deadlines: { itemId: string; title: string; course?: string; dueAt: string; done: boolean }[];
  mailToReply: number;
  weekProgress: { done: number; total: number };
}

export interface SearchHit { type: 'message' | 'feed' | 'goal' | 'task' | 'resource' | 'item' | 'memory'; id: string; title: string; snippet: string }
