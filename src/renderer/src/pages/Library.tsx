import { useEffect, useRef, useState } from 'react';
import type { CardRef, Resource } from '../../../shared/types';
import { api, fmtRelative } from '../api';

const KIND: Record<Resource['kind'], string> = { assistant_output: '旦旦做的', upload: '我上传的', replay_note: '回放笔记', courseware: '课件' };

/** 资源库（PRD §5.4）：助理的成果 + 用户上传的文件 */
export function LibraryPage({ quote, focus }: { quote: (r: CardRef) => void; focus?: { id: string } | null }) {
  const [list, setList] = useState<Resource[]>([]);
  const [open, setOpen] = useState<Resource | null>(null);
  const load = () => void api.library.list().then(setList);
  useEffect(() => { load(); return api.on('library:changed', load); }, []);
  const view = useRef<HTMLDivElement>(null);
  const [focusError, setFocusError] = useState(false);
  useEffect(() => {
    setFocusError(false);
    if (!focus) return;
    let active = true;
    void api.library.get(focus.id).then((resource) => {
      if (active) { setOpen(resource); setFocusError(!resource); }
    }).catch(() => { if (active) setFocusError(true); });
    return () => { active = false; };
  }, [focus]);
  useEffect(() => {
    if (focus && open?.id === focus.id) view.current?.focus({ preventScroll: true });
  }, [focus, open?.id]);

  const onDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    for (const f of Array.from(e.dataTransfer.files)) {
      try { await api.library.upload(window.fudaner.pathForFile(f)); } catch (err) { alert((err as Error).message); }
    }
    load();
  };

  return (
    <div className="page library" onDragOver={(e) => e.preventDefault()} onDrop={onDrop}>
      <header className="page-header"><h1>资源库</h1><span className="muted">把 PDF / Word / Markdown 拖进来即可上传</span></header>
      <div className="library-grid">
        <div className="resource-list">
          {list.length === 0 && <div className="empty">还没有资源。让旦旦帮你做个复习提纲，或者拖一份课件进来。</div>}
          {list.map((r) => (
            <div key={r.id} className={open?.id === r.id ? 'resource active' : 'resource'} onClick={() => setOpen(r)}>
              <div>📄 {r.title}</div>
              <div className="muted">{KIND[r.kind]} · {fmtRelative(r.createdAt)}</div>
            </div>
          ))}
        </div>
        <div className={focus && focus.id === open?.id ? 'resource-view reference-highlight' : 'resource-view'} ref={view} tabIndex={-1}>
          {focusError && <p role="alert">暂时无法读取这份资源。</p>}
          {open ? (
            <>
              <div className="goal-head"><strong>{open.title}</strong><button onClick={() => quote({ type: 'resource', id: open.id, title: open.title })}>引用到对话</button></div>
              <pre className="doc">{open.text}</pre>
            </>
          ) : <div className="empty">选择左侧的资源查看</div>}
        </div>
      </div>
    </div>
  );
}
