import * as XLSX from 'xlsx';
import { inflateRawSync } from 'node:zlib';

const MAX_FILE_BYTES = 25 * 1024 * 1024;
const MAX_EXPANDED_BYTES = 80 * 1024 * 1024;
const MAX_CELLS = 50_000;
const MAX_TEXT_LENGTH = 1_000_000;
const MAX_TABLE_SLOTS = 100_000;
const CFB_SIGNATURE = Buffer.from('d0cf11e0a1b11ae1', 'hex');
const INVALID_FILE = '无法读取 Excel 电子表格：文件格式无效或内容已损坏，请用 Excel 重新保存后再导入。';
const ENCRYPTED_FILE = '此 Excel 文件已加密或受密码保护，请先移除密码并另存后再导入。';

function validateZipExtras(buffer: Buffer, start: number, length: number): void {
  const end = start + length;
  while (start < end) {
    if (start + 4 > end) throw new Error(INVALID_FILE);
    const type = buffer.readUInt16LE(start);
    const size = buffer.readUInt16LE(start + 2);
    // SheetJS lets ZIP64 extras override both local and central sizes, even without sentinel fields.
    if (type === 1) throw new Error('暂不支持 ZIP64 Excel 文件，请用 Excel 另存为普通 XLSX 后再导入。');
    start += 4 + size;
    if (start > end) throw new Error(INVALID_FILE);
  }
}

/** Validate every size SheetJS uses before it can allocate or inflate, including local headers and ZIP64 overrides. */
function validateXlsxContainer(buffer: Buffer): Buffer {
  let end = -1;
  for (let position = buffer.length - 22; position >= Math.max(0, buffer.length - 65_557); position--) {
    if (buffer.readUInt32LE(position) === 0x06054b50 && position + 22 + buffer.readUInt16LE(position + 20) === buffer.length) {
      end = position;
      break;
    }
  }
  if (end < 0 || buffer.lastIndexOf(Buffer.from('504b0506', 'hex')) !== end) throw new Error(INVALID_FILE);
  const count = buffer.readUInt16LE(end + 10);
  const centralSize = buffer.readUInt32LE(end + 12);
  const centralStart = buffer.readUInt32LE(end + 16);
  let position = centralStart;
  if (buffer.readUInt16LE(end + 4) !== 0 || buffer.readUInt16LE(end + 6) !== 0
    || buffer.readUInt16LE(end + 8) !== count || count === 0xffff || centralSize === 0xffffffff
    || position + centralSize !== end || count > 10_000) throw new Error(INVALID_FILE);
  let expanded = 0;
  let hasWorkbook = false;
  let hasTypes = false;
  let normalized = buffer;
  const localRanges: Array<{ start: number; end: number }> = [];
  for (let index = 0; index < count; index++) {
    if (position + 46 > end || buffer.readUInt32LE(position) !== 0x02014b50) throw new Error(INVALID_FILE);
    const flags = buffer.readUInt16LE(position + 8);
    const method = buffer.readUInt16LE(position + 10);
    const crc = buffer.readUInt32LE(position + 16);
    const compressed = buffer.readUInt32LE(position + 20);
    const size = buffer.readUInt32LE(position + 24);
    const local = buffer.readUInt32LE(position + 42);
    if (flags & 0x2041) throw new Error(ENCRYPTED_FILE);
    if ((method !== 0 && method !== 8) || compressed === 0xffffffff || local === 0xffffffff
      || buffer.readUInt16LE(position + 34) !== 0) throw new Error(INVALID_FILE);
    expanded += size;
    if (size === 0xffffffff || expanded > MAX_EXPANDED_BYTES) throw new Error('Excel 文件解压后过大（超过 80 MB），请拆分工作簿后再导入。');
    const nameLength = buffer.readUInt16LE(position + 28);
    const extraLength = buffer.readUInt16LE(position + 30);
    const next = position + 46 + nameLength + extraLength + buffer.readUInt16LE(position + 32);
    if (next > end) throw new Error(INVALID_FILE);
    validateZipExtras(buffer, position + 46 + nameLength, extraLength);
    if (local + 30 > centralStart || buffer.readUInt32LE(local) !== 0x04034b50) throw new Error(INVALID_FILE);
    const localFlags = buffer.readUInt16LE(local + 6);
    const localMethod = buffer.readUInt16LE(local + 8);
    const localCrc = buffer.readUInt32LE(local + 14);
    const localCompressed = buffer.readUInt32LE(local + 18);
    const localSize = buffer.readUInt32LE(local + 22);
    const localNameLength = buffer.readUInt16LE(local + 26);
    const localExtraLength = buffer.readUInt16LE(local + 28);
    const dataStart = local + 30 + localNameLength + localExtraLength;
    const dataEnd = dataStart + compressed;
    if (localFlags !== flags || localMethod !== method || localNameLength !== nameLength
      || dataEnd > centralStart || localCompressed === 0xffffffff || localSize === 0xffffffff
      || !buffer.subarray(local + 30, local + 30 + localNameLength).equals(buffer.subarray(position + 46, position + 46 + nameLength))) {
      throw new Error(INVALID_FILE);
    }
    validateZipExtras(buffer, local + 30 + localNameLength, localExtraLength);
    let localEnd = dataEnd;
    if (flags & 8) {
      if ((localCrc !== 0 && localCrc !== crc) || (localCompressed !== 0 && localCompressed !== compressed)
        || (localSize !== 0 && localSize !== size)) throw new Error(INVALID_FILE);
      if (localEnd + 12 > centralStart) throw new Error(INVALID_FILE);
      if (buffer.readUInt32LE(localEnd) === 0x08074b50) localEnd += 4;
      if (localEnd + 12 > centralStart || buffer.readUInt32LE(localEnd) !== crc
        || buffer.readUInt32LE(localEnd + 4) !== compressed || buffer.readUInt32LE(localEnd + 8) !== size) throw new Error(INVALID_FILE);
      localEnd += 12;
      // Standard streaming ZIP headers may contain zero placeholders. Give SheetJS the verified sizes instead.
      if (normalized === buffer) normalized = Buffer.from(buffer);
      normalized.writeUInt32LE(crc, local + 14);
      normalized.writeUInt32LE(compressed, local + 18);
      normalized.writeUInt32LE(size, local + 22);
    } else if (localCrc !== crc || localCompressed !== compressed || localSize !== size) throw new Error(INVALID_FILE);
    localRanges.push({ start: local, end: localEnd });
    if (method === 0) {
      if (compressed !== size) throw new Error(INVALID_FILE);
    } else {
      try {
        // The native cap also rejects payloads whose actual expansion exceeds mutually matching false headers.
        const result = inflateRawSync(buffer.subarray(dataStart, dataEnd), { maxOutputLength: Math.max(1, size), info: true }) as unknown as {
          buffer: Buffer; engine: { bytesWritten: number };
        };
        if (result.buffer.length !== size || result.engine.bytesWritten !== compressed) throw new Error(INVALID_FILE);
      } catch { throw new Error(INVALID_FILE); }
    }
    const name = buffer.subarray(position + 46, position + 46 + nameLength).toString('utf8');
    hasWorkbook ||= name === 'xl/workbook.xml';
    hasTypes ||= name === '[Content_Types].xml';
    position = next;
  }
  if (position !== end || !hasWorkbook || !hasTypes) throw new Error(INVALID_FILE);
  localRanges.sort((left, right) => left.start - right.start);
  if (localRanges[0]?.start !== 0 || localRanges.some((range, index) => index > 0 && range.start < localRanges[index - 1].end)) throw new Error(INVALID_FILE);
  return normalized;
}

