import { useCallback, useEffect, useRef, useState } from 'react';
import type { CardRef, Resource } from '../../../shared/types';
import { api, fmtRelative } from '../api';
import { MarkdownPreview } from '../components/MarkdownPreview';

const KIND: Record<Resource['kind'], string> = { assistant_output: '旦旦做的', upload: '我上传的', replay_note: '回放笔记', courseware: '课件' };
export function LibraryPage({ quote }: { quote: (r: CardRef) => void }) {
  const [list, setList] = useState<Resource[]>([]);
  const [openId, setOpenId] = useState<string | null>(null);
  const [course, setCourse] = useState('');
  const [courseNames, setCourseNames] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [uploading, setUploading] = useState(false);
  const uploadingRef = useRef(false);
  const [failures, setFailures] = useState<string[]>([]);
  const [notice, setNotice] = useState('');
  const [source, setSource] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState('');
  const deleteDialog = useRef<HTMLDialogElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const requestRef = useRef(0);
  const load = useCallback(async () => {
    const request = ++requestRef.current;
    setLoadError('');
    try {
      const resources = await api.library.list();
      if (request === requestRef.current) setList(resources);
    } catch { if (request === requestRef.current) setLoadError('资源暂时未能加载，请重试。'); }
    finally { if (request === requestRef.current) setLoading(false); }
  }, []);
  useEffect(() => { void load(); return api.on('library:changed', () => { void load(); }); }, [load]);
  useEffect(() => {
    let active = true;
    const names = () => void api.goals.list().then(({ goals }) => {
      if (active) setCourseNames(Object.fromEntries(goals.filter((g) => g.level === 'course' && g.courseId).map((g) => [g.courseId!, g.title])));
    }).catch(() => { /* 课程名不可用时仍可按课程 ID 筛选。 */ });
    names(); const off = api.on('goals:changed', names);
    return () => { active = false; off(); };
  }, []);
  const upload = async (files: File[]) => {
    if (!files.length || uploadingRef.current) return;
    uploadingRef.current = true; setUploading(true); setFailures([]); setNotice('');
    const errors: string[] = [];
    const added: Resource[] = [];
    try {
      for (const file of files) {
        try { added.push(await api.library.upload(window.fudaner.pathForFile(file))); }
        catch (err) { errors.push(`${file.name}：${err instanceof Error ? err.message : '上传失败，请重试。'}`); }
      }
      if (added.length) {
        setList((previous) => [...added, ...previous.filter((r) => !added.some((a) => a.id === r.id))]);
        setCourse(''); setOpenId(added[added.length - 1].id); setSource(false);
        setNotice(`已上传 ${added.length} 个文件，已打开新资源。`);
      }
      setFailures(errors);
      await load();
    } finally { uploadingRef.current = false; setUploading(false); }
  };
  const visible = list.filter((r) => !course || (course === '__none' ? !r.courseId : r.courseId === course));
  const open = visible.find((r) => r.id === openId);
  const courseIds = [...new Set([
    ...list.flatMap((r) => r.courseId ? [r.courseId] : []),
    ...(course && course !== '__none' ? [course] : []),
  ])].sort();
  const remove = async (resource: Resource) => {
    if (deleting) return;
    setDeleting(true);
    setDeleteError('');
    try {
      if (typeof api.library.remove !== 'function') {
        setDeleteError('当前窗口还未加载删除功能。请在 PowerShell 按 Ctrl+C 停止 Demo，重新运行 npm run dev:demo 后再试。');
        return;
      }
      await api.library.remove(resource.id);
      setList((previous) => previous.filter((r) => r.id !== resource.id));
      setOpenId((previous) => previous === resource.id ? null : previous);
      setNotice(`已删除「${resource.title}」。`);
      deleteDialog.current?.close();
      await load();
    } catch (error) {
      console.error('删除资源失败', error);
      if (error instanceof Error && error.message.includes("No handler registered for 'library.remove'")) {
        setDeleteError('当前 Demo 的后台还未加载删除功能。请在 PowerShell 按 Ctrl+C 停止 Demo，重新运行 npm run dev:demo 后再试。');
      } else {
        setDeleteError('资源库未能保存删除操作。请重试，若仍失败，请查看启动 Demo 的 PowerShell 窗口中的错误。');
      }
    } finally {
      setDeleting(false);
    }
  };
  const isMarkdown = open?.mime.toLowerCase().split(';')[0].trim() === 'text/markdown';
  const isDocument = open?.mime === 'application/pdf' || open?.mime === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  const canPreview = isMarkdown || isDocument;
  return <div className="page library" onDragOver={(e) => e.preventDefault()} onDrop={(e) => { e.preventDefault(); void upload(Array.from(e.dataTransfer.files)); }}>
    <header className="page-header"><h1>资源库</h1><button disabled={uploading} onClick={() => fileRef.current?.click()}>{uploading ? '正在上传…' : '上传文件'}</button></header>
    <input ref={fileRef} type="file" hidden multiple accept=".pdf,.docx,.md,.markdown,.txt,.csv,.json" onChange={(e) => { const files = Array.from(e.target.files ?? []); e.target.value = ''; void upload(files); }} />
    <p className="library-upload-hint muted">把 PDF / Word（.docx）/ Markdown 拖进来，也可点击上传文件。文档按标题、段落和列表整理阅读。</p>
    <div className="library-toolbar"><label>课程 <select value={course} onChange={(e) => setCourse(e.target.value)}><option value="">全部课程</option><option value="__none">未关联课程</option>{courseIds.map((id) => <option key={id} value={id}>{courseNames[id] || `课程 ${id}`}</option>)}</select></label><span className="muted small">{visible.length} 个资源</span></div>
    {loadError && <div className="goal-error" role="alert">{loadError}<button onClick={() => void load()}>重试</button></div>}
    {uploading && <p role="status">正在解析文件，请稍候…</p>}
    {notice && <p className="library-notice" role="status">{notice}</p>}
    {failures.length > 0 && <div className="library-upload-errors" role="alert"><strong>以下文件未能上传</strong><ul>{failures.map((f, i) => <li key={i}>{f}</li>)}</ul><span>可以重新选择或拖入这些文件；已成功上传的资源会保留。</span></div>}
    <div className="library-grid">
      <div className="resource-list" aria-label="资源列表">
        {loading && <div className="empty" role="status">正在加载资源…</div>}
        {!loading && !visible.length && <div className="empty">{course ? '这个课程筛选下还没有资源。' : '还没有资源。上传课件，或让旦旦帮你做一份复习提纲。'}</div>}
        {visible.map((r) => <button key={r.id} className={`resource resource-button ${open?.id === r.id ? 'active' : ''}`} aria-pressed={open?.id === r.id} onClick={() => { setOpenId(r.id); setSource(false); }}><span>📄 {r.title}</span><span className="muted small">{KIND[r.kind]} · {fmtRelative(r.createdAt)}</span>{r.courseId && <span className="muted small">{courseNames[r.courseId] || `课程 ${r.courseId}`}</span>}</button>)}
      </div>
      <div className="resource-view">
        {open ? <>
          <div className="goal-head">
            <strong>{open.title}</strong>
            <button onClick={() => quote({ type: 'resource', id: open.id, title: open.title })}>引用到对话</button>
            <button className="danger" disabled={uploading || deleting} onClick={() => {
              setDeleteError('');
              deleteDialog.current?.showModal();
            }}>删除</button>
          </div>
          <div className="resource-preview-toolbar"><span className="muted small">{isMarkdown ? 'Markdown 文档' : isDocument ? '文档阅读预览' : '提取的文字内容'}</span>{canPreview && <button className="ghost" aria-pressed={source} onClick={() => setSource(!source)}>{source ? '查看预览' : '查看提取文本'}</button>}</div>
          {isDocument && <p className="muted small">按提取结构展示，复杂分栏、合并单元格、公式和图片可能无法完整还原。早先上传的文件需重新上传以使用新版解析。</p>}
          {!open.text.trim() ? <div className="empty">文件已保存，但没有提取到文字。如果是扫描版 PDF，请先识别文字后再上传。</div> : canPreview && !source ? <MarkdownPreview text={open.text} /> : <pre className="doc">{open.text}</pre>}
        </> : <div className="empty">选择左侧的资源查看内容</div>}
      </div>
    </div>
    <dialog ref={deleteDialog} className="feedback-dialog" aria-labelledby="resource-delete-title"
      onCancel={(e) => { if (deleting) e.preventDefault(); }}>
      <h2 id="resource-delete-title">删除资源</h2>
      <p className="feedback-title">确定从资源库删除「{open?.title}」？磁盘上的原文件会保留。</p>
      {deleteError && <p className="feedback-error" role="alert">{deleteError}</p>}
      <div className="actions feedback-actions">
        <button autoFocus disabled={deleting} onClick={() => deleteDialog.current?.close()}>取消</button>
        <button className="danger" disabled={deleting || !open} onClick={() => { if (open) void remove(open); }}>
          {deleting ? '正在删除…' : '确认删除'}
        </button>
      </div>
    </dialog>
  </div>;
}
