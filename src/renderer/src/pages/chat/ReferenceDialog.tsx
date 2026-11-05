import { useEffect, useRef } from 'react';
import type { CardRef, ReferenceDetail } from '../../../../shared/types';
import { ChatReference } from './ChatReference';
import { ChatMarkdown } from './ChatMarkdown';

export function ReferenceDialog({ detail, close, open, quote, error }: { detail: ReferenceDetail; close: () => void; open: (ref: CardRef) => void; quote?: () => void; error?: string }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    return () => { if (element?.open) element.close(); };
  }, []);
  const finish = (action: () => void) => { dialog.current?.close(); action(); };
  return <dialog className="reference-dialog" ref={dialog} onCancel={(event) => { event.preventDefault(); finish(close); }} onClick={(event) => { if (event.target === event.currentTarget) finish(close); }} aria-labelledby="reference-detail-title">
    <header><div><div className="muted small">{detail.label}</div><h2 id="reference-detail-title">{detail.title}</h2></div><button type="button" aria-label="关闭详情" onClick={() => finish(close)} autoFocus>×</button></header>
    {detail.fields && <dl>{detail.fields.map((field, index) => <div key={`${field.label}-${index}`}><dt>{field.label}</dt><dd>{field.value}</dd></div>)}</dl>}
    <div className="reference-detail-body"><ChatMarkdown text={detail.body || '暂时没有正文。'} /></div>
    {!!detail.related?.length && <div className="cards">{detail.related.map((ref) => <ChatReference key={`${ref.type}-${ref.id}`} reference={ref} open={open} />)}</div>}
    {error && <p className="chat-error" role="alert">{error}</p>}
    {quote && <footer><button type="button" onClick={() => finish(quote)}>引用到对话</button></footer>}
  </dialog>;
}
