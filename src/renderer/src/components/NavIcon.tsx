export type NavIconName = 'chat' | 'feed' | 'goals' | 'library' | 'search' | 'settings';

const paths: Record<NavIconName, React.ReactNode> = {
  chat: <path d="M20 11.5a7.5 7.5 0 0 1-7.5 7.5H9l-4 2v-4.8A7.5 7.5 0 1 1 20 11.5Z" />,
  feed: <><rect x="4" y="4" width="16" height="16" rx="3" /><path d="M8 9h8M8 13h8M8 16h5" /></>,
  goals: <><circle cx="12" cy="12" r="8" /><circle cx="12" cy="12" r="4" /><circle cx="12" cy="12" r="1" fill="currentColor" stroke="none" /></>,
  library: <><rect x="4" y="5" width="5" height="14" rx="1" /><rect x="10" y="5" width="4" height="14" rx="1" /><path d="m16 6 3-1 3 13-3 1z" /></>,
  search: <><circle cx="10.5" cy="10.5" r="5.5" /><path d="m15 15 5 5" /></>,
  settings: <><path d="M4 7h16M4 12h16M4 17h16" /><path d="M8 5v4m8 1v4m-5 1v4" strokeWidth="2.5" /></>,
};

export function NavIcon({ name }: { name: NavIconName }) {
  return <svg className="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor"
    strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {paths[name]}
  </svg>;
}
