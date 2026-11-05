import { useEffect, useRef, useState } from 'react';
import type { CardRef, SearchHit } from '../../../shared/types';
import { api } from '../api';

const LABEL: Record<SearchHit['type'], string> = { message: '对话', feed: '动态', goal: '目标', task: '任务', resource: '资源', item: '作业/邮件', memory: '记忆' };
const TO_REF: Partial<Record<SearchHit['type'], CardRef['type']>> = { feed: 'feed', goal: 'goal', task: 'task', resource: 'resource', item: 'item' };

function Highlight({ text, query }: { text: string; query: string }) {
  const terms = query.trim().split(/\s+/).filter(Boolean).sort((a, b) => b.length - a.length);
  if (!terms.length) return <>{text}</>;
  const pattern = terms.map((term) => term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  return <>{text.split(new RegExp('(' + pattern + ')', 'giu')).map((part, i) =>
    i % 2 ? <mark key={i}>{part}</mark> : part,
  )}</>;
}

type SearchResult = { query: string; hits: SearchHit[]; failed: boolean };

export function SearchPage({ quote }: { quote: (r: CardRef) => void }) {
  const [q, setQ] = useState('');
  const [result, setResult] = useState<SearchResult | null>(null);
  const [opened, setOpened] = useState<SearchHit | null>(null);
  const [detail, setDetail] = useState<{ body: string | null; failed: boolean } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const query = q.trim();
  const current = result?.query === query ? result : null;
  const hits = current?.hits ?? [];

  useEffect(() => { inputRef.current?.focus(); }, []);
  useEffect(() => {
    if (!query) return;
    let active = true;
    const timer = setTimeout(async () => {
      try {
        const hits = await api.search(query);
        if (active) setResult({ query, hits, failed: false });
      } catch {
        if (active) setResult({ query, hits: [], failed: true });
      }
    }, 200);
    return () => { active = false; clearTimeout(timer); };
  }, [query]);

  useEffect(() => {
    if (!opened) return;
    const dialog = dialogRef.current;
    if (dialog && !dialog.open) dialog.showModal();
    let active = true;
    const load = async () => {
      try {
        const body = await api.searchDetail(opened.type, opened.id);
        if (active) setDetail({ body, failed: false });
      } catch {
        if (active) setDetail({ body: null, failed: true });
      }
    };
    void load();
    return () => { active = false; };
  }, [opened]);

  function open(hit: SearchHit) {
    setDetail(null);
    setOpened(hit);
  }

  function quoteHit(hit: SearchHit) {
    const type = TO_REF[hit.type];
    if (type) quote({ type, id: hit.id, title: hit.title });
  }

  const groups = new Map<SearchHit['type'], SearchHit[]>();
  for (const hit of hits) {
    const group = groups.get(hit.type);
    if (group) group.push(hit);
    else groups.set(hit.type, [hit]);
  }

  return (
    <div className="page search-page">
      <header className="page-header"><h1>搜索</h1></header>
      <input
        ref={inputRef}
        className="search-input"
        aria-label="搜索关键词"
        placeholder="搜对话、动态、目标、资源、邮件、作业、记忆…"
        value={q}
        onChange={(e) => {
          const value = e.target.value;
          if (value.trim() !== query) setResult(null);
          setQ(value);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.nativeEvent.isComposing && hits[0]) {
            e.preventDefault();
            open(hits[0]);
          }
        }}
      />
      {!query && <p className="muted small">试试「交换」或「Lab 5」。</p>}
      {query && !current && <p className="muted small" role="status">正在搜索…</p>}
      {current?.failed && <p className="empty" role="alert">搜索失败，请重新输入关键词。</p>}
      {current && !current.failed && !hits.length && <div className="empty">没有找到相关结果。</div>}
      {!!hits.length && <p className="muted small" role="status">找到 {hits.length} 条结果 · 回车打开第一条</p>}
      {[...groups].map(([type, list]) => (
        <section key={type}>
          <h3>{LABEL[type]}</h3>
          {list.map((hit) => (
            <div key={hit.id} className="hit">
              <button className="search-hit-open" onClick={() => open(hit)}>
                <strong><Highlight text={hit.title} query={query} /></strong>
                {hit.snippet && <span className="muted"><Highlight text={hit.snippet} query={query} /></span>}
              </button>
              {TO_REF[hit.type] && <button className="ghost" onClick={() => quoteHit(hit)}>引用</button>}
            </div>
          ))}
        </section>
      ))}
      <dialog ref={dialogRef} className="feedback-dialog search-detail" aria-labelledby="search-detail-title" onClose={() => setOpened(null)}>
        {opened && <>
          <span className="muted small">{LABEL[opened.type]}</span>
          <h2 id="search-detail-title"><Highlight text={opened.title} query={query} /></h2>
          {!detail && <p role="status">正在读取详情…</p>}
          {detail?.failed && <p className="feedback-error" role="alert">未能读取详情，以下为搜索摘要。</p>}
          {detail && <div className="search-detail-body">
            <Highlight text={detail.body || opened.snippet || '没有更多内容。'} query={query} />
          </div>}
          <div className="actions feedback-actions">
            <button onClick={() => dialogRef.current?.close()}>关闭</button>
            {TO_REF[opened.type] && <button className="primary" onClick={() => quoteHit(opened)}>引用到对话</button>}
          </div>
        </>}
      </dialog>
    </div>
  );
}
