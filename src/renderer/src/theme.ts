export type ThemePreference = 'system' | 'light' | 'dark';

const storageKey = 'fudaner.theme';
const systemTheme = window.matchMedia('(prefers-color-scheme: dark)');

function readPreference(): ThemePreference {
  try {
    const stored = window.localStorage.getItem(storageKey);
    if (stored === 'light' || stored === 'dark') return stored;
  } catch {
    // 本地存储不可用时仍允许在当前窗口切换。
  }
  return 'system';
}

let preference = readPreference();

function applyTheme() {
  const system = systemTheme.matches ? 'dark' : 'light';
  document.documentElement.dataset.theme = preference === 'system' ? system : preference;
}

applyTheme();
systemTheme.addEventListener('change', applyTheme);

export function getThemePreference(): ThemePreference {
  return preference;
}

export function setThemePreference(next: ThemePreference): void {
  preference = next;
  applyTheme();
  try {
    window.localStorage.setItem(storageKey, next);
  } catch {
    // 当前窗口的主题已生效。
  }
}
