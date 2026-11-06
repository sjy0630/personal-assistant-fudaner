import { useEffect, useRef, useState } from 'react';
import type { CardRef, ChatMessage, TodayOverview, ToolCallView } from '../../../shared/types';
import type { Page } from '../App';
import { api, fmtTime } from '../api';
import { RefChip } from '../components/RefChip';
import { NavIcon } from '../theme/NavIcon';
import { ChatMarkdown } from './chat/ChatMarkdown';
import { useChatRun } from './chat/useChatRun';
import './chat/chat.css';

const PHASE: Record<string, string> = { regular: '平时', course_selection: '选课周', midterm: '期中', pre_exam: '考试周前', exam: '考试周', holiday: '假期' };
const TOOL_LABELS: Record<string, string> = {
  list_deadlines: '查询作业截止时间', list_courses: '读取课程', list_assignments: '查询作业', get_assignment: '读取作业详情',
  list_announcements: '读取课程公告', search_mail: '搜索邮件', get_mail: '读取邮件', list_action_required: '查询待回复邮件',
  get_today: '查看今天的安排', get_profile: '读取个人设置', recall: '查找相关记忆', remember: '保存记忆', forget: '移除记忆',
  list_goals: '查询目标', create_goal: '创建目标', add_task: '添加任务', update_progress: '更新进度', schedule_followup: '安排跟进',
  start_background_task: '安排后台任务', push_feed_card: '整理动态', save_resource: '保存资源', search_resources: '搜索资源', read_resource: '读取资源', search_all: '搜索相关内容',
};

