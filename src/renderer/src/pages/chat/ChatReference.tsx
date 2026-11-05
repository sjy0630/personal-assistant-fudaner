import type { CardRef } from '../../../../shared/types';

const ICON: Record<CardRef['type'], string> = { item: '📝', goal: '🎯', task: '☑', resource: '📄', feed: '📰', ticket: '⚙' };
export function ChatReference({ reference, card, open, remove, undo, undoDisabled, undoPending }: {
  reference: CardRef; card?: boolean; open: (reference: CardRef) => void;
  remove?: () => void; undo?: () => void; undoDisabled?: boolean; undoPending?: boolean;
}) {
  return <span className={`chat-reference${card ? ' chat-reference--card' : ''}${reference.undone ? ' chat-reference--undone' : ''}`}>
    <button type="button" className="reference-open" disabled={reference.undone} onClick={() => open(reference)} aria-label={`打开${reference.title}`}>
      <span aria-hidden="true">{ICON[reference.type]}</span><span>{reference.title}</span>
      {reference.subtitle && <span className="muted">{reference.subtitle}</span>}
      {reference.undone && <span>已撤销</span>}
    </button>
    {remove && <button type="button" className="reference-remove" aria-label={`移除引用${reference.title}`} onClick={remove}>×</button>}
    {undo && !reference.undone && <button type="button" className="reference-undo" disabled={undoDisabled} aria-label={`撤销${reference.title}`} onClick={undo}>{undoPending ? '处理中…' : '撤销'}</button>}
  </span>;
}
