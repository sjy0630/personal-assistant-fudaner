import type { FudanerApi } from '../../shared/ipc';

declare global {
  interface Window { fudaner: FudanerApi & { pathForFile(f: File): string } }
}

export const api = window.fudaner;

export function fmtTime(iso?: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  const wd = '日一二三四五六'[d.getDay()];
  return `${d.getMonth() + 1}/${d.getDate()} 周${wd} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export function fmtRelative(iso: string): string {
  const diff = Date.now() - Date.parse(iso);
  if (diff < 60_000) return '刚刚';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  return fmtTime(iso);
}
