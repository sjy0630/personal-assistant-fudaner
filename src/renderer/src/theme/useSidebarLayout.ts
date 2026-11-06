import { useEffect, useState } from 'react';
import { readSidebarLayout, writeSidebarLayout, type SidebarLayout } from './sidebar-layout';

function browserStorage(): Storage | undefined {
  try { return window.localStorage; } catch { return undefined; }
}
export function useSidebarLayout() {
  const [layout, setLayout] = useState(() => readSidebarLayout(browserStorage()));
  useEffect(() => writeSidebarLayout(browserStorage(), layout), [layout]);
  const toggle = (side: keyof SidebarLayout) => setLayout((previous) => ({ ...previous, [side]: !previous[side] }));
  return { layout, toggle };
}
