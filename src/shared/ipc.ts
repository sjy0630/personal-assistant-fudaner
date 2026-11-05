import type {
  ChatMessage, CardRef, EvalRecord, FeedCard, Goal, Memory, PlatformState, Profile, Resource,
  SearchHit, Settings, Task, Ticket, TodayOverview, ToolCallView,
} from './types';

/**
 * 渲染进程可以调用的全部接口（通过 preload 暴露为 window.fudaner）。
 * 主进程在 src/main/ipc.ts 中逐个实现。
 */
export interface FudanerApi {
  chat: {
    history(limit?: number): Promise<ChatMessage[]>;
    send(text: string, refs?: CardRef[]): Promise<void>;
    quickAction(messageId: string, action: string, payload?: Record<string, unknown>): Promise<void>;
  };
  today(): Promise<TodayOverview>;
  feed: {
    list(filter?: { type?: string }): Promise<FeedCard[]>;
    dismiss(id: string, reason?: string): Promise<void>;
    act(id: string, action: string): Promise<void>;
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
  decisions(limit?: number): Promise<{ evals: EvalRecord[]; budget: { date: string; budget: number; spent: number; phase: string } }>;
  tickets(): Promise<Ticket[]>;
  dev: { setDemoPhase(phase: string): Promise<void>; tick(): Promise<void>; wipe(): Promise<void>; demoSubmitNext(): Promise<void>; demoNewMail(): Promise<void>; resetDemo(): Promise<void> };
  /** 主进程推送的事件 */
  on(channel: FudanerEvent, cb: (payload: unknown) => void): () => void;
}

export type FudanerEvent =
  | 'chat:message'        // 新消息（含主动消息） payload: ChatMessage
  | 'chat:tool'           // 工具调用进度 payload: { messageId: string; call: ToolCallView }
  | 'chat:thinking'       // payload: boolean
  | 'feed:changed'
  | 'goals:changed'
  | 'library:changed'
  | 'platforms:changed'
  | 'navigate';           // payload: { page: string; id?: string }

export type { ToolCallView };
