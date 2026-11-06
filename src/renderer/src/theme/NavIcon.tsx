/** 主题试用分支的导航图标：用简单几何图形保持统一线宽。 */
export function NavIcon({ name }: { name: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      {name === 'chat' && <path d="M5 4h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H9l-6 3V6a2 2 0 0 1 2-2Z" />}
      {name === 'feed' && <><rect x="4" y="4" width="16" height="16" rx="2" /><path d="M8 9h8M8 13h8M8 17h5" /></>}
      {name === 'goals' && <><path d="M5 21V4M5 4h13l-3 5 3 5H5" /><path d="M3 21h4" /></>}
      {name === 'library' && <path d="M3 7V5a2 2 0 0 1 2-2h5l3 3h6a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z" />}
      {name === 'search' && <><circle cx="10.5" cy="10.5" r="6.5" /><path d="m16 16 5 5" /></>}
      {name === 'settings' && <><path d="M4 6h16M4 12h16M4 18h16" /><circle cx="9" cy="6" r="2" fill="var(--nav-bg)" /><circle cx="15" cy="12" r="2" fill="var(--nav-bg)" /><circle cx="9" cy="18" r="2" fill="var(--nav-bg)" /></>}
      {(name === 'collapse-left' || name === 'expand-left') && <><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M9 4v16" /><path d={name === 'collapse-left' ? 'm16 9-3 3 3 3' : 'm13 9 3 3-3 3'} /></>}
      {(name === 'collapse-right' || name === 'expand-right') && <><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M15 4v16" /><path d={name === 'collapse-right' ? 'm8 9 3 3-3 3' : 'm11 9-3 3 3 3'} /></>}
    </svg>
  );
}
