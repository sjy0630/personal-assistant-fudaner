import { useEffect, useRef, useState } from 'react';
import type { CardRef, SearchHit } from '../../../shared/types';
import { api } from '../api';

const LABEL: Record<SearchHit['type'], string> = { message: '对话', feed: '动态', goal: '目标', task: '任务', resource: '资源', item: '作业/邮件', memory: '记忆' };
const TO_REF: Partial<Record<SearchHit['type'], CardRef['type']>> = { feed: 'feed', goal: 'goal', task: 'task', resource: 'resource', item: 'item' };

/** 搜索（PRD §5.5）：一个框搜所有东西（Ctrl+K） */
export function SearchPage({ quote }: { quote: (r: CardRef) => void }) {
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<SearchHit[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => inputRef.current?.focus(), []);
  useEffect(() => {
    const t = setTimeout(() => void (q.trim() ? api.search(q).then(setHits) : setHits([])), 200);
    return () => clearTimeout(t);
  }, [q]);

  const groups = Object.entries(hits.reduce<Record<string, SearchHit[]>>((acc, h) => ({ ...acc, [h.type]: [...(acc[h.type] ?? []), h] }), {}));
  return (
    <div className="page">
      <header className="page-header"><h1>搜索</h1></header>
      <input ref={inputRef} className="search-input" placeholder="搜对话、动态、目标、资源、邮件、作业、记忆…" value={q} onChange={(e) => setQ(e.target.value)} />
      {q && hits.length === 0 && <div className="empty">没有找到</div>}
      {groups.map(([type, list]) => (
        <section key={type}>
          <h3>{LABEL[type as SearchHit['type']]}</h3>
          {list.map((h) => (
            <div key={h.id} className="hit">
              <div><strong>{h.title}</strong><div className="muted">{h.snippet}</div></div>
              {TO_REF[h.type] && <button className="ghost" onClick={() => quote({ type: TO_REF[h.type]!, id: h.id, title: h.title })}>引用</button>}
            </div>
          ))}
        </section>
      ))}
    </div>
  );
}
