import type { CardRef } from '../../../shared/types';

const ICON: Record<CardRef['type'], string> = { item: '📝', goal: '🎯', task: '☑️', resource: '📄', feed: '📰', ticket: '⚙️' };

/** 卡片 / 引用标签：消息里的卡片、输入框上方的引用都用它 */
export function RefChip({ r, card, onRemove }: { r: CardRef; card?: boolean; onRemove?: () => void }) {
  return (
    <span className={card ? 'ref card' : 'ref'}>
      <span>{ICON[r.type]}</span>
      <span className="ref-title">{r.title}</span>
      {r.subtitle && <span className="muted">· {r.subtitle}</span>}
      {onRemove && <button className="x" onClick={onRemove}>✕</button>}
    </span>
  );
}
