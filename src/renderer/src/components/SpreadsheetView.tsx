import { useEffect, useState } from 'react';
import type { SpreadsheetPreview } from '../../../shared/types';
import { api } from '../api';
function columnLabel(index: number): string {
  let label = '';
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) label = String.fromCharCode(65 + (n - 1) % 26) + label;
  return label;
}
export function SpreadsheetView({ id }: { id: string }) {
  const [data, setData] = useState<SpreadsheetPreview | null>(null);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState(0);
  useEffect(() => {
    let active = true;
    void api.library.spreadsheet(id).then((result) => { if (active) setData(result); })
      .catch((e) => { if (active) setError(e instanceof Error ? e.message : '工作簿读取失败，请重新上传。'); });
    return () => { active = false; };
  }, [id]);
  if (error) return <p role="alert">{error}</p>;
  if (!data) return <p role="status">正在读取工作表…</p>;
  const sheet = data.sheets[selected];
  if (!sheet) return <p>工作簿没有可显示的工作表。</p>;
  const spans = new Map<string, { rows: number; columns: number }>();
  const covered = new Set<string>();
  for (const merge of sheet.merges) {
    spans.set(`${merge.startRow}:${merge.startColumn}`, merge);
    for (let r = merge.startRow; r < merge.startRow + merge.rows; r++) {
      for (let c = merge.startColumn; c < merge.startColumn + merge.columns; c++) {
        if (r !== merge.startRow || c !== merge.startColumn) covered.add(`${r}:${c}`);
      }
    }
  }
  return <div className="spreadsheet-preview">
    <div className="filters" role="group" aria-label="工作表">{data.sheets.map((s, i) => <button key={i} className={i === selected ? 'chip active' : 'chip'} aria-pressed={i === selected} onClick={() => setSelected(i)}>{s.name}</button>)}</div>
    <p className="muted small">只读预览 · 公式显示文件已保存的结果，鼠标停在单元格上可查看公式。图表、颜色和字体样式尚未还原。</p>
    {sheet.truncated && <p role="status">此工作表仅预览前 200 行、50 列，可切换文字阅读查看提取内容。</p>}
    {!sheet.rows.length ? <p>空工作表</p> : <div className="spreadsheet-scroll"><table aria-label={sheet.name}><thead><tr><th scope="col">行</th>{sheet.rows[0].map((_, c) => <th scope="col" key={c}>{columnLabel(sheet.startColumn + c)}</th>)}</tr></thead><tbody>{sheet.rows.map((row, r) => <tr key={r}><th scope="row">{sheet.startRow + r + 1}</th>{row.map((cell, c) => {
      const key = `${r}:${c}`;
      if (covered.has(key)) return null;
      const span = spans.get(key);
      return <td key={c} rowSpan={span?.rows} colSpan={span?.columns} title={cell.formula ? `=${cell.formula}` : undefined}>{cell.text || (cell.formula ? `=${cell.formula}` : '')}</td>;
    })}</tr>)}</tbody></table></div>}
  </div>;
}
