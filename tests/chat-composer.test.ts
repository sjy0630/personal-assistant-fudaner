import { describe, expect, it } from 'vitest';
import type { CardRef } from '../src/shared/types';
import { createChatWorkspace, readDraft, writeDraft } from '../src/renderer/src/pages/chat/composer-state';

const resource: CardRef = { type: 'resource', id: 'r1', title: '课程资料' };
function storage(initial?: string) {
  const values = new Map(initial === undefined ? [] : [['fudaner.chat-draft.v1', initial]]);
  return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
type TestFile = { name: string; size: number; lastModified: number; path: string };
const file = (name = 'notes.pdf'): TestFile => ({ name, size: 12, lastModified: 42, path: `/tmp/${name}` });
function workspace(options: { storage?: ReturnType<typeof storage>; upload?: (path: string) => Promise<CardRef>; pathForFile?: (file: TestFile) => string } = {}) {
  return createChatWorkspace<TestFile>({ storage: options.storage, pathForFile: options.pathForFile ?? ((f) => f.path), upload: options.upload ?? (async () => resource) });
}

describe('主对话草稿', () => {
  it('读取空、损坏和不合法的存储时保持可编辑的空草稿', () => {
    for (const raw of [undefined, '{bad', 'null', '[]', '{"text":13,"refs":"bad"}']) {
      expect(readDraft(storage(raw))).toEqual({ text: '', refs: [] });
    }
    expect(readDraft({ getItem: () => { throw new Error('拒绝访问'); } })).toEqual({ text: '', refs: [] });
  });
  it('持久化仅保留引用展示字段，读取时也清除权限并去重', () => {
    const local = storage();
    writeDraft(local, { text: '你好\n待办', refs: [{ ...resource, subtitle: '资料', undoToken: 'secret', undone: true }, resource] });
    expect(JSON.parse(local.getItem('fudaner.chat-draft.v1')!)).toEqual({ text: '你好\n待办', refs: [{ ...resource, subtitle: '资料' }] });
    expect(readDraft(storage(JSON.stringify({ text: 'x', refs: [{ ...resource, undoToken: 'secret' }, resource, { type: 'invalid', id: 'x', title: '坏' }] })))).toEqual({ text: 'x', refs: [resource] });
  });
  it('存储读写抛错时仍能输入并引用', () => {
    const denied = { getItem: () => { throw new Error('不可读'); }, setItem: () => { throw new Error('不可写'); } };
    const state = workspace({ storage: denied });
    state.setText('我'); state.setText((text) => `${text}的新草稿`); state.addRef(resource);
    expect(state.getSnapshot().draft).toEqual({ text: '我的新草稿', refs: [resource] });
  });
  it('按类型和ID去重及移除引用，每次修改立即持久化', () => {
    const local = storage(); const state = workspace({ storage: local });
    state.addRef(resource); state.addRef({ ...resource, title: '重复' });
    state.addRef({ type: 'goal', id: 'r1', title: '目标' });
    state.removeRef('resource', 'r1');
    expect(state.getSnapshot().draft.refs).toEqual([{ type: 'goal', id: 'r1', title: '目标' }]);
    state.setText('还没写完');
    expect(workspace({ storage: local }).getSnapshot().draft.text).toBe('还没写完');
    state.clearDraft(); expect(readDraft(local)).toEqual({ text: '', refs: [] });
  });
  it('失败恢复合并引用且不覆盖等待时新输入的内容', () => {
    const state = workspace();
    state.setText('发送中的原文'); state.addRef(resource);
    const sent = state.getSnapshot().draft; state.clearDraft();
    state.setText('新的问题'); state.addRef({ type: 'task', id: 't1', title: '任务' });
    state.restoreDraft(sent);
    expect(state.getSnapshot().draft).toEqual({ text: '发送中的原文\n\n新的问题', refs: [{ type: 'task', id: 't1', title: '任务' }, resource] });
    state.clearDraft(); state.restoreDraft(sent);
    expect(state.getSnapshot().draft).toEqual(sent);
  });
  it('发布新快照供订阅方更新，并允许退订和主动聚焦', () => {
    const state = workspace(); let calls = 0;
    const first = state.getSnapshot(); const off = state.subscribe(() => { calls++; });
    state.focusComposer(); expect(state.getSnapshot().focusVersion).toBe(1);
    expect(state.getSnapshot()).not.toBe(first); expect(calls).toBe(1);
    off(); state.focusComposer(); expect(calls).toBe(1);
  });
});

describe('主对话附件导入', () => {
  it('并发导入后分别添加引用，成功项不再阻止发送', async () => {
    const a = deferred<CardRef>(); const b = deferred<CardRef>();
    const state = workspace({ upload: (path) => path.endsWith('a.pdf') ? a.promise : b.promise });
    const importing = state.uploadFiles([file('a.pdf'), file('b.docx')]);
    expect(state.getSnapshot().uploads.map((job) => job.status)).toEqual(['uploading', 'uploading']);
    expect(state.getSnapshot().blocked).toBe(true);
    b.resolve({ type: 'resource', id: 'b', title: 'B' }); await Promise.resolve(); await Promise.resolve();
    expect(state.getSnapshot().draft.refs.map((ref) => ref.id)).toEqual(['b']);
    expect(state.getSnapshot().uploads).toHaveLength(1);
    a.resolve(resource); await importing;
    expect(state.getSnapshot().uploads).toEqual([]); expect(state.getSnapshot().blocked).toBe(false);
    expect(state.getSnapshot().draft.refs.map((ref) => ref.id)).toEqual(['b', 'r1']);
  });
  it('相同文件导入中重复拖入只提交一次，不同版本允许导入', async () => {
    const result = deferred<CardRef>(); let calls = 0;
    const state = workspace({ upload: async () => { calls++; return result.promise; } });
    const original = file();
    const importing = state.uploadFiles([original, original]);
    const duplicate = state.uploadFiles([original]);
    const changed = state.uploadFiles([{ ...original, lastModified: 43 }]);
    expect(calls).toBe(2); expect(state.getSnapshot().uploads).toHaveLength(2);
    result.resolve(resource); await Promise.all([importing, duplicate, changed]);
    expect(state.getSnapshot().draft.refs).toEqual([resource]);
  });
  it('失败保留可重试任务并阻止漏附件发送，重试成功后恢复', async () => {
    let attempts = 0;
    const state = workspace({ upload: async () => { if (++attempts === 1) throw new Error('导入服务暂时不可用'); return resource; } });
    await state.uploadFiles([file()]);
    const failed = state.getSnapshot().uploads[0];
    expect(failed).toMatchObject({ name: 'notes.pdf', status: 'failed' }); expect(failed.error).toBeTruthy();
    expect(state.getSnapshot().blocked).toBe(true);
    await state.retryUpload(failed.id);
    expect(state.getSnapshot().draft.refs).toEqual([resource]); expect(state.getSnapshot().blocked).toBe(false);
  });
  it('不支持的格式和无法读取路径均友好失败，逐项移除后可继续', async () => {
    let submissions = 0;
    const state = workspace({ pathForFile: () => { throw new Error('不可读'); }, upload: async () => { submissions++; return resource; } });
    await state.uploadFiles([file('photo.exe'), file()]);
    expect(submissions).toBe(0);
    const jobs = state.getSnapshot().uploads;
    expect(jobs.map((job) => job.status)).toEqual(['failed', 'failed']);
    expect(jobs[0].error).toContain('支持'); expect(jobs[1].error).toBeTruthy();
    state.dismissUpload(jobs[0].id); expect(state.getSnapshot().blocked).toBe(true);
    state.dismissUpload(jobs[1].id); expect(state.getSnapshot().blocked).toBe(false);
  });
  it('所有承诺格式均支持并忽略扩展名大小写', async () => {
    const state = workspace();
    await state.uploadFiles(['pdf', 'docx', 'md', 'markdown', 'txt', 'csv', 'json', 'PDF'].map((extension) => file(`资料.${extension}`)));
    expect(state.getSnapshot().uploads).toEqual([]); expect(state.getSnapshot().draft.refs).toEqual([resource]);
  });
  it('清空已发送草稿后仍接收完成的导入结果', async () => {
    const result = deferred<CardRef>(); const state = workspace({ upload: () => result.promise });
    const importing = state.uploadFiles([file()]); state.clearDraft();
    expect(state.getSnapshot().blocked).toBe(true);
    result.resolve(resource); await importing;
    expect(state.getSnapshot().draft.refs).toEqual([resource]);
  });
  it('同一份附件导入后再次选择不会重复写入资源库', async () => {
    let calls = 0;
    const state = workspace({ upload: async () => { calls++; return resource; } });
    await state.uploadFiles([file()]);
    await state.uploadFiles([file()]);
    expect(calls).toBe(1);
    state.removeRef(resource.type, resource.id);
    await state.uploadFiles([file()]);
    expect(calls).toBe(2);
  });
  it('清除个人数据后迟到的发送或导入结果不恢复旧草稿', async () => {
    const result = deferred<CardRef>();
    const local = storage();
    const state = workspace({ storage: local, upload: () => result.promise });
    state.setText('旧草稿');
    const { draft, resetVersion } = state.getSnapshot();
    const importing = state.uploadFiles([file()]);
    state.reset();
    state.restoreDraft(draft, resetVersion);
    result.resolve(resource);
    await importing;
    expect(readDraft(local)).toEqual({ text: '', refs: [] });
    expect(state.getSnapshot().uploads).toEqual([]);
  });
  it('已完成文件可在下一份草稿重新选择，不会永久去重', async () => {
    let calls = 0;
    const state = workspace({ upload: async () => { calls++; return resource; } });
    await state.uploadFiles([file()]); state.clearDraft(); await state.uploadFiles([file()]);
    expect(calls).toBe(2); expect(state.getSnapshot().draft.refs).toEqual([resource]);
  });
  it('显式移除导入中的文件后，完成结果不再引用到草稿', async () => {
    const result = deferred<CardRef>(); const state = workspace({ upload: () => result.promise });
    const importing = state.uploadFiles([file()]); state.dismissUpload(state.getSnapshot().uploads[0].id);
    expect(state.getSnapshot().blocked).toBe(false);
    result.resolve(resource); await importing;
    expect(state.getSnapshot().draft.refs).toEqual([]); expect(state.getSnapshot().uploads).toEqual([]);
  });
  it('路径读取失败可重试，并且连续点击重试不会重复提交', async () => {
    let canRead = false; let calls = 0; const result = deferred<CardRef>();
    const state = workspace({ pathForFile: (file) => { if (!canRead) throw new Error('锁定'); return file.path; }, upload: () => { calls++; return result.promise; } });
    await state.uploadFiles([file()]); const id = state.getSnapshot().uploads[0].id;
    canRead = true; const retry = state.retryUpload(id); const duplicate = state.retryUpload(id);
    expect(calls).toBe(1); expect(state.getSnapshot().uploads[0].status).toBe('uploading');
    result.resolve(resource); await Promise.all([retry, duplicate]);
    expect(state.getSnapshot().draft.refs).toEqual([resource]);
  });
});
