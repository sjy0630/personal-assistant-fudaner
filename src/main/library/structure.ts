/** Mammoth 的文档树；锁定版本 1.13.0，升级时需跑结构测试。 */
export interface WordNode {
  type: string; children?: WordNode[]; value?: string; styleName?: string; styleId?: string;
  numbering?: { level: string | number; isOrdered: boolean }; isBold?: boolean; isItalic?: boolean;
  href?: string; altText?: string; colSpan?: number; rowSpan?: number;
}
const escape = (s: string) => s.replace(/([\\`*_\[\]<>|])/g, '\\$1');
function inline(node: WordNode): string {
  if (node.type === 'text') return escape(node.value ?? '');
  if (node.type === 'tab') return '    ';
  if (node.type === 'break') return '\n';
  if (node.type === 'image') return `[图片${node.altText ? `：${escape(node.altText)}` : ''}]`;
  let text = (node.children ?? []).map(inline).join('');
  if (node.type === 'run' && text.trim()) {
    if (node.isBold) text = `**${text}**`;
    if (node.isItalic) text = `*${text}*`;
  }
  if (node.type === 'hyperlink' && /^https?:\/\/[^\s)]+$/.test(node.href ?? '')) text = `[${text}](${node.href})`;
  return text;
}
export function wordToMarkdown(node: WordNode): string {
  if (node.type === 'paragraph') {
    const text = (node.children ?? []).map(inline).join('').trim().replace(/\*\*\*\*/g, '');
    if (!text) return '';
    const heading = `${node.styleName ?? ''} ${node.styleId ?? ''}`.match(/(?:heading\s*|标题\s*)([1-6])/i);
    if (heading) return `${'#'.repeat(Number(heading[1]))} ${text}`;
    if (/^(title|标题)$/i.test(node.styleName ?? '')) return `# ${text}`;
    if (node.numbering) return `${'  '.repeat(Math.min(8, Number(node.numbering.level) || 0))}${node.numbering.isOrdered ? '1.' : '-'} ${text}`;
    return text;
  }
  if (node.type === 'table') {
    const rows = (node.children ?? []).map((row) => (row.children ?? []).flatMap((cell) => {
      const text = (cell.children ?? []).map(wordToMarkdown).filter(Boolean).join(' / ').replace(/\n/g, ' ');
      return [text, ...Array.from({ length: Math.max(0, (cell.colSpan ?? 1) - 1) }, () => '')];
    }));
    const width = Math.max(0, ...rows.map((r) => r.length));
    if (!width) return '';
    const line = (r: string[]) => `| ${Array.from({ length: width }, (_, i) => r[i] ?? '').join(' | ')} |`;
    return [line(rows[0]), line(Array(width).fill('---')), ...rows.slice(1).map(line)].join('\n');
  }
  const children = node.children ?? [];
  return children.map(wordToMarkdown).filter(Boolean).join('\n\n').replace(/(\n)\n(?=\s*(?:- |1\. ))/g, '$1');
}

export interface PdfTextItem { str: string; transform: number[]; width: number; height: number }
interface PdfLine { y: number; x: number; end: number; size: number; text: string }
export interface PdfOperators { fnArray: number[]; argsArray: unknown[][] }
interface PdfTable { top: number; bottom: number; left: number; right: number; text: string }
interface PdfLayout { tables: PdfTable[]; markers: { x: number; y: number }[] }

/** 识别有重复横线分段的表格；无可靠边界时保留普通文本。 */
export function pdfLayout(items: PdfTextItem[], ops: PdfOperators): PdfLayout {
  type Matrix = number[];
  let matrix: Matrix = [1, 0, 0, 1, 0, 0];
  const stack: Matrix[] = [];
  const rules: { y: number; left: number; right: number }[] = [];
  const markers: PdfLayout['markers'] = [];
  const pageLeft = Math.min(...items.filter((t) => t.str.trim()).map((t) => t.transform[4]));
  const point = (x: number, y: number) => [matrix[0] * x + matrix[2] * y + matrix[4], matrix[1] * x + matrix[3] * y + matrix[5]];
  for (let i = 0; i < ops.fnArray.length; i++) {
    const op = ops.fnArray[i], args = ops.argsArray[i];
    // PDF.js 1.10.100 OPS：save / restore / transform / constructPath / rectangle。
    if (op === 10) stack.push([...matrix]);
    if (op === 11) matrix = stack.pop() ?? matrix;
    if (op === 12) {
      const b = args as number[], a = matrix;
      matrix = [a[0]*b[0]+a[2]*b[1], a[1]*b[0]+a[3]*b[1], a[0]*b[2]+a[2]*b[3], a[1]*b[2]+a[3]*b[3], a[0]*b[4]+a[2]*b[5]+a[4], a[1]*b[4]+a[3]*b[5]+a[5]];
    }
    if (op !== 91) continue;
    const commands = args[0] as number[], coordinates = args[1] as number[];
    if (commands.length >= 6 && commands[0] === 13 && commands[commands.length-1] === 18 && commands.slice(1,-1).every((c) => c === 15)) {
      const points = Array.from({ length: coordinates.length / 2 }, (_, n) => point(coordinates[n*2], coordinates[n*2+1]));
      const xs = points.map((p) => p[0]), ys = points.map((p) => p[1]);
      const x = Math.min(...xs), y = Math.min(...ys), w = Math.max(...xs)-x, h = Math.max(...ys)-y;
      if (w >= 3 && w <= 18 && h >= 3 && h <= 18 && Math.abs(w-h) < 2 && x < pageLeft + 24) markers.push({ x: x + w, y: y + h/2 });
    }
    if (!commands.every((c) => c === 19)) continue;
    for (let n = 0; n < coordinates.length; n += 4) {
      const [x, y, width, height] = coordinates.slice(n, n + 4);
      const p = point(x, y), q = point(x + width, y + height);
      if (Math.abs(q[1] - p[1]) <= 2 && Math.abs(q[0] - p[0]) > 15) rules.push({ y: (p[1] + q[1]) / 2, left: Math.min(p[0], q[0]), right: Math.max(p[0], q[0]) });
    }
  }
  const levels: { y: number; cuts: number[] }[] = [];
  for (const rule of rules.sort((a, b) => b.y - a.y || a.left - b.left)) {
    const level = levels.find((r) => Math.abs(r.y - rule.y) < 2);
    if (level) level.cuts.push(rule.left, rule.right); else levels.push({ y: rule.y, cuts: [rule.left, rule.right] });
  }
  const grids = levels.map((r) => ({ y: r.y, cuts: r.cuts.sort((a,b) => a-b).filter((v,i,a) => !i || v-a[i-1] > 2) })).filter((r) => r.cuts.length >= 3 && r.cuts[r.cuts.length-1]-r.cuts[0] > 200 && r.cuts[0] < pageLeft + 40);
  const result: PdfTable[] = [];
  for (let i = 0; i < grids.length;) {
    const first = grids[i];
    const matching = [first]; i++;
    while (i < grids.length && grids[i].cuts.length === first.cuts.length && grids[i].cuts.every((c,n) => Math.abs(c-first.cuts[n]) < 3) && matching[matching.length-1].y - grids[i].y < 130) matching.push(grids[i++]);
    const left = first.cuts[0], right = first.cuts[first.cuts.length-1];
    const above = items.filter((t) => t.str.trim() && t.transform[4] >= left && t.transform[4] < right && t.transform[5] > first.y && t.transform[5] < first.y + 30);
    const headerColumns = new Set(above.map((t) => first.cuts.findIndex((cut, n) => n < first.cuts.length-1 && t.transform[4] >= cut && t.transform[4] < first.cuts[n+1])));
    const top = headerColumns.size >= 2 ? Math.max(...above.map((t) => t.transform[5] + Math.abs(t.height || 12))) + 1 : first.y;
    const boundaries = top > first.y ? [top, ...matching.map((r) => r.y)] : matching.map((r) => r.y);
    // Markdown 导出的表格常常没有最后一条底边，末行以其后的标题或空白为边界。
    const last = matching[matching.length - 1].y;
    const sizes = items.filter((t) => t.str.trim()).map((t) => Math.abs(t.height || 12)).sort((a,b) => a-b);
    const bodySize = sizes[Math.floor(sizes.length / 2)] || 12;
    const nextHeading = items.filter((t) => t.str.trim() && t.transform[5] < last - 2 && Math.abs(t.height) > bodySize * 1.25).sort((a,b) => b.transform[5]-a.transform[5])[0];
    const lower = Math.max(last - 110, nextHeading ? nextHeading.transform[5] + Math.abs(nextHeading.height) + 3 : 0, grids[i]?.y ?? 0);
    const below = items.filter((t) => t.str.trim() && t.transform[4] >= left && t.transform[4] < right && t.transform[5] < last - 2 && t.transform[5] > lower);
    const columnsBelow = new Set(below.map((t) => first.cuts.findIndex((cut, n) => n < first.cuts.length-1 && t.transform[4] >= cut && t.transform[4] < first.cuts[n+1])));
    if (columnsBelow.size >= 2) {
      // 仅延伸至连续文字块的末尾，避免吸入后面的正文。
      const ys = [...new Set(below.map((t) => t.transform[5]))].sort((a,b) => b-a);
      let bottom = ys[0];
      for (const y of ys.slice(1)) { if (bottom-y > bodySize * 2.4) break; bottom = y; }
      boundaries.push(bottom - 2);
    }
    if (boundaries.length < 3) continue;
    const rows: string[][] = [];
    for (let r = 0; r < boundaries.length-1; r++) {
      rows.push(first.cuts.slice(0,-1).map((cut,c) => {
        const cell = items.filter((t) => t.transform[4] >= cut - 1 && t.transform[4] < first.cuts[c+1] - 1 && t.transform[5] < boundaries[r] && t.transform[5] > boundaries[r+1]);
        const lines: { y: number; text: string; end: number }[] = [];
        for (const t of cell.sort((a,b) => b.transform[5]-a.transform[5] || a.transform[4]-b.transform[4])) {
          let line = lines.find((l) => Math.abs(l.y-t.transform[5]) < 3);
          if (!line) { line = { y: t.transform[5], text: '', end: t.transform[4] }; lines.push(line); }
          if (line.text && t.transform[4]-line.end > 1.5 && !/\s$/.test(line.text)) line.text += ' ';
          line.text += t.str; line.end = t.transform[4] + t.width;
        }
        const text = lines.map((l) => l.text.trim()).reduce((a,b) => a + (/[A-Za-z0-9]$/.test(a) && /^[A-Za-z0-9]/.test(b) && !/[.@]/.test(a) ? ' ' : '') + b, '');
        return text.replace(/\|/g,'\\|');
      }));
    }
    if (rows.length < 2) continue;
    const row = (cells: string[]) => `| ${cells.join(' | ')} |`;
    result.push({ top, bottom: boundaries[boundaries.length-1], left, right, text: [row(rows[0]), row(first.cuts.slice(1).map(() => '---')), ...rows.slice(1).map(row)].join('\n') });
  }
  return { tables: result, markers };
}
/** 按坐标还原行，依据行距与字号恢复段落；不猜测缺失内容。 */
export function pdfPageToMarkdown(items: PdfTextItem[], pageNumber: number, layout: PdfLayout = { tables: [], markers: [] }): string {
  const { tables, markers } = layout;
  const visible = items.filter((item) => item.str.trim() && item.transform?.length >= 6 && !tables.some((t) => item.transform[4] >= t.left - 1 && item.transform[4] < t.right && item.transform[5] < t.top && item.transform[5] > t.bottom));
  const rows: { y: number; items: PdfTextItem[] }[] = [];
  for (const item of [...visible].sort((a, b) => b.transform[5] - a.transform[5] || a.transform[4] - b.transform[4])) {
    const y = item.transform[5];
    const size = Math.abs(item.height || item.transform[3]) || 12;
    const row = rows.find((r) => Math.abs(r.y - y) <= Math.min(3, size * 0.22));
    if (row) row.items.push(item); else rows.push({ y, items: [item] });
  }
  const lines: PdfLine[] = rows.map((row) => {
    const parts = row.items.sort((a, b) => a.transform[4] - b.transform[4]);
    let text = '', end = parts[0].transform[4];
    for (const part of parts) {
      const size = Math.abs(part.height || part.transform[3]) || 12;
      const gap = part.transform[4] - end;
      if (text && !/\s$/.test(text) && !/^\s/.test(part.str) && gap > size * 0.15) text += gap > size * 2 ? '    ' : ' ';
      text += part.str; end = part.transform[4] + part.width;
    }
    return { y: row.y, x: parts[0].transform[4], end, size: Math.max(...parts.map((p) => Math.abs(p.height || p.transform[3]) || 12)), text: text.trim() };
  });
  if (!lines.length && !tables.length) return `> 第 ${pageNumber} 页：未提取到文字（可能为扫描页或图片）。`;
  const sizes = items.filter((p) => p.str.trim()).map((p) => Math.abs(p.height || p.transform[3]) || 12).sort((a, b) => a - b);
  const bodySize = sizes[Math.floor(sizes.length / 2)] || 12;
  lines.push(...tables.map((t) => ({ y: t.top, x: t.left, end: t.right, size: bodySize, text: t.text })));
  lines.sort((a,b) => b.y-a.y);
  const gaps = lines.slice(1).map((l, i) => lines[i].y - l.y).filter((g) => g > bodySize * 0.8 && g < bodySize * 3).sort((a, b) => a - b);
  const lineGap = gaps[Math.floor(gaps.length * 0.25)] || bodySize * 1.3;
  const blocks: string[] = [];
  let paragraph = '';
  const flush = () => { if (paragraph) blocks.push(paragraph); paragraph = ''; };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const prev = lines[i - 1];
    if (line.text.startsWith('| ') && line.text.includes('\n')) { flush(); blocks.push(line.text); continue; }
    const heading = line.text.length < 100 && line.size >= bodySize * 1.25;
    const marker = markers.some((m) => Math.abs(m.x-line.x) < bodySize * 1.5 && Math.abs(m.y-line.y-bodySize * 0.35) < bodySize * 0.8);
    const list = line.text.match(/^(?:[•●▪·]\s*|([-*]|\d+[.)、])\s+)(.+)$/);
    if (marker) { flush(); paragraph = `- ${line.text}`; continue; }
    if (heading || list || /\s{3,}/.test(line.text)) {
      flush();
      if (heading) blocks.push(`${line.size >= bodySize * 1.65 ? '##' : '###'} ${line.text}`);
      else if (list) blocks.push(`${/^\d/.test(list[1] ?? '') ? '1.' : '-'} ${list[2]}`);
      else blocks.push(line.text);
      continue;
    }
    if (prev && (prev.y - line.y > lineGap * 1.15 || Math.abs(prev.x - line.x) > bodySize * 1.5 || /[。！？!?：:]$/.test(prev.text))) flush();
    if (paragraph && /[A-Za-z0-9,;:]$/.test(paragraph) && /^[A-Za-z0-9]/.test(line.text)) paragraph += ' ';
    paragraph += line.text;
  }
  flush();
  return `> 第 ${pageNumber} 页\n\n${blocks.join('\n\n')}`;
}
