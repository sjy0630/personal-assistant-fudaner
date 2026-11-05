import { useEffect, useRef, useState } from 'react';
import type { CardRef, ChatMessage, TodayOverview, ToolCallView } from '../../../shared/types';
import type { Page } from '../App';
import { api, fmtTime } from '../api';
import { RefChip } from '../components/RefChip';

const PHASE: Record<string, string> = { regular: '平时', course_selection: '选课周', midterm: '期中', pre_exam: '考试周前', exam: '考试周', holiday: '假期' };

/** 主对话（PRD §5.1）：一条持续的对话流 + 右侧「今天」边栏 */
export function ChatPage({ quoted, addQuoted, clearQuoted, goto }: { quoted: CardRef[]; addQuoted: (r: CardRef) => void; clearQuoted: (id?: string) => void; goto: (p: Page) => void }) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [thinking, setThinking] = useState(false);
  const [liveTools, setLiveTools] = useState<ToolCallView[]>([]);
  const [today, setToday] = useState<TodayOverview | null>(null);
  const [showToday, setShowToday] = useState(true);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    void api.chat.history(200).then(setMessages);
    void api.today().then(setToday);
    const offs = [
      api.on('chat:message', (m) => {
        setMessages((prev) => (prev.some((x) => x.id === (m as ChatMessage).id) ? prev : [...prev, m as ChatMessage]));
        setLiveTools([]);
        void api.today().then(setToday);
      }),
      api.on('chat:thinking', (on) => setThinking(Boolean(on))),
      api.on('chat:tool', (p) => {
        const call = (p as { call: ToolCallView }).call;
        setLiveTools((prev) => [...prev.filter((c) => !(c.name === call.name && c.ok === undefined)), call]);
      }),
      api.on('goals:changed', () => void api.today().then(setToday)),
    ];
    return () => offs.forEach((off) => off());
  }, []);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, thinking, liveTools]);

  const send = async () => {
    const text = input.trim();
    if (!text) return;
    setInput('');
    await api.chat.send(text, quoted);
    clearQuoted();
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
          <h1>旦旦</h1>
          <button className="ghost" onClick={() => setShowToday((s) => !s)}>{showToday ? '收起今天' : '今天'}</button>
        </header>
        <div className="messages">
          {messages.length === 0 && <div className="empty">还没有消息。和旦旦打个招呼吧，或者在「设置 → 开发者」里打开演示模式。</div>}
          {messages.map((m) => <Message key={m.id} m={m} />)}
          {thinking && (
            <div className="msg assistant">
              {liveTools.map((t, i) => <ToolLine key={i} t={t} />)}
              <div className="bubble typing">正在想…</div>
            </div>
          )}
          <div ref={endRef} />
        </div>
        <div className="composer">
          {quoted.length > 0 && (
            <div className="quoted">
              {quoted.map((r) => <RefChip key={r.id} r={r} onRemove={() => clearQuoted(r.id)} />)}
            </div>
          )}
          <div className="composer-row">
            <textarea
              value={input} placeholder="和旦旦说点什么…（可以把文件拖进来）" rows={2}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void send(); } }}
            />
            <button className="primary" onClick={() => void send()} disabled={!input.trim()}>发送</button>
          </div>
        </div>
      </section>
      {showToday && today && <TodayPanel today={today} goto={goto} />}
    </div>
  );
}

function Message({ m }: { m: ChatMessage }) {
  return (
    <div className={`msg ${m.role}`}>
      <div className="meta">{m.role === 'user' ? '你' : '旦旦'} · {fmtTime(m.createdAt)}{m.proactive && <span className="tag">主动</span>}</div>
      {m.toolCalls.map((t, i) => <ToolLine key={i} t={t} />)}
      {m.refs.length > 0 && <div className="refs">{m.refs.map((r) => <RefChip key={r.id} r={r} />)}</div>}
      <div className="bubble">{m.content}</div>
      {m.cards.length > 0 && <div className="cards">{m.cards.map((c) => <RefChip key={c.id} r={c} card />)}</div>}
      {m.actions.length > 0 && (
        <div className="actions">
          {m.actions.map((a) => <button key={a.label} onClick={() => void api.chat.quickAction(m.id, a.action, a.payload)}>{a.label}</button>)}
        </div>
      )}
    </div>
  );
}

function ToolLine({ t }: { t: ToolCallView }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="tool" onClick={() => setOpen((o) => !o)}>
      🔧 {t.ok === undefined ? '正在调用' : t.ok ? '调用了' : '调用失败'} <code>{t.server}/{t.name}</code>
      {open && <pre>{JSON.stringify(t.args, null, 2)}{t.summary ? `\n→ ${t.summary}` : ''}</pre>}
    </div>
  );
}

function TodayPanel({ today, goto }: { today: TodayOverview; goto: (p: Page) => void }) {
  const pending = today.deadlines.filter((d) => !d.done);
  return (
    <aside className="today">
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