function escapeMarkdown(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/([\\|`*_{}\[\]()#!~])/g, '\\$1').replace(/\r\n|\r|\n/g, '<br>');
}

function cellText(cell: XLSX.CellObject): string {
  // SheetJS reads cached values and formula source; it does not recalculate formulas.
  const hasValue = cell.v !== undefined && cell.v !== null && cell.t !== 'z';
  const value = hasValue ? (cell.w ?? XLSX.utils.format_cell(cell)) : '';
  return escapeMarkdown(cell.f ? `${hasValue ? value : '无缓存结果'}（公式：=${cell.f}）` : value);
}

type LocatedCell = { address: string; row: number; column: number; text: string };

/** Extract XLSX / BIFF XLS as Markdown with original coordinates, without executing formulae or macros. */
function readSpreadsheet(buffer: Buffer, extension: string): XLSX.WorkBook {
  const ext = extension.toLowerCase();
  if (ext !== '.xlsx' && ext !== '.xls') throw new Error(`暂不支持的 Excel 文件类型：${extension}（支持 XLSX、XLS）。`);
  if (buffer.length > MAX_FILE_BYTES) throw new Error('Excel 文件过大（超过 25 MB），请拆分工作簿后再导入。');
  const isCfb = buffer.subarray(0, 8).equals(CFB_SIGNATURE);
  if (isCfb && buffer.includes(Buffer.from('EncryptedPackage', 'utf16le'))) throw new Error(ENCRYPTED_FILE);
  let input = buffer;
  if (ext === '.xlsx') {
    if (buffer.length < 4 || buffer.readUInt32LE(0) !== 0x04034b50) throw new Error(INVALID_FILE);
    input = validateXlsxContainer(buffer);
  } else if (!isCfb) throw new Error(INVALID_FILE);

  let workbook: XLSX.WorkBook;
  try {
    workbook = XLSX.read(input, {
      type: 'buffer', dense: false, cellFormula: true, cellText: true, cellNF: true,
      cellHTML: false, cellDates: false, sheetStubs: true, bookVBA: false, WTF: true,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(/password|encrypt|filepass/i.test(message) ? ENCRYPTED_FILE : INVALID_FILE);
  }
  if (!workbook.SheetNames?.length || !workbook.Sheets) throw new Error(INVALID_FILE);
  return workbook;
}

export function parseSpreadsheet(buffer: Buffer, extension: string): { mime: string; text: string } {
  const ext = extension.toLowerCase();
  const workbook = readSpreadsheet(buffer, extension);

  const parts: string[] = [];
  let textLength = 0;
  let totalCells = 0;
  const append = (line: string): void => {
    textLength += line.length + 1;
    if (textLength > MAX_TEXT_LENGTH) throw new Error('Excel 正文超过 1,000,000 字符，文本过长，请拆分工作簿后再导入。');
    parts.push(line);
  };
  for (const name of workbook.SheetNames) {
    const sheet = workbook.Sheets[name];
    if (!sheet) throw new Error(INVALID_FILE);
    append(`## 工作表：${escapeMarkdown(name)}`);
    append('');
    const cells: LocatedCell[] = [];
    for (const address of Object.keys(sheet)) {
      if (!/^[A-Z]+[1-9]\d*$/.test(address)) continue;
      const cell = sheet[address] as XLSX.CellObject;
      if (!cell || (cell.v == null && !cell.f) || (cell.t === 'z' && !cell.f)) continue;
      if (++totalCells > MAX_CELLS) throw new Error('Excel 单元格数量过多（超过 50,000 个），请拆分工作簿后再导入。');
      const { r, c } = XLSX.utils.decode_cell(address);
      if (r > 1_048_575 || c > 16_383 || r < 0 || c < 0) throw new Error(INVALID_FILE);
      cells.push({ address, row: r, column: c, text: cellText(cell) });
    }
    cells.sort((left, right) => left.row - right.row || left.column - right.column);
    if (!cells.length) {
      append('（空工作表）');
      append('');
      continue;
    }
    const rows = [...new Set(cells.map((cell) => cell.row))];
    const columns = [...new Set(cells.map((cell) => cell.column))].sort((left, right) => left - right);
    // A diagonal or far-apart sparse sheet must not create a rows × columns allocation.
    if (rows.length * columns.length > MAX_TABLE_SLOTS) {
      append('| 单元格 | 内容 |');
      append('| --- | --- |');
      for (const cell of cells) append(`| ${cell.address} | ${cell.text} |`);
    } else {
      append(`| 行号 | ${columns.map((column) => XLSX.utils.encode_col(column)).join(' | ')} |`);
      append(`| --- | ${columns.map(() => '---').join(' | ')} |`);
      const values = new Map(cells.map((cell) => [cell.address, cell.text]));
      for (const row of rows) {
        append(`| ${row + 1} | ${columns.map((column) => values.get(XLSX.utils.encode_cell({ r: row, c: column })) ?? '').join(' | ')} |`);
      }
    }
    append('');
  }
  return {
    mime: ext === '.xlsx' ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' : 'application/vnd.ms-excel',
    text: parts.join('\n').trim(),
  };
}

export function spreadsheetPreview(buffer: Buffer, extension: string): import('../../shared/types').SpreadsheetPreview {
  const workbook = readSpreadsheet(buffer, extension);
  return { sheets: workbook.SheetNames.map((name) => {
    const sheet = workbook.Sheets[name];
    if (!sheet?.['!ref']) return { name, startRow: 0, startColumn: 0, rows: [], merges: [], truncated: false };
    const range = XLSX.utils.decode_range(sheet['!ref']);
    const endRow = Math.min(range.e.r, range.s.r + 199);
    const endColumn = Math.min(range.e.c, range.s.c + 49);
    const rows = [];
    for (let r = range.s.r; r <= endRow; r++) {
      const row = [];
      for (let c = range.s.c; c <= endColumn; c++) {
        const cell = sheet[XLSX.utils.encode_cell({ r, c })] as XLSX.CellObject | undefined;
        row.push({ text: cell ? String(cell.w ?? (cell.v != null ? XLSX.utils.format_cell(cell) : '')) : '', formula: cell?.f });
      }
      rows.push(row);
    }
    const merges = (sheet['!merges'] ?? []).filter((m) => m.s.r <= endRow && m.e.r >= range.s.r && m.s.c <= endColumn && m.e.c >= range.s.c)
      .map((m) => ({ startRow: Math.max(range.s.r, m.s.r) - range.s.r, startColumn: Math.max(range.s.c, m.s.c) - range.s.c,
        rows: Math.min(endRow, m.e.r) - Math.max(range.s.r, m.s.r) + 1,
        columns: Math.min(endColumn, m.e.c) - Math.max(range.s.c, m.s.c) + 1 }));
    return { name, startRow: range.s.r, startColumn: range.s.c, rows, merges,
      truncated: endRow < range.e.r || endColumn < range.e.c };
  }) };
}
