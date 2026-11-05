import { useEffect, useState } from 'react';
import type { CardRef } from '../../shared/types';
import { api } from './api';
import { ChatPage } from './pages/Chat';
import { FeedPage } from './pages/Feed';
import { GoalsPage } from './pages/Goals';
import { LibraryPage } from './pages/Library';
import { SearchPage } from './pages/Search';
import { SettingsPage } from './pages/Settings';
import { NavIcon } from './components/NavIcon';

export type Page = 'chat' | 'feed' | 'goals' | 'library' | 'search' | 'settings';

const NAV: { page: Page; label: string }[] = [
  { page: 'chat', label: '对话' },
  { page: 'feed', label: '动态' },
  { page: 'goals', label: '目标' },
  { page: 'library', label: '资源' },
  { page: 'search', label: '搜索' },
];
const logo = new URL('../../../resources/icon.png', import.meta.url).href;

/**
 * 信息架构（PRD §5.0）：一个主对话 + 四个副页面。
 * 任何页面都可以调用 quote() 把对象「引用到对话」。
 */
export function App() {
  const [page, setPage] = useState<Page>('chat');
  const [quoted, setQuoted] = useState<CardRef[]>([]);

  const addQuoted = (ref: CardRef) => setQuoted((q) => (q.some((r) => r.id === ref.id) ? q : [...q, ref]));
  const quote = (ref: CardRef) => {
    addQuoted(ref);
    setPage('chat');
  };

  useEffect(() => {
    const offNav = api.on('navigate', (p) => setPage(((p as { page: Page }).page) ?? 'chat'));
    const onKey = (e: KeyboardEvent) => { if ((e.ctrlKey || e.metaKey) && e.key === 'k') { e.preventDefault(); setPage('search'); } };
    window.addEventListener('keydown', onKey);
    return () => { offNav(); window.removeEventListener('keydown', onKey); };
  }, []);

  return (
    <div className="app">
      <nav className="nav" aria-label="主导航">
        <div className="nav-brand"><img src={logo} alt="Fudaner" width="32" height="32" /></div>
        {NAV.map((n) => (
          <button key={n.page} className={page === n.page ? 'nav-item active' : 'nav-item'} aria-current={page === n.page ? 'page' : undefined} onClick={() => setPage(n.page)} title={n.label}>
            <NavIcon name={n.page} />
            <span className="nav-label">{n.label}</span>
          </button>
        ))}
        <div className="nav-spacer" />
        <button className={page === 'settings' ? 'nav-item active' : 'nav-item'} aria-current={page === 'settings' ? 'page' : undefined} onClick={() => setPage('settings')} title="设置">
          <NavIcon name="settings" />
          <span className="nav-label">设置</span>
        </button>
      </nav>
      <main className="main">
        {page === 'chat' && <ChatPage quoted={quoted} addQuoted={addQuoted} clearQuoted={(id) => setQuoted((q) => (id ? q.filter((r) => r.id !== id) : []))} goto={setPage} />}
        {page === 'feed' && <FeedPage quote={quote} />}
        {page === 'goals' && <GoalsPage quote={quote} />}
        {page === 'library' && <LibraryPage quote={quote} />}
        {page === 'search' && <SearchPage quote={quote} />}
        {page === 'settings' && <SettingsPage />}
      </main>
    </div>
  );
}
