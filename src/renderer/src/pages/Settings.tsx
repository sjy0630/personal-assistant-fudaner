import { useEffect, useState } from 'react';
import { DecisionsTab } from './Decisions';
import { ModelSettings } from './settings/ModelSettings';
import { AccountSettings } from './settings/AccountSettings';
import { ActivitySettings } from './settings/ActivitySettings';
import { ExternalSettings } from './settings/ExternalSettings';
import { PersonalSettings } from './settings/PersonalSettings';
import { AssistantSettings } from './settings/AssistantSettings';
import { DeveloperSettings } from './settings/DeveloperSettings';
import styles from './settings/Settings.module.css';
import { getThemePreference, setThemePreference, type ThemePreference } from '../theme';

type Tab = 'model' | 'accounts' | 'activities' | 'external' | 'me' | 'assistant' | 'decisions' | 'dev';
const TABS: ReadonlyArray<readonly [Tab, string]> = [
  ['model', '模型'],
  ['accounts', '复旦账号'],
  ['activities', '通知与活动'],
  ['external', '扩展服务'],
  ['me', '关于我'],
  ['assistant', '助理'],
  ['decisions', '主动决策'],
  ['dev', '开发者'],
];
export function SettingsPage({
  onOpenOnboarding,
  onDraftChange,
  onBusyChange,
}: {
  onOpenOnboarding?: () => void;
  onDraftChange?: (dirty: boolean) => void;
  onBusyChange?: (busy: boolean) => void;
}) {
  const [tab, setTab] = useState<Tab>('model');
  const [dirty, setDirty] = useState(false);
  const [theme, setTheme] = useState(getThemePreference);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    onDraftChange?.(dirty);
  }, [dirty, onDraftChange]);
  useEffect(() => {
    onBusyChange?.(busy);
  }, [busy, onBusyChange]);
  const mayLeave = () =>
    !dirty || window.confirm('本页有尚未保存的修改，离开后这些修改将丢失。确认离开？');
  const changeTab = (next: Tab) => {
    if (next !== tab && !busy && mayLeave()) {
      setDirty(false);
      setTab(next);
    }
  };
  const props = { onDirty: setDirty, onBusy: setBusy };
  return (
    <div className={styles.root}>
      <header className={styles.header}>
        <h1>设置</h1>
        {/* 深浅色切换（来自 F2）：暖色宋体主题的浅色 / 深色两套配色 */}
        <label className="theme-control">
          外观
          <select value={theme} onChange={(event) => {
            const next = event.target.value as ThemePreference;
            setThemePreference(next);
            setTheme(next);
          }}>
            <option value="system">跟随系统</option>
            <option value="light">浅色</option>
            <option value="dark">深色</option>
          </select>
        </label>
        {onOpenOnboarding && (
          <button
            disabled={busy}
            onClick={() => {
              if (mayLeave()) onOpenOnboarding();
            }}
          >
            重新打开使用引导
          </button>
        )}
      </header>
      <div
        role="tablist"
        aria-label="设置栏目"
        className={styles.tabs}
        onKeyDown={(e) => {
          const index = TABS.findIndex(([key]) => key === tab);
          const next =
            e.key === 'ArrowRight'
              ? (index + 1) % TABS.length
              : e.key === 'ArrowLeft'
                ? (index + TABS.length - 1) % TABS.length
                : e.key === 'Home'
                  ? 0
                  : e.key === 'End'
                    ? TABS.length - 1
                    : -1;
          if (next >= 0 && !busy) {
            e.preventDefault();
            changeTab(TABS[next][0]);
          }
        }}
      >
        {TABS.map(([key, label]) => (
          <button
            key={key}
            role="tab"
            id={`settings-tab-${key}`}
            tabIndex={tab === key ? 0 : -1}
            aria-selected={tab === key}
            aria-controls="settings-panel"
            className={tab === key ? styles.active : ''}
            disabled={busy}
            onClick={() => changeTab(key)}
          >
            {label}
          </button>
        ))}
      </div>
      <div
        className={styles.body}
        id="settings-panel"
        role="tabpanel"
        aria-labelledby={`settings-tab-${tab}`}
      >
        {tab === 'model' && <ModelSettings {...props} />}
        {tab === 'accounts' && <AccountSettings {...props} />}
        {tab === 'activities' && <ActivitySettings {...props} />}
        {tab === 'external' && <ExternalSettings {...props} />}
        {tab === 'me' && <PersonalSettings {...props} />}
        {tab === 'assistant' && <AssistantSettings {...props} />}
        {tab === 'dev' && <DeveloperSettings {...props} />}
        {tab === 'decisions' && <DecisionsTab />}
      </div>
    </div>
  );
}
