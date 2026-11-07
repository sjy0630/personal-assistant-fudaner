import type { CardRef } from '../../../../shared/types';
import { supportedAttachment, MAX_ATTACHMENT_BYTES, ATTACHMENT_FORMATS_LABEL } from '../../../../shared/attachment-formats';

export interface ChatDraft { text: string; refs: CardRef[] }
export interface UploadJob { id: string; name: string; status: 'uploading' | 'failed'; error?: string }
export interface FileMetadata { name: string; size: number; lastModified: number }
interface DraftReader { getItem(key: string): string | null }
interface DraftStorage extends DraftReader { setItem(key: string, value: string): void }
interface WorkspaceSnapshot { draft: ChatDraft; uploads: UploadJob[]; blocked: boolean; focusVersion: number; resetVersion: number }

const DRAFT_KEY = 'fudaner.chat-draft.v1';
const REF_TYPES = new Set<CardRef['type']>(['item', 'goal', 'task', 'resource', 'feed', 'ticket']);
const FORMAT_ERROR = `暂不支持这种文件格式。支持${ATTACHMENT_FORMATS_LABEL}，请移除后重新选择。`;
const IMPORT_ERROR = '文件导入失败，请重试；也可以移除后继续发送。';
const PATH_ERROR = '无法读取这个文件，请重新选择本机文件，或移除后继续。';
const emptyDraft = (): ChatDraft => ({ text: '', refs: [] });

/** Draft references carry display data only, never operation permissions. */
function cleanRefs(values: unknown[]): CardRef[] {
  const refs: CardRef[] = [];
  for (const value of values) {
    if (!value || typeof value !== 'object') continue;
    const ref = value as Partial<CardRef>;
    if (!ref.type || !REF_TYPES.has(ref.type) || typeof ref.id !== 'string' || !ref.id.trim() || typeof ref.title !== 'string') continue;
    if (refs.some((item) => item.type === ref.type && item.id === ref.id)) continue;
    refs.push({ type: ref.type, id: ref.id, title: ref.title, ...(typeof ref.subtitle === 'string' ? { subtitle: ref.subtitle } : {}) });
  }
  return refs;
}

export function readDraft(storage?: DraftReader): ChatDraft {
  try {
    const raw = storage?.getItem(DRAFT_KEY);
    if (!raw) return emptyDraft();
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== 'object') return emptyDraft();
    const draft = value as Partial<ChatDraft>;
    if (typeof draft.text !== 'string' || !Array.isArray(draft.refs)) return emptyDraft();
    return { text: draft.text, refs: cleanRefs(draft.refs) };
  } catch { return emptyDraft(); }
}

export function writeDraft(storage: DraftStorage | undefined, draft: ChatDraft): void {
  try { storage?.setItem(DRAFT_KEY, JSON.stringify({ text: draft.text, refs: cleanRefs(draft.refs) })); }
  catch { /* Storage can be unavailable or full; the in-memory draft remains usable. */ }
}

