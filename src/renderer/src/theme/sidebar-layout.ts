export interface SidebarLayout { leftCollapsed: boolean; rightCollapsed: boolean }
export const SIDEBAR_LAYOUT_KEY = 'fudaner.sidebar-layout.v1';
const defaults = (): SidebarLayout => ({ leftCollapsed: false, rightCollapsed: false });

export function readSidebarLayout(storage: { getItem(key: string): string | null } | undefined): SidebarLayout {
  try {
    const value: unknown = JSON.parse(storage?.getItem(SIDEBAR_LAYOUT_KEY) ?? 'null');
    if (!value || typeof value !== 'object' || Array.isArray(value)) return defaults();
    const fields = value as Record<string, unknown>;
    return { leftCollapsed: fields.leftCollapsed === true, rightCollapsed: fields.rightCollapsed === true };
  } catch { return defaults(); }
}
export function writeSidebarLayout(storage: { setItem(key: string, value: string): void } | undefined, layout: SidebarLayout): void {
  try { storage?.setItem(SIDEBAR_LAYOUT_KEY, JSON.stringify(layout)); } catch { /* 无存储权限时仍可在当前窗口操作。 */ }
}
