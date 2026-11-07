import { useEffect, useRef, useState } from 'react';
import type { CardRef, FeedCard } from '../../../shared/types';
import { api, fmtRelative } from '../api';

const FILTERS = [
  { key: '', label: '全部' },
  { key: 'assignment', label: '课程' },
  { key: 'course_mail', label: '课程邮件' },
  { key: 'mail_action', label: '待处理邮件' },
  { key: 'opportunity', label: '活动与机会' },
  { key: 'suggest_ticket', label: '建议' },
];
const TYPE_ICON: Record<string, string> = { assignment: '📝', announcement: '📢', course_mail: '📧', mail_action: '📮', opportunity: '🌏', replay: '🎬', insight: '💡', suggest_ticket: '🤝' };

/** 动态（PRD §5.2）：助理推给你的卡片，每张都说明理由，可以引用到对话 */
export function FeedPage({ quote, focus }: { quote: (r: CardRef) => void; focus?: { id: string } | null }) {
  const [cards, setCards] = useState<FeedCard[]>([]);
  const [filter, setFilter] = useState('');
  const [actionError, setActionError] = useState('');
  const load = () => void api.feed.list({ type: filter || undefined, includeId: focus?.id }).then(setCards);
  useEffect(() => { load(); return api.on('feed:changed', load); }, [filter, focus]);
  const target = useRef<HTMLElement>(null);
  const appliedFocus = useRef<typeof focus>(null);
  useEffect(() => { if (focus) setFilter(''); }, [focus]);
  useEffect(() => {
    if (!focus || focus === appliedFocus.current || !target.current) return;
    appliedFocus.current = focus;
    target.current.focus({ preventScroll: true });
    target.current.scrollIntoView({ block: 'center' });
  }, [focus, cards]);
  const [dismissCard, setDismissCard] = useState<FeedCard | null>(null);
  const [reason, setReason] = useState('这门课不关心');
  const [otherReason, setOtherReason] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const dialogRef = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    if (dismissCard) dialogRef.current?.showModal();
    else dialogRef.current?.close();
  }, [dismissCard]);

  const dismiss = async () => {
    if (!dismissCard || saving) return;
    setSaving(true);
    setError('');
    try {
      const feedback = reason === '其他' ? otherReason.trim() || '其他' : reason;
      await api.feed.dismiss(dismissCard.id, `${feedback}（对应动态：${dismissCard.title}）`);
      setDismissCard(null);
      load();
    } catch {
      setError('未能保存反馈，请稍后重试。');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="page">
      <header className="page-header">
        <h1>动态</h1>
        <div className="filters">{FILTERS.map((f) => <button key={f.key} className={filter === f.key ? 'chip active' : 'chip'} onClick={() => setFilter(f.key)}>{f.label}</button>)}</div>
      </header>
      {actionError && <p role="alert" className="chat-error">{actionError}</p>}
      {cards.length === 0 && <div className="empty">暂时没有新动态。旦旦会替你盯着 eLearning 和邮箱。</div>}
      <div className="feed">
        {cards.map((c) => (
          <article key={c.id} className={focus?.id === c.id ? 'feed-card reference-highlight' : 'feed-card'} ref={focus?.id === c.id ? target : undefined} tabIndex={focus?.id === c.id ? -1 : undefined}>
            <div className="feed-head"><span>{TYPE_ICON[c.type] ?? '•'} {c.title}</span><span className="muted">{fmtRelative(c.createdAt)}</span></div>
            {c.body && <p>{c.body}</p>}
            <div className="reason">💡 {c.reason}</div>
            {c.done && <div className="done">✓ {c.done}</div>}
            <div className="actions">
              <button onClick={() => quote({ type: 'feed', id: c.id, title: c.title })}>引用到对话</button>
              {c.actions.filter((a) => a.action !== 'quote' && a.action !== 'dismiss' && (!['accept_ticket', 'mark_done', 'add_to_plan'].includes(a.action) || c.status !== 'accepted')).map((a) => (
                <button key={a.label} className="primary" onClick={() => { setActionError(''); void api.feed.act(c.id, a.action).then(load).catch(() => { setActionError('暂时无法执行该操作。该建议可能已处理。'); load(); }); }}>{a.label}</button>
              ))}
              <button className="ghost" onClick={() => { setReason('这门课不关心'); setOtherReason(''); setError(''); setDismissCard(c); }}>不感兴趣</button>
            </div>
          </article>
        ))}
      </div>
      <dialog ref={dialogRef} className="feedback-dialog" aria-labelledby="feedback-title" onCancel={(e) => { if (saving) e.preventDefault(); }} onClose={() => setDismissCard(null)}>
        <form onSubmit={(e) => { e.preventDefault(); void dismiss(); }}>
          <h2 id="feedback-title">为什么不感兴趣？</h2>
          <p className="muted">选择原因，帮助旦旦了解你的偏好。</p>
          <p className="feedback-title">{dismissCard?.title}</p>
          <fieldset disabled={saving}>
            <legend>反馈原因</legend>
            {['这门课不关心', '这类通知不想看', '其他'].map((option) => (
              <label className="feedback-option" key={option}>
                <input type="radio" name="dismiss-reason" value={option} checked={reason === option} onChange={() => setReason(option)} />
                {option}
              </label>
            ))}
            {reason === '其他' && <textarea aria-label="补充原因（可选）" placeholder="补充原因（可选）" maxLength={300} rows={3} value={otherReason} onChange={(e) => setOtherReason(e.target.value)} />}
          </fieldset>
          {error && <p className="feedback-error" role="alert">{error}</p>}
          <div className="actions feedback-actions">
            <button type="button" disabled={saving} onClick={() => setDismissCard(null)}>取消</button>
            <button type="submit" className="primary" disabled={saving}>{saving ? '保存中…' : '确认反馈'}</button>
          </div>
        </form>
      </dialog>
    </div>
  );
}