/** App-owned state: no browser globals, allowing import jobs to outlive the chat page. */
export function createChatWorkspace<TFile extends FileMetadata>(dependencies: {
  storage?: DraftStorage;
  pathForFile(file: TFile): string;
  upload(path: string): Promise<CardRef>;
  uploadFromMemory?(file: TFile, active: () => boolean): Promise<CardRef>;
}) {
  let snapshot: WorkspaceSnapshot = { draft: readDraft(dependencies.storage), uploads: [], blocked: false, focusVersion: 0, resetVersion: 0 };
  const listeners = new Set<() => void>();
  const files = new Map<string, { file: TFile }>();
  const inFlight = new Map<string, string>();
  const imported = new Map<string, CardRef>();
  let nextUpload = 0;

  function publish(update: Partial<WorkspaceSnapshot>) {
    snapshot = { ...snapshot, ...update };
    if (update.draft) writeDraft(dependencies.storage, update.draft);
    for (const listener of listeners) listener();
  }
  function updateUploads(uploads: UploadJob[]) { publish({ uploads, blocked: uploads.length > 0 }); }
  function addRef(ref: CardRef) {
    publish({ draft: { ...snapshot.draft, refs: cleanRefs([...snapshot.draft.refs, ref]) } });
  }
  function markFailed(id: string, error: string) {
    updateUploads(snapshot.uploads.map((job) => job.id === id ? { ...job, status: 'failed', error } : job));
  }
  async function importFile(id: string): Promise<void> {
    const stored = files.get(id);
    if (!stored) return;
    const { file } = stored;
    if (!supportedAttachment(file.name)) { markFailed(id, FORMAT_ERROR); return; }
    if (file.size > MAX_ATTACHMENT_BYTES) { markFailed(id, '单个附件最大支持 25 MB，请缩小文件后重试。'); return; }
    let path: string;
    try {
      path = dependencies.pathForFile(file);
      if (!path.trim() && !dependencies.uploadFromMemory) { markFailed(id, PATH_ERROR); return; }
    } catch { markFailed(id, PATH_ERROR); return; }
    const key = JSON.stringify([path || file.name, file.size, file.lastModified]);
    const alreadyAttached = imported.get(key);
    if (alreadyAttached && snapshot.draft.refs.some((ref) => ref.type === alreadyAttached.type && ref.id === alreadyAttached.id)) {
      files.delete(id);
      updateUploads(snapshot.uploads.filter((job) => job.id !== id));
      return;
    }
    if (inFlight.has(key)) {
      // A newly added duplicate can disappear; an existing failed job still needs an explicit resolution.
      if (!snapshot.uploads.some((job) => job.id === id && job.status === 'failed')) {
        files.delete(id);
        updateUploads(snapshot.uploads.filter((job) => job.id !== id));
      }
      return;
    }
    inFlight.set(key, id);
    updateUploads(snapshot.uploads.map((job) => job.id === id ? { id, name: file.name, status: 'uploading' } : job));
    try {
      const ref = path.trim() ? await dependencies.upload(path) : await dependencies.uploadFromMemory!(file, () => files.get(id) === stored);
      if (files.has(id)) {
        imported.set(key, ref);
        addRef(ref);
        files.delete(id);
        updateUploads(snapshot.uploads.filter((job) => job.id !== id));
      }
    } catch { if (files.has(id)) markFailed(id, IMPORT_ERROR); }
    finally { if (inFlight.get(key) === id) inFlight.delete(key); }
  }

  return {
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    setText(text: string | ((previous: string) => string)) {
      publish({ draft: { ...snapshot.draft, text: typeof text === 'function' ? text(snapshot.draft.text) : text } });
    },
    addRef,
    removeRef(type: CardRef['type'], id: string) {
      for (const [key, ref] of imported) if (ref.type === type && ref.id === id) imported.delete(key);
      publish({ draft: { ...snapshot.draft, refs: snapshot.draft.refs.filter((ref) => ref.type !== type || ref.id !== id) } });
    },
    clearDraft() { imported.clear(); publish({ draft: emptyDraft() }); },
    reset() {
      files.clear(); inFlight.clear(); imported.clear();
      publish({ draft: emptyDraft(), uploads: [], blocked: false, resetVersion: snapshot.resetVersion + 1 });
    },
    restoreDraft(sent: ChatDraft, resetVersion = snapshot.resetVersion) {
      if (resetVersion !== snapshot.resetVersion) return;
      const current = snapshot.draft.text;
      const text = current === sent.text ? current : [sent.text, current].filter(Boolean).join('\n\n');
      publish({ draft: { text, refs: cleanRefs([...snapshot.draft.refs, ...sent.refs]) } });
    },
    focusComposer() { publish({ focusVersion: snapshot.focusVersion + 1 }); },
    async uploadFiles(selected: TFile[]): Promise<void> {
      await Promise.all(selected.map((file) => {
        const id = `upload-${++nextUpload}`;
        files.set(id, { file });
        updateUploads([...snapshot.uploads, { id, name: file.name, status: 'uploading' }]);
        return importFile(id);
      }));
    },
    async retryUpload(id: string): Promise<void> {
      if (snapshot.uploads.some((job) => job.id === id && job.status === 'failed')) await importFile(id);
    },
    dismissUpload(id: string) {
      // The resource may still finish importing into the library; an explicitly dismissed job no longer adds a reference.
      files.delete(id);
      updateUploads(snapshot.uploads.filter((job) => job.id !== id));
    },
  };
}
