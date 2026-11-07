import { useLayoutEffect, useRef } from 'react';
import type { CardRef } from '../../../../shared/types';
import type { ChatWorkspace } from './useChatWorkspace';
import { ChatReference } from './ChatReference';
import { ATTACHMENT_ACCEPT } from '../../../../shared/attachment-formats';

export function ChatComposer({ workspace, assistantName, busy, running, stopping, error, send, stop, open }: {
  workspace: ChatWorkspace; assistantName: string; busy: boolean; running: boolean; stopping: boolean; error: string;
  send: () => void; stop: () => void; open: (ref: CardRef) => void;
}) {
  const textarea = useRef<HTMLTextAreaElement>(null);
  const picker = useRef<HTMLInputElement>(null);
  useLayoutEffect(() => {
    const element = textarea.current;
    if (!element) return;
    element.style.height = 'auto';
    element.style.height = `${Math.min(190, Math.max(56, element.scrollHeight))}px`;
  }, [workspace.draft.text]);
  useLayoutEffect(() => { textarea.current?.focus({ preventScroll: true }); }, [workspace.focusVersion]);
  const files = (list: FileList | null) => {
    if (list?.length) void workspace.uploadFiles(Array.from(list)).then(() => workspace.focusComposer());
  };
  return <div className="composer">
    {error && <div className="chat-error" role="alert">{error}</div>}
    {workspace.uploads.length > 0 && <ul className="attachment-jobs" aria-label="附件导入状态">
      {workspace.uploads.map((job) => <li key={job.id}>
        <div><strong>{job.name}</strong><span role={job.status === 'failed' ? 'alert' : 'status'}>{job.status === 'uploading' ? '正在导入…' : job.error}</span></div>
        {job.status === 'failed' && <><button type="button" onClick={() => void workspace.retryUpload(job.id)}>重试</button><button type="button" aria-label={`移除附件${job.name}`} onClick={() => workspace.dismissUpload(job.id)}>移除</button></>}
      </li>)}
    </ul>}
    {workspace.draft.refs.length > 0 && <div className="quoted" aria-label="本次引用">{workspace.draft.refs.map((ref) => <ChatReference key={`${ref.type}-${ref.id}`} reference={ref} open={open} remove={() => workspace.removeRef(ref.type, ref.id)} />)}</div>}
    <div className="composer-row">
      <button type="button" className="attachment-picker ghost" title="添加附件" aria-label="添加附件" onClick={() => picker.current?.click()}>＋</button>
      <input type="file" ref={picker} hidden multiple accept={ATTACHMENT_ACCEPT} aria-label="选择附件文件" onChange={(event) => { files(event.currentTarget.files); event.currentTarget.value = ''; }} />
      <textarea ref={textarea} aria-label="消息" value={workspace.draft.text} rows={2}
        placeholder={workspace.draft.refs.length ? '针对这些引用问点什么，也可以直接发送…' : `和${assistantName}说点什么…`}
        onChange={(event) => workspace.setText(event.target.value)}
        onPaste={(event) => { if (event.clipboardData.files.length) { event.preventDefault(); files(event.clipboardData.files); } }}
        onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing && event.nativeEvent.keyCode !== 229) { event.preventDefault(); if (!workspace.blocked && !busy) send(); } }} />
      {running ? <button type="button" onClick={stop} disabled={stopping}>{stopping ? '正在停止…' : '停止生成'}</button> : <button type="button" className="primary" onClick={send} disabled={busy || workspace.blocked || (!workspace.draft.text.trim() && !workspace.draft.refs.length)}>发送</button>}
    </div>
    <div className="composer-help"><span title={ATTACHMENT_ACCEPT}>支持图片、PDF、Word、Excel、PPT 和文本 · 单文件 25 MB</span><span>Enter 发送 · Shift + Enter 换行</span></div>
  </div>;
}