/** 主对话（PRD §5.1）：一条持续的对话流 + 右侧「今天」边栏 */
export function ChatPage({ assistantName = '旦旦', location, returnToLatest, todayCollapsed, toggleToday, quoted, addQuoted, clearQuoted, goto }: { assistantName?: string; location: { id: string } | null; returnToLatest: () => void; todayCollapsed: boolean; toggleToday: () => void; quoted: CardRef[]; addQuoted: (r: CardRef) => void; clearQuoted: (id?: string) => void; goto: (p: Page) => void }) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const { run, runError } = useChatRun();
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState('');
  const [stopRequested, setStopRequested] = useState(false);
  const busy = !!run || sending;
  const followBottom = useRef(true);
  const previousScrollTop = useRef(0);
  const [today, setToday] = useState<TodayOverview | null>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const messagesRef = useRef<HTMLDivElement>(null);
  const focusedLocation = useRef<typeof location>(null);
  const loadingHistory = useRef(true);
  const duringLoad = useRef<ChatMessage[]>([]);
  const [historyLoading, setHistoryLoading] = useState(true);
  const [historyError, setHistoryError] = useState(false);
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    let active = true;
    loadingHistory.current = true;
    duringLoad.current = [];
    focusedLocation.current = null;
    setHistoryLoading(true); setHistoryError(false); setMessages([]);
    if (!location) followBottom.current = true;
    void api.chat.history(200, location?.id).then((history) => {
      if (!active) return;
      const merged = new Map(history.map((m) => [m.id, m]));
      for (const m of duringLoad.current) if (!location || merged.has(m.id)) merged.set(m.id, m);
      setMessages([...merged.values()]);
    }).catch(() => { if (active) setHistoryError(true); }).finally(() => {
      if (active) { loadingHistory.current = false; setHistoryLoading(false); }
    });
    return () => { active = false; };
  }, [location, retry]);

  useEffect(() => {
    void api.today().then(setToday);
    const offs = [
      api.on('chat:message', (m) => {
        const message = m as ChatMessage;
        if (loadingHistory.current) duringLoad.current.push(message);
        else setMessages((prev) => {
          const exists = prev.some((x) => x.id === message.id);
          // 查看历史通知时保留上下文；新回复仍可通过“返回最新消息”查看。
          return exists ? prev.map((x) => x.id === message.id ? message : x) : location ? prev : [...prev, message];
        });
        void api.today().then(setToday);
      }),
      api.on('goals:changed', () => void api.today().then(setToday)),
    ];
    return () => offs.forEach((off) => off());
  }, [location]);

  useEffect(() => {
    if (!location && !historyLoading && followBottom.current) endRef.current?.scrollIntoView({ behavior: 'auto', block: 'end' });
  }, [messages, run, location, historyLoading]);
  useEffect(() => { setStopRequested(false); }, [run?.id]);
  useEffect(() => {
    if (!location || historyLoading || loadingHistory.current || focusedLocation.current === location) return;
    const target = Array.from(messagesRef.current?.querySelectorAll<HTMLElement>('[data-message-id]') ?? []).find((el) => el.dataset.messageId === location.id);
    if (!target) return;
    focusedLocation.current = location;
    target.focus({ preventScroll: true });
    target.scrollIntoView({ block: 'center', behavior: 'auto' });
  }, [messages, location, historyLoading]);

  const send = async () => {
    const text = input.trim();
    if (!text || busy) return;
    if (location) returnToLatest();
    const refs = [...quoted];
    setInput(''); setSending(true); setSendError(''); clearQuoted(); followBottom.current = true;
    try { await api.chat.send(text, refs); }
    catch { setSendError('消息未发送，请等待当前回复结束后重试，或检查连接。'); setInput((current) => current || text); refs.forEach(addQuoted); }
    finally { setSending(false); }
  };
  const stop = async () => {
    if (!run || stopRequested) return;
    setStopRequested(true);
    try { await api.chat.cancel(run.id); }
    catch { setStopRequested(false); setSendError('暂时无法停止，请重试。'); }
  };

  const onDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    for (const f of Array.from(e.dataTransfer.files)) {
      const res = await api.library.upload(window.fudaner.pathForFile(f));
      setInput((t) => t || `帮我看看「${res.title}」`);
      // 上传后自动存入资源库，并引用到对话
      addQuoted({ type: 'resource', id: res.id, title: res.title, subtitle: '刚上传' });
    }
  };

  return (
    <div className="chat-layout">
      <section className="chat" onDragOver={(e) => e.preventDefault()} onDrop={onDrop}>
        <header className="page-header">
          <h1>{assistantName}</h1>
          <button className="ghost sidebar-toggle today-toggle" type="button" onClick={toggleToday} aria-label={todayCollapsed ? '展开右侧栏' : '收起右侧栏'} aria-expanded={!todayCollapsed} aria-controls="today-sidebar" title={todayCollapsed ? '展开右侧栏' : '收起右侧栏'}>
            <NavIcon name={todayCollapsed ? 'expand-right' : 'collapse-right'} />
          </button>
        </header>
        {location && <div className="notification-location">
          <span role="status">{historyLoading ? '正在定位通知消息…' : historyError ? '暂时无法读取通知消息，请重试。' : messages.some((m) => m.id === location.id) ? '已定位到通知消息' : '这条通知对应的消息已不存在，可能已被清理。'}</span>
          {historyError && <button type="button" onClick={() => setRetry((n) => n + 1)}>重试</button>}
          <button type="button" className="ghost" onClick={returnToLatest}>返回最新消息</button>
        </div>}
        <div className="messages" ref={messagesRef} aria-busy={historyLoading} onScroll={(event) => {
          const el = event.currentTarget;
          if (!historyLoading && !loadingHistory.current) {
            if (el.scrollTop < previousScrollTop.current) followBottom.current = false;
            else if (el.scrollHeight - el.scrollTop - el.clientHeight < 64) followBottom.current = true;
          }
          previousScrollTop.current = el.scrollTop;
        }}>
          {!location && historyError && <div role="alert">暂时无法读取对话。<button type="button" onClick={() => setRetry((n) => n + 1)}>重试</button></div>}
          {!location && !historyLoading && !historyError && messages.length === 0 && <div className="empty">和{assistantName}打个招呼吧。可以问「这周有什么 DDL？」或「有哪些邮件要回？」。</div>}
          {messages.map((m) => <Message key={m.id} m={m} assistantName={assistantName} highlighted={location?.id === m.id} />)}
          {run && !location && !messages.some((m) => m.id === run.id) && (
            <div className="msg assistant streaming" data-run-id={run.id} aria-busy="true">
              <div className="meta">{assistantName} · {fmtTime(run.startedAt)}</div>
              {run.toolCalls.map((t, i) => <ToolLine key={t.id ?? i} t={t} />)}
              {run.content && <div className="bubble"><ChatMarkdown text={run.content} /></div>}
              <span className="generation-status" role="status">{stopRequested ? '正在停止…' : run.toolCalls.some((t) => t.ok === undefined) ? '正在查询…' : run.content ? '正在生成…' : '正在等待模型回复…'}</span>
            </div>
          )}
          <div ref={endRef} />
        </div>
        <div className="composer">
          {(sendError || runError) && <div className="chat-error" role="alert">{sendError || runError}</div>}
          {quoted.length > 0 && (
            <div className="quoted">
              {quoted.map((r) => <RefChip key={r.id} r={r} onRemove={() => clearQuoted(r.id)} />)}
            </div>
          )}
          <div className="composer-row">
            <textarea
              value={input} placeholder={`和${assistantName}说点什么…（可以把文件拖进来）`} rows={2}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void send(); } }}
            />
            {run ? <button type="button" onClick={() => void stop()} disabled={stopRequested}>{stopRequested ? '正在停止…' : '停止生成'}</button> : <button className="primary" onClick={() => void send()} disabled={!input.trim() || busy}>发送</button>}
          </div>
        </div>
      </section>
      {today && <TodayPanel today={today} goto={goto} collapsed={todayCollapsed} />}
    </div>
  );
}

