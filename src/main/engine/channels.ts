import type { ChatMessage, ChatRun, ToolCallView } from '../../shared/types';

/**
 * 主动引擎的写回端口（参考 dsh-superagent 的 Channel）。
 * Electron 中由 ipc + Notification 实现；测试中用内存实现。
 */
export interface Channels {
  /** 新消息写入对话后调用，用于推送到界面 */
  messagePosted(msg: ChatMessage): void;
  /** 弹出系统通知，点击后定位到 messageId */
  notify(title: string, body: string, messageId: string): void;
  changed(what: 'feed' | 'goals' | 'library' | 'platforms'): void;
  /** 对话中的工具调用进度（用于界面展示「🔧 正在查询…」） */
  toolProgress(messageId: string, call: ToolCallView): void;
  thinking(on: boolean): void;
  delta?(run: ChatRun): void;
}

export const nullChannels: Channels = { messagePosted() {}, notify() {}, changed() {}, toolProgress() {}, thinking() {} };
