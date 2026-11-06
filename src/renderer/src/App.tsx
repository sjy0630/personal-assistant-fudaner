import { useCallback, useEffect, useState } from 'react';
import type { CardRef } from '../../shared/types';
import { api } from './api';
import { ChatPage } from './pages/Chat';
import { FeedPage } from './pages/Feed';
import { GoalsPage } from './pages/Goals';
import { LibraryPage } from './pages/Library';
import { SearchPage } from './pages/Search';
import { SettingsPage } from './pages/Settings';
import { OnboardingPage } from './pages/Onboarding';
import { NavIcon } from './theme/NavIcon';
import { useSidebarLayout } from './theme/useSidebarLayout';

export type Page = 'chat' | 'feed' | 'goals' | 'library' | 'search' | 'settings';

const NAV: { page: Page; icon: string; label: string }[] = [
  { page: 'chat', icon: '💬', label: '对话' },
  { page: 'feed', icon: '📰', label: '动态' },
  { page: 'goals', icon: '🎯', label: '目标' },
  { page: 'library', icon: '📚', label: '资源' },
  { page: 'search', icon: '🔍', label: '搜索' },
];

/**
 * 信息架构（PRD §5.0）：一个主对话 + 四个副页面。
 * 任何页面都可以调用 quote() 把对象「引用到对话」。
 */
export function App() {
  const { layout, toggle } = useSidebarLayout();
  const [page, setPage] = useState<Page>('chat');
  const [quoted, setQuoted] = useState<CardRef[]>([]);
  const [ready, setReady] = useState(false);
  const [bootError, setBootError] = useState(false);
  const [onboarding, setOnboarding] = useState(false);
  const [completed, setCompleted] = useState(false);
  const [assistantName, setAssistantName] = useState('旦旦');
  const [settingsDirty, setSettingsDirty] = useState(false);
  const [settingsBusy, setSettingsBusy] = useState(false);
  const navigate = useCallback((next: Page) => {
    if (next === page) return;
    if (page === 'settings' && (settingsBusy || (settingsDirty && !window.confirm('设置中有尚未保存的修改，离开后这些修改将丢失。确认离开？')))) return;
    setSettingsDirty(false); setSettingsBusy(false); setPage(next);
  }, [page, settingsDirty, settingsBusy]);
  const load = async () => {
    setBootError(false);
    try {
      const [settings, profile] = await Promise.all([api.settings.get(), api.profile.get()]);
      setCompleted(!!settings.onboardingCompleted);
      setOnboarding(!settings.onboardingCompleted);
      setAssistantName(profile.assistantName);
      setReady(true);
    } catch { setBootError(true); }
  };
  useEffect(() => { void load(); }, []);
  useEffect(() => {
    if (ready && !onboarding && page === 'chat') void api.profile.get().then((p) => setAssistantName(p.assistantName)).catch(() => undefined);
  }, [ready, onboarding, page]);

  const addQuoted = (ref: CardRef) => setQuoted((q) => (q.some((r) => r.id === ref.id) ? q : [...q, ref]));
  const quote = (ref: CardRef) => {
    addQuoted(ref);
    navigate('chat');
  };

  useEffect(() => {
    const offNav = api.on('navigate', (p) => navigate(((p as { page: Page }).page) ?? 'chat'));
    const onKey = (e: KeyboardEvent) => { if ((e.ctrlKey || e.metaKey) && e.key === 'k') { e.preventDefault(); navigate('search'); } };
    window.addEventListener('keydown', onKey);
    return () => { offNav(); window.removeEventListener('keydown', onKey); };
  }, [navigate]);

  if (!ready) return <main className="page"><h1>Fudaner</h1>{bootError ? <><p role="alert">无法读取本机配置，请重试。</p><button onClick={() => void load()}>重试</button></> : <p role="status">正在准备你的助理…</p>}</main>;
  if (onboarding) return <OnboardingPage onComplete={() => { setCompleted(true); setOnboarding(false); setPage('chat'); }} onClose={completed ? () => { setOnboarding(false); setPage('settings'); } : undefined} />;

  return (
    <div className="app">
      <nav className={`nav${layout.leftCollapsed ? ' nav--collapsed' : ''}`} aria-label="主导航">
        <div className="nav-header">
          <div className="nav-brand">Fudaner</div>
          <button className="sidebar-toggle" type="button" onClick={() => toggle('leftCollapsed')} aria-label={layout.leftCollapsed ? '展开左侧栏' : '收起左侧栏'} title={layout.leftCollapsed ? '展开左侧栏' : '收起左侧栏'} aria-expanded={!layout.leftCollapsed} aria-controls="navigation-items">
            <NavIcon name={layout.leftCollapsed ? 'expand-left' : 'collapse-left'} />
          </button>
        </div>
        <p className="nav-caption">懂复旦，也慢慢懂你。</p>
        <div className="nav-menu" id="navigation-items">
        {NAV.map((n) => (
          <button key={n.page} className={page === n.page ? 'nav-item active' : 'nav-item'} onClick={() => navigate(n.page)} title={n.label} aria-label={n.label} aria-current={page === n.page ? 'page' : undefined}>
            <span className="nav-icon"><NavIcon name={n.page} /></span>
            <span className="nav-label">{n.label}</span>
          </button>
        ))}
        </div>
        <div className="nav-spacer" />
        <button className={page === 'settings' ? 'nav-item active' : 'nav-item'} onClick={() => navigate('settings')} title="设置" aria-label="设置" aria-current={page === 'settings' ? 'page' : undefined}>
          <span className="nav-icon"><NavIcon name="settings" /></span>
          <span className="nav-label">设置</span>
        </button>
      </nav>
      <main className="main">
        {page === 'chat' && <ChatPage assistantName={assistantName} todayCollapsed={layout.rightCollapsed} toggleToday={() => toggle('rightCollapsed')} quoted={quoted} addQuoted={addQuoted} clearQuoted={(id) => setQuoted((q) => (id ? q.filter((r) => r.id !== id) : []))} goto={navigate} />}
        {page === 'feed' && <FeedPage quote={quote} />}
        {page === 'goals' && <GoalsPage quote={quote} />}
        {page === 'library' && <LibraryPage quote={quote} />}
        {page === 'search' && <SearchPage quote={quote} />}
        {page === 'settings' && <SettingsPage onOpenOnboarding={() => {setSettingsDirty(false);setOnboarding(true);}} onDraftChange={setSettingsDirty} onBusyChange={setSettingsBusy} />}
      </main>
    </div>
  );
}