function Message({ m, assistantName, highlighted }: { m: ChatMessage; assistantName: string; highlighted?: boolean }) {
  return (
    <div className={`msg ${m.role}${highlighted ? ' msg--target' : ''}`} data-message-id={m.id} tabIndex={highlighted ? -1 : undefined} aria-label={highlighted ? '通知定位的消息' : undefined}>
      <div className="meta">{m.role === 'user' ? '你' : assistantName} · {fmtTime(m.createdAt)}{m.proactive && <span className="tag">主动</span>}</div>
      {m.toolCalls.map((t, i) => <ToolLine key={t.id ?? i} t={t} />)}
      {m.refs.length > 0 && <div className="refs">{m.refs.map((r) => <RefChip key={r.id} r={r} />)}</div>}
      <div className="bubble">{m.role === 'assistant' ? <ChatMarkdown text={m.content} /> : m.content}</div>
      {m.cards.length > 0 && <div className="cards">{m.cards.map((c) => <RefChip key={c.id} r={c} card />)}</div>}
      {m.actions.length > 0 && (
        <div className="actions">
          {m.actions.map((a) => <button key={a.label} onClick={() => void api.chat.quickAction(m.id, a.action, a.payload).catch(() => window.alert('暂时无法执行，请等待当前回复结束后重试。'))}>{a.label}</button>)}
        </div>
      )}
    </div>
  );
}

function ToolLine({ t }: { t: ToolCallView }) {
  return (
    <details className="tool">
      <summary>{t.ok === undefined ? '正在执行' : t.ok ? '已完成' : '未完成'}：{TOOL_LABELS[t.name] ?? t.name}</summary>
      <pre>{t.server}/{t.name}{'\n'}{JSON.stringify(t.args, null, 2)}{t.summary ? `\n→ ${t.summary}` : ''}</pre>
    </details>
  );
}

function TodayPanel({ today, goto, collapsed }: { today: TodayOverview; goto: (p: Page) => void; collapsed: boolean }) {
  const pending = today.deadlines.filter((d) => !d.done);
  return (
    <aside className="today" id="today-sidebar" aria-label="今天概况" hidden={collapsed}>
      <h2>今天</h2>
      <div className="muted">{today.date}{today.weekNo ? ` · 第 ${today.weekNo} 周` : ''} · {PHASE[today.phase]}</div>
      {today.courses.length > 0 && (
        <section>
          <h3>课程</h3>
          {today.courses.map((c) => <div key={c.name} className="row">{c.time} {c.name} <span className="muted">{c.location}</span></div>)}
        </section>
      )}
      <section>
        <h3>DDL</h3>
        {pending.length === 0 && <div className="muted">7 天内没有未交作业</div>}
        {pending.slice(0, 6).map((d) => {
          const hours = (Date.parse(d.dueAt) - Date.now()) / 3_600_000;
          return <div key={d.itemId} className="row"><span>{hours < 24 ? '🔴' : hours < 72 ? '🟡' : '⚪'}</span> {d.title} <span className="muted">{fmtTime(d.dueAt)}</span></div>;
        })}
      </section>
      <section>
        <h3>本周目标</h3>
        <div className="progress"><div style={{ width: `${today.weekProgress.total ? (today.weekProgress.done / today.weekProgress.total) * 100 : 0}%` }} /></div>
        <div className="muted">{today.weekProgress.done}/{today.weekProgress.total} 完成 · <a onClick={() => goto('goals')}>查看</a></div>
      </section>
      {today.mailToReply > 0 && <section><h3>待回复邮件</h3><div className="row">{today.mailToReply} 封</div></section>}
    </aside>
  );
}
