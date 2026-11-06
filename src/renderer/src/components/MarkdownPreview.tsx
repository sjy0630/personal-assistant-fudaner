import { Fragment, type ReactNode } from 'react';

/** 基础 Markdown 预览：用 React 节点渲染，不执行文档中的 HTML。 */
function inline(text: string): ReactNode[] {
  return text.split(/(\\[\\`*_\[\]<>|]|`[^`]+`|\*\*[^*]+\*\*|\*[^*\n]+\*|\[[^\]]+\]\(https?:\/\/[^\s)]+\))/g).map((part, i) => {
    if (/^\\[\\`*_\[\]<>|]$/.test(part)) return <Fragment key={i}>{part.slice(1)}</Fragment>;
    if (part.startsWith('`') && part.endsWith('`')) return <code key={i}>{part.slice(1, -1)}</code>;
    if (part.startsWith('**') && part.endsWith('**')) return <strong key={i}>{part.slice(2, -2)}</strong>;
    if (part.startsWith('*') && part.endsWith('*')) return <em key={i}>{part.slice(1, -1)}</em>;
    const link = part.match(/^\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)$/);
    if (link) return <a key={i} href={link[2]} target="_blank" rel="noopener noreferrer">{link[1]}</a>;
    return <Fragment key={i}>{part}</Fragment>;
  });
}
export function MarkdownPreview({ text }: { text: string }) {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const blocks: ReactNode[] = [];
  const cells = (line: string) => line.trim().replace(/^\|/, '').replace(/(?<!\\)\|$/, '').split(/(?<!\\)\|/).map((s) => s.trim());
  const isTable = (i: number) => i + 1 < lines.length && lines[i].includes('|') && /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(lines[i + 1]);
  const startsBlock = (line: string) => /^(#{1,6}\s|\s*```|\s*[-*+]\s|\s*\d+\.\s|>\s?|\s*([-*_])(?:\s*\2){2,}\s*$)/.test(line);
  for (let i = 0; i < lines.length;) {
    const line = lines[i];
    const key = i;
    if (!line.trim()) { i++; continue; }
    if (isTable(i)) {
      const headers = cells(line);
      const body: string[][] = []; i += 2;
      while (i < lines.length && lines[i].trim() && lines[i].includes('|')) body.push(cells(lines[i++]));
      blocks.push(<div className="markdown-table-wrap" key={key}><table><thead><tr>{headers.map((h, n) => <th key={n}>{inline(h)}</th>)}</tr></thead><tbody>{body.map((row, n) => <tr key={n}>{Array.from({ length: Math.max(headers.length, row.length) }, (_, c) => <td key={c}>{inline(row[c] ?? '')}</td>)}</tr>)}</tbody></table></div>); continue;
    }
    if (/^\s*```/.test(line)) {
      const language = line.trim().slice(3).trim();
      const code: string[] = []; i++;
      while (i < lines.length && !/^\s*```/.test(lines[i])) code.push(lines[i++]);
      if (i < lines.length) i++;
      blocks.push(<pre key={key} aria-label={language ? `${language}代码` : '代码块'}><code>{code.join('\n')}</code></pre>); continue;
    }
    const heading = line.match(/^(#{1,6})\s+(.+)$/);
    if (heading) {
      const content = inline(heading[2].replace(/\s+#+\s*$/, ''));
      const Heading = `h${heading[1].length}` as 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6';
      blocks.push(<Heading key={key}>{content}</Heading>); i++; continue;
    }
    if (/^\s*([-*_])(?:\s*\1){2,}\s*$/.test(line)) { blocks.push(<hr key={key} />); i++; continue; }
    if (/^>/.test(line)) {
      const quote: string[] = [];
      while (i < lines.length && /^>/.test(lines[i])) quote.push(lines[i++].replace(/^>\s?/, ''));
      blocks.push(<blockquote key={key}>{inline(quote.join('\n'))}</blockquote>); continue;
    }
    const ordered = /^\s*\d+\.\s+/.test(line);
    if (ordered || /^\s*[-*+]\s+/.test(line)) {
      const List = ordered ? 'ol' : 'ul';
      const pattern = ordered ? /^\s*\d+\.\s+/ : /^\s*[-*+]\s+/;
      const items: ReactNode[] = [];
      const indent = line.length - line.trimStart().length;
      const start = ordered ? Number(line.trim().match(/^\d+/)?.[0] ?? 1) : undefined;
      while (i < lines.length && pattern.test(lines[i]) && lines[i].length - lines[i].trimStart().length === indent) {
        const content = lines[i++].replace(pattern, '');
        const task = content.match(/^\[([ xX])\]\s+(.*)$/);
        const children: string[] = [];
        while (i < lines.length && lines[i].trim() && lines[i].length - lines[i].trimStart().length > indent) children.push(lines[i++].slice(indent + 2));
        items.push(<li key={i}>{task ? <><input type="checkbox" checked={task[1] !== ' '} disabled aria-label={task[2]} /> {inline(task[2])}</> : inline(content)}{children.length > 0 && <MarkdownPreview text={children.join('\n')} />}</li>);
      }
      blocks.push(<List key={key} start={start}>{items}</List>); continue;
    }
    const paragraph = [line]; i++;
    while (i < lines.length && lines[i].trim() && !startsBlock(lines[i]) && !isTable(i)) paragraph.push(lines[i++]);
    blocks.push(<p key={key}>{inline(paragraph.join('\n'))}</p>);
  }
  return <div className="markdown-preview">{blocks}</div>;
}
