import type {
  Item, ExternalMcpConfig, ExternalMcpStatus, Reminder, ReminderRepeat,
  ChatMessage, CardRef, EvalRecord, FeedCard, Goal, Memory, PlatformState, Profile, Resource,
  SearchHit, Settings, Task, Ticket, TodayOverview, ToolCallView,
} from './types';

/**
 * 渲染进程可以调用的全部接口（通过 preload 暴露为 window.fudaner）。
 * 主进程在 src/main/ipc.ts 中逐个实现。
 */
export interface FudanerApi {
  chat: {
    /** 指定 aroundId 时返回包含该消息的上下文；消息已清理则返回空数组。 */
    history(limit?: number, aroundId?: string): Promise<ChatMessage[]>;
    page(beforeId?: string, limit?: number): Promise<{ messages: ChatMessage[]; hasMore: boolean }>;
    send(text: string, refs?: CardRef[]): Promise<void>;
    state(): Promise<import('./types').ChatRun | null>;
    cancel(messageId: string): Promise<void>;
    undoResult(messageId: string, type: CardRef['type'], id: string): Promise<ChatMessage>;
    quickAction(messageId: string, action: string, payload?: Record<string, unknown>): Promise<void>;
  };
  references: { open(ref: Pick<CardRef, 'type' | 'id'>): Promise<import('./types').ReferenceOpenResult> };
  copyText(text: string): Promise<void>;
  today(): Promise<TodayOverview>;
  feed: {
    list(filter?: { type?: string; includeId?: string }): Promise<FeedCard[]>;
    dismiss(id: string, reason?: string): Promise<void>;
    act(id: string, action: string): Promise<void>;
    /** 现在整理一次动态 */
    refresh(): Promise<{ campus: number; news: number; skipped?: string }>;
  };
  goals: {
    list(): Promise<{ goals: Goal[]; tasks: Task[] }>;
    setTaskStatus(id: string, status: Task['status']): Promise<void>;
  };
  library: {
    list(courseId?: string): Promise<Resource[]>;
    get(id: string): Promise<Resource | null>;
    upload(filePath: string): Promise<Resource>;
    remove(id: string): Promise<void>;
  };
  search(query: string): Promise<SearchHit[]>;
  searchDetail(type: SearchHit['type'], id: string): Promise<string | null>;
  memory: {
    list(): Promise<Memory[]>;
    add(content: string, type: Memory['type']): Promise<void>;
    update(id: string, content: string): Promise<void>;
    remove(id: string): Promise<void>;
  };
  profile: { get(): Promise<Profile>; set(p: Partial<Profile>): Promise<void> };
  settings: {
    get(): Promise<Settings>;
    set(s: Partial<Settings>): Promise<void>;
    setMailPassword(password: string): Promise<void>;
    testModel(which: 'cloud' | 'local'): Promise<{ ok: boolean; message: string }>;
  };
  platforms: {
    status(): Promise<PlatformState[]>;
    login(): Promise<void>;
    syncNow(): Promise<void>;
  };
  activities: {
    /** 接下来 days 天的活动（默认 14 天） */
    list(days?: number): Promise<Item[]>;
    /** 导入一篇文章链接里的活动 */
    import(url: string): Promise<{ title: string; activities: Item[]; past: number }>;
    /** 立即读取所有订阅源 */
    syncFeeds(): Promise<{ entries: number; activities: number; errors: string[] }>;
  };
  campus: {
    status(): Promise<{ timetable: { semester?: string; courses: number; updatedAt: string } | null; exams: { exams: number; updatedAt: string } | null; problems: Record<string, string> }>;
    importTimetable(): Promise<{ semester?: string; courses: number }>;
    importExams(): Promise<{ exams: number; added: number }>;
    library(): Promise<{ name: string; inside: number | null; remaining: number | null; openTime?: string }[]>;
    cardBalance(): Promise<{ balance: number; at: string }>;
    electricity(): Promise<{ room: string; remainingKwh: number; usedKwh?: number; updatedAt?: string; at: string }>;
    grades(): Promise<{ gpa?: number; credits: number; semesters: number; courses: number; rank?: { ranking?: number; total: number; gpa?: number; note?: string }; updatedAt: string }>;
  };
  treehole: {
    status(): Promise<{ loggedIn: boolean; demo: boolean }>;
    login(email: string, password: string): Promise<void>;
    logout(): Promise<void>;
  };
  external: {
    /** 预设服务的说明（名称、能做什么、准备步骤、仓库、协议） */
    presets(): Promise<{ preset: string; name: string; summary: string; repo: string; license: string; setup: string[]; needsDir: boolean; dirHint?: string }[]>;
    status(): Promise<ExternalMcpStatus[]>;
    /** 保存配置并重新连接，返回连接结果 */
    save(configs: ExternalMcpConfig[]): Promise<ExternalMcpStatus[]>;
  };
  reminders: {
    list(): Promise<Reminder[]>;
    add(r: { title: string; kind: Reminder['kind']; prompt?: string; repeat: ReminderRepeat }): Promise<Reminder>;
    setEnabled(id: string, enabled: boolean): Promise<void>;
    remove(id: string): Promise<void>;
  };
  notices: {
    /** 全部可选来源，以及是否已关注、上次读取的问题 */
    sources(): Promise<{ id: string; name: string; group: string; url: string; enabled: boolean; why?: string; auto: boolean; error?: string }[]>;
    list(query?: string): Promise<Item[]>;
  };
  decisions(limit?: number): Promise<{ evals: EvalRecord[]; budget: { date: string; budget: number; spent: number; phase: string } }>;
  tickets(): Promise<Ticket[]>;
  dev: { setDemoPhase(phase: string): Promise<void>; tick(): Promise<void>; wipe(): Promise<void>; demoSubmitNext(): Promise<void>; demoNewMail(): Promise<void>; resetDemo(): Promise<void> };
  /** 主进程推送的事件 */
  on(channel: FudanerEvent, cb: (payload: unknown) => void): () => void;
}

export type FudanerEvent =
  | 'chat:delta'          // payload: ChatRun，真实增量到达后的带版本运行快照
  | 'chat:message'        // 新消息（含主动消息） payload: ChatMessage
  | 'chat:updated'        // 已保存消息变更 payload: ChatMessage
  | 'chat:cleared'
  | 'chat:tool'           // 工具调用进度 payload: { messageId: string; call: ToolCallView }
  | 'chat:thinking'       // payload: boolean
  | 'feed:changed'
  | 'goals:changed'
  | 'library:changed'
  | 'platforms:changed'
  | 'navigate';           // payload: { page: string; id?: string }

export type { ToolCallView };
