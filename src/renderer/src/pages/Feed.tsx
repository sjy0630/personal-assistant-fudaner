import { useEffect, useState } from 'react';
import type { CardRef, FeedCard } from '../../../shared/types';
import { api, fmtRelative } from '../api';

const FILTERS = [
  { key: '', label: '全部' },
  { key: 'assignment', label: '课程' },
  { key: 'course_mail', label: '课程邮件' },
  { key: 'mail_action', label: '待处理邮件' },
  { key: 'opportunity', label: '机会' },
  { key: 'suggest_ticket', label: '建议' },
];
const TYPE_ICON: Record<string, string> = { assignment: '📝', announcement: '📢', course_mail: '📧', mail_action: '📮', opportunity: '🌏', replay: '🎬', insight: '💡', suggest_ticket: '🤝' };

/** 动态（PRD §5.2）：助理推给你的卡片，每张都说明理由，可以引用到对话 */
export function FeedPage({ quote }: { quote: (r: CardRef) => void }) {
  const [cards, setCards] = useState<FeedCard[]>([]);
  const [filter, setFilter] = useState('');
  const load = () => void api.feed.list(filter ? { type: filter } : undefined).then(setCards);
  useEffect(() => { load(); return api.on('feed:changed', load); }, [filter]);

  const dismiss = async (c: FeedCard) => {
    const reason = window.prompt('为什么不感兴趣？（可选，比如「不关心体育类通知」）') ?? undefined;
    await api.feed.dismiss(c.id, reason || undefined);
    load();
  };

  return (
    <div className="page">
      <header className="page-header">
        <h1>动态</h1>
        <div className="filters">{FILTERS.map((f) => <button key={f.key} className={filter === f.key ? 'chip active' : 'chip'} onClick={() => setFilter(f.key)}>{f.label}</button>)}</div>
      </header>
      {cards.length === 0 && <div className="empty">暂时没有新动态。旦旦会替你盯着 eLearning 和邮箱。</div>}
      <div className="feed">
        {cards.map((c) => (
          <article key={c.id} className="feed-card">
            <div className="feed-head"><span>{TYPE_ICON[c.type] ?? '•'} {c.title}</span><span className="muted">{fmtRelative(c.createdAt)}</span></div>
            {c.body && <p>{c.body}</p>}
            <div className="reason">💡 {c.reason}</div>
            {c.done && <div className="done">✓ {c.done}</div>}
            <div className="actions">
              <button onClick={() => quote({ type: 'feed', id: c.id, title: c.title })}>引用到对话</button>
              {c.actions.filter((a) => a.action !== 'quote' && a.action !== 'dismiss').map((a) => (
                <button key={a.label} className="primary" onClick={() => void api.feed.act(c.id, a.action).then(load)}>{a.label}</button>
              ))}
              <button className="ghost" onClick={() => void dismiss(c)}>不感兴趣</button>
            </div>
          </article>
        ))}
      </div>
    </div>
  );
}
