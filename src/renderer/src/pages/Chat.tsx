import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { DragEvent } from 'react';
import type { CardRef, TodayOverview } from '../../../shared/types';
import type { Page } from '../App';
import { api, fmtTime } from '../api';
import { NavIcon } from '../theme/NavIcon';
import { ChatComposer } from './chat/ChatComposer';
import { ChatMarkdown } from './chat/ChatMarkdown';
import { MessageView, ToolLine } from './chat/MessageView';
import { useChatHistory } from './chat/useChatHistory';
import { useChatRun } from './chat/useChatRun';
import type { ChatWorkspace } from './chat/useChatWorkspace';
import './chat/chat.css';

const PHASE: Record<string, string> = { regular: '平时', course_selection: '开学初', midterm: '期中', pre_exam: '考试周前', exam: '考试周', holiday: '假期' };
const STARTERS = ['这周有哪些作业要交？', '今天有哪些邮件需要回？', '帮我看看本周目标的进度。'];

interface ChatPageProps {
  assistantName: string;
  location: { id: string } | null;
  returnToLatest: () => void;
  todayCollapsed: boolean;
  toggleToday: () => void;
  workspace: ChatWorkspace;
  openReference: (ref: CardRef) => void;
  goto: (page: Page) => void;
}

/** 一条持续的对话流与独立的今天侧栏。 */
export function ChatPage({ assistantName, location, returnToLatest, todayCollapsed, toggleToday, workspace, openReference, goto }: ChatPageProps) {
  const messagesRef = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  const previousScrollTop = useRef(0);
  const [following, setFollowing] = useState(true);
  const [unread, setUnread] = useState(0);
  const [today, setToday] = useState<TodayOverview | null>(null);
  const [sendError, setSendError] = useState('');
  const [sending, setSending] = useState(false);
  const sendLock = useRef(false);
  const [stopping, setStopping] = useState(false);
  const [dragging, setDragging] = useState(false);
  const dragDepth = useRef(0);
  const focusedLocation = useRef<typeof location>(null);
  const anchor = useRef<{ node: HTMLElement; top: number } | null>(null);
  const { run, runError } = useChatRun();
  const history = useChatHistory(location, (message) => {
    if ((location || !follow.current) && message.role === 'assistant') setUnread((count) => count + 1);
  });
  const { messages, loading, error, hasMore } = history;
  const busy = !!run || sending;

  useEffect(() => {
    let active = true;
    const refresh = () => void api.today().then((value) => { if (active) setToday(value); }).catch(() => undefined);
    refresh();
    const offGoals = api.on('goals:changed', refresh);
    const offChat = api.on('chat:message', refresh);
    return () => { active = false; offGoals(); offChat(); };
  }, []);

  useLayoutEffect(() => {
    focusedLocation.current = null;
    follow.current = !location;
    setFollowing(!location);
    setUnread(0);
  }, [location]);

  useLayoutEffect(() => {
    const scroller = messagesRef.current;
    if (!scroller || loading || history.loadingRef.current) return;
    if (location) {
      if (focusedLocation.current === location) return;
      const target = Array.from(scroller.querySelectorAll<HTMLElement>('[data-message-id]')).find((node) => node.dataset.messageId === location.id);
      if (target) {
        focusedLocation.current = location;
        target.focus({ preventScroll: true });
        target.scrollIntoView({ block: 'center' });
      }
    } else if (follow.current) {
      scroller.scrollTop = scroller.scrollHeight;
      previousScrollTop.current = scroller.scrollTop;
    }
  }, [messages, run, location, loading]);

  useLayoutEffect(() => {
    const scroller = messagesRef.current;
    const saved = anchor.current;
    anchor.current = null;
    if (scroller && saved?.node.isConnected) {
      scroller.scrollTop += saved.node.getBoundingClientRect().top - saved.top;
      previousScrollTop.current = scroller.scrollTop;
    }
  }, [history.olderRevision]);

  useEffect(() => { setStopping(false); }, [run?.id]);

  const latest = () => {
    follow.current = true; setFollowing(true); setUnread(0);
    if (location) returnToLatest();
    else if (messagesRef.current) {
      messagesRef.current.scrollTop = messagesRef.current.scrollHeight;
      previousScrollTop.current = messagesRef.current.scrollTop;
    }
  };
  const loadOlder = async () => {
    if (history.loadingOlder) return;
    const scroller = messagesRef.current;
    if (!scroller) return;
    const top = scroller.getBoundingClientRect().top;
    const node = Array.from(scroller.querySelectorAll<HTMLElement>('[data-message-id]')).find((row) => row.getBoundingClientRect().bottom > top);
    follow.current = false; setFollowing(false);
    anchor.current = node ? { node, top: node.getBoundingClientRect().top } : null;
    if (!await history.loadOlder()) anchor.current = null;
  };
  const send = async () => {
    const sent = workspace.draft;
    if ((!sent.text.trim() && !sent.refs.length) || busy || workspace.blocked || sendLock.current) return;
    sendLock.current = true;
    workspace.clearDraft(); setSending(true); setSendError(''); latest();
    try { await api.chat.send(sent.text.trim() || '请帮我看看这些引用。', sent.refs); }
    catch { workspace.restoreDraft(sent, workspace.resetVersion); setSendError('消息未发送，请等待当前回复结束后重试，或检查连接。'); }
    finally { sendLock.current = false; setSending(false); }
  };
  const stop = async () => {
    if (!run || stopping) return;
    setStopping(true);
    try { await api.chat.cancel(run.id); }
    catch { setStopping(false); setSendError('暂时无法停止，请重试。'); }
  };
  const suggest = (text: string) => { workspace.setText((current) => current.trim() ? current : text); workspace.focusComposer(); };
  const isFiles = (event: DragEvent) => event.dataTransfer.types.includes('Files');
  const onDrop = (event: DragEvent) => {
    if (!isFiles(event)) return;
    event.preventDefault(); dragDepth.current = 0; setDragging(false);
    void workspace.uploadFiles(Array.from(event.dataTransfer.files));
    workspace.focusComposer();
  };

  return <div className="chat-layout">
    <section className="chat"
      onDragEnter={(event) => { if (isFiles(event)) { event.preventDefault(); dragDepth.current++; setDragging(true); } }}
      onDragOver={(event) => { if (isFiles(event)) event.preventDefault(); }}
      onDragLeave={() => { dragDepth.current = Math.max(0, dragDepth.current - 1); if (!dragDepth.current) setDragging(false); }}
      onDrop={onDrop}>
      <header className="page-header">
        <h1>{assistantName}</h1>
        <button className="ghost sidebar-toggle today-toggle" type="button" onClick={toggleToday} aria-label={todayCollapsed ? '展开右侧栏' : '收起右侧栏'} aria-expanded={!todayCollapsed} aria-controls="today-sidebar" title={todayCollapsed ? '展开右侧栏' : '收起右侧栏'}>
          <NavIcon name={todayCollapsed ? 'expand-right' : 'collapse-right'} />
        </button>
      </header>
      {dragging && <div className="chat-drop-hint" role="status">松开鼠标，导入并引用附件</div>}
      {location && <div className="notification-location">
        <span role="status">{loading ? '正在定位通知消息…' : error ? '暂时无法读取通知消息，请重试。' : messages.some((m) => m.id === location.id) ? '已定位到通知消息' : '这条通知对应的消息已不存在，可能已被清理。'}</span>
        {error && <button type="button" onClick={history.reload}>重试</button>}
        <button type="button" className="ghost" onClick={latest}>返回最新消息</button>
      </div>}
      <div className="chat-message-area">
        <div className="messages" ref={messagesRef} aria-busy={loading} onScroll={(event) => {
          const element = event.currentTarget;
          const next = element.scrollTop;
          if (!location && !loading && !history.loadingRef.current) {
            if (next < previousScrollTop.current) follow.current = false;
            else if (element.scrollHeight - next - element.clientHeight < 64) follow.current = true;
            setFollowing(follow.current);
            if (follow.current) setUnread(0);
          }
          previousScrollTop.current = next;
        }}>
          {!location && loading && <div className="history-control muted" role="status">正在读取对话…</div>}
          {!location && error && <div className="history-control" role="alert">暂时无法读取对话。<button type="button" onClick={history.reload}>重试</button></div>}
          {!loading && hasMore && !location && !error && <div className="history-control">
            <button type="button" onClick={() => void loadOlder()} disabled={history.loadingOlder}>{history.loadingOlder ? '正在加载…' : '加载更早消息'}</button>
            {history.olderError && <span className="chat-error" role="alert">无法加载更早的消息，请重试。</span>}
          </div>}
          {!location && !loading && !error && !messages.length && !run && <div className="chat-welcome">
            <h2>今天想聊些什么？</h2>
            <p className="muted">也可以引用课程内容，或添加一份文件。</p>
            <div>{STARTERS.map((text) => <button key={text} type="button" onClick={() => suggest(text)}>{text}</button>)}</div>
          </div>}
          {messages.map((message) => <MessageView key={message.id} message={message} assistantName={assistantName} highlighted={location?.id === message.id} open={openReference} busy={busy} />)}
          {run && !location && !messages.some((message) => message.id === run.id) &&
            <article className="msg assistant streaming" data-run-id={run.id} aria-busy="true">
              <div className="meta">{assistantName} · {fmtTime(run.startedAt)}</div>
              {run.toolCalls.map((tool, index) => <ToolLine key={tool.id ?? index} tool={tool} />)}
              {run.content && <div className="bubble"><ChatMarkdown text={run.content} /></div>}
              <span className="generation-status" role="status">{stopping ? '正在停止…' : run.toolCalls.some((tool) => tool.ok === undefined) ? '正在查询…' : run.content ? '正在生成…' : '正在等待模型回复…'}</span>
            </article>}
        </div>
        {!location && !loading && !following && <button className="jump-latest" type="button" onClick={latest}>{unread ? `回到最新 · ${unread} 条新消息` : '回到最新'}</button>}
      </div>
      <ChatComposer workspace={workspace} assistantName={assistantName} busy={busy} running={!!run} stopping={stopping} error={sendError || runError} send={() => void send()} stop={() => void stop()} open={openReference} />
    </section>
    {today && <TodayPanel today={today} goto={goto} collapsed={todayCollapsed} open={openReference} suggest={suggest} />}
  </div>;
}
function TodayPanel({ today, goto, collapsed, open, suggest }: { today: TodayOverview; goto: (p: Page) => void; collapsed: boolean; open: (ref: CardRef) => void; suggest: (text: string) => void }) {
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
      {today.exams && today.exams.length > 0 && (
        <section>
          <h3>考试</h3>
          {today.exams.slice(0, 4).map((e) => {
            const days = Math.ceil((Date.parse(e.startsAt) - Date.now()) / 86_400_000);
            return <button type="button" key={e.itemId} className="ghost row today-deadline" onClick={() => open({ type: 'item', id: e.itemId, title: e.course })}><span>{days <= 1 ? '🔴' : days <= 7 ? '🟡' : '⚪'}</span> {e.course} <span className="muted">{fmtTime(e.startsAt)}{e.location ? ` · ${e.location}` : ''}</span></button>;
          })}
        </section>
      )}
      <section>
        <h3>DDL</h3>
        {pending.length === 0 && <div className="muted">7 天内没有未交作业</div>}
        {pending.slice(0, 6).map((d) => {
          const hours = (Date.parse(d.dueAt) - Date.now()) / 3_600_000;
          return <button type="button" key={d.itemId} className="ghost row today-deadline" onClick={() => open({ type: 'item', id: d.itemId, title: d.title })}><span>{hours < 24 ? '🔴' : hours < 72 ? '🟡' : '⚪'}</span> {d.title} <span className="muted">{fmtTime(d.dueAt)}</span></button>;
        })}
      </section>
      <section>
        <h3>本周目标</h3>
        <div className="progress"><div style={{ width: `${today.weekProgress.total ? (today.weekProgress.done / today.weekProgress.total) * 100 : 0}%` }} /></div>
        <div className="muted">{today.weekProgress.done}/{today.weekProgress.total} 完成 · <button className="ghost text-button" type="button" onClick={() => goto('goals')}>查看</button></div>
      </section>
      {today.mailToReply > 0 && <section><h3>待回复邮件</h3><div className="row">{today.mailToReply} 封 · <button type="button" className="ghost text-button" onClick={() => suggest(STARTERS[1])}>问问助理</button></div></section>}
    </aside>
  );
}
