import { useRef, useState } from 'react';
import type { CardRef, ChatMessage, ToolCallView } from '../../../../shared/types';
import { api, fmtTime } from '../../api';
import { ChatMarkdown } from './ChatMarkdown';
import { ChatReference } from './ChatReference';

const TOOL_LABELS: Record<string, string> = {
  list_deadlines: '查询作业截止时间', list_courses: '读取课程', get_course: '读取课程详情', list_assignments: '查询作业', get_assignment: '读取作业详情', list_announcements: '读取课程公告',
  search_mail: '搜索邮件', get_mail: '读取邮件', list_action_required: '查询待回复邮件', get_today: '查看今天的安排', get_profile: '读取个人设置',
  recall: '查找相关记忆', remember: '保存记忆', forget: '移除记忆', list_goals: '查询目标', create_goal: '创建目标', add_task: '添加任务', update_progress: '更新进度',
  schedule_followup: '安排跟进', start_background_task: '安排后台任务', push_feed_card: '整理动态', save_resource: '保存资源', search_resources: '搜索资源', read_resource: '读取资源', search_all: '搜索相关内容',
};
export function ToolLine({ tool }: { tool: ToolCallView }) {
  return <details className="tool"><summary>{tool.ok === undefined ? '正在执行' : tool.ok ? '已完成' : '未完成'}：{TOOL_LABELS[tool.name] ?? tool.name}</summary><pre>{tool.server}/{tool.name}{'\n'}{JSON.stringify(tool.args, null, 2)}{tool.summary ? `\n→ ${tool.summary}` : ''}</pre></details>;
}

export function MessageView({ message, assistantName, highlighted, open, busy }: {
  message: ChatMessage; assistantName: string; highlighted?: boolean; open: (ref: CardRef) => void; busy: boolean;
}) {
  const [pending, setPending] = useState('');
  const actionLock = useRef(false);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);
  const action = async (key: string, run: () => Promise<unknown>) => {
    if (actionLock.current) return;
    actionLock.current = true;
    setPending(key); setError('');
    try { await run(); }
    catch (cause) {
      const message = cause instanceof Error ? cause.message : '';
      setError(key.startsWith('undo:') && /已.*修改|无法撤销|不能撤销|不存在|更新|工单|本轮|权限/.test(message) ? message.replace(/^Error invoking remote method '[^']+': Error: /, '') : '暂时无法完成，请稍后重试。');
    } finally { actionLock.current = false; setPending(''); }
  };
  const undo = (ref: CardRef) => {
    if (busy || pending) return;
    if (!window.confirm(`撤销「${ref.title}」？这会移除助理创建的这项本地结果；已经修改过的内容会保留。`)) return;
    void action(`undo:${ref.type}:${ref.id}`, () => api.chat.undoResult(message.id, ref.type, ref.id));
  };
  return <article className={`msg ${message.role}${highlighted ? ' msg--target' : ''}`} data-message-id={message.id} tabIndex={highlighted ? -1 : undefined} aria-label={highlighted ? '通知定位的消息' : undefined}>
    <div className="meta">{message.role === 'user' ? '你' : assistantName} · {fmtTime(message.createdAt)}{message.proactive && <span className="tag">主动</span>}</div>
    {message.toolCalls.map((tool, index) => <ToolLine key={tool.id ?? index} tool={tool} />)}
    {!!message.refs.length && <div className="refs">{message.refs.map((ref) => <ChatReference key={`${ref.type}-${ref.id}`} reference={ref} open={open} />)}</div>}
    <div className="bubble">{message.role === 'assistant' ? <ChatMarkdown text={message.content} /> : message.content}</div>
    {!!message.cards.length && <div className="cards">{message.cards.map((ref) => <ChatReference key={`${ref.type}-${ref.id}`} reference={ref} card open={open} undo={ref.undoToken ? () => undo(ref) : undefined} undoDisabled={busy || !!pending} undoPending={pending === `undo:${ref.type}:${ref.id}`} />)}</div>}
    {!!message.actions.length && <div className="actions">{message.actions.map((item, index) => <button type="button" key={`${item.action}-${index}`} disabled={busy || !!pending || item.used} onClick={() => void action(`quick:${index}`, () => api.chat.quickAction(message.id, item.action, item.payload))}>{pending === `quick:${index}` ? '处理中…' : item.used ? `${item.label} · 已处理` : item.label}</button>)}</div>}
    {message.role === 'assistant' && <div className="message-tools"><button type="button" className="ghost" disabled={!!pending} onClick={() => void action('copy', async () => { await api.copyText(message.content); setCopied(true); })}>{copied ? '已复制' : '复制回答'}</button></div>}
    {error && <div className="chat-error" role="alert">{error}</div>}
  </article>;
}
