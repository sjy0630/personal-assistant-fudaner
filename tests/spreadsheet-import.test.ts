import { describe, expect, it, vi } from 'vitest';
import * as XLSX from 'xlsx';
import { parseSpreadsheet, spreadsheetPreview } from '../src/main/library/spreadsheet';

it('网格预览保留工作表、合并范围、公式和空单元格', () => {
  const sheet = XLSX.utils.aoa_to_sheet([['标题', null, null], ['项目', '数量', '合计'], ['任务', 2, 6]]);
  sheet['!merges'] = [XLSX.utils.decode_range('A1:C1')];
  sheet.C3.f = 'B3*3';
  for (const ext of ['xlsx', 'xls'] as const) {
    const preview = spreadsheetPreview(workbookBuffer(ext, [['任务', sheet], ['空表', {}]]), `.${ext}`);
    expect(preview.sheets.map((s) => s.name)).toEqual(['任务', '空表']);
    expect(preview.sheets[0].merges[0]).toEqual({ startRow: 0, startColumn: 0, rows: 1, columns: 3 });
    expect(preview.sheets[0].rows[2][2].text).toBe('6');
    if (ext === 'xlsx') expect(preview.sheets[0].rows[2][2].formula).toBe('B3*3');
    expect(preview.sheets[0].rows[0][1].text).toBe('');
  }
});

it('网格预览对巨大稀疏范围显示裁剪提示', () => {
  const sheet = XLSX.utils.aoa_to_sheet([['开始']]);
  sheet.ZZ1000 = { t: 's', v: '末尾' }; sheet['!ref'] = 'A1:ZZ1000';
  const result = spreadsheetPreview(workbookBuffer('xlsx', [['稀疏', sheet]]), '.xlsx');
  expect(result.sheets[0].truncated).toBe(true);
  expect(result.sheets[0].rows).toHaveLength(200);
  expect(result.sheets[0].rows[0]).toHaveLength(50);
  const later = spreadsheetPreview(workbookBuffer('xlsx', [['稀疏', sheet]]), '.xlsx', 800, 650);
  expect(later.sheets[0].startRow).toBe(800);
  expect(later.sheets[0].startColumn).toBe(650);
  const last = spreadsheetPreview(workbookBuffer('xlsx', [['稀疏', sheet]]), '.xlsx', 800, 700);
  expect(last.sheets[0].rows[199][1].text).toBe('末尾');
  expect(last.sheets[0].truncated).toBe(false);
});

function workbookBuffer(bookType: 'xlsx' | 'xls', sheets: Array<[string, XLSX.WorkSheet]>, compression = false): Buffer {
  const workbook = XLSX.utils.book_new();
  for (const [name, sheet] of sheets) XLSX.utils.book_append_sheet(workbook, sheet, name);
  return XLSX.write(workbook, { type: 'buffer', bookType, compression });
}

function zipBuffer(files: Record<string, string>): Buffer {
  const archive = XLSX.CFB.utils.cfb_new();
  for (const [path, text] of Object.entries(files)) XLSX.CFB.utils.cfb_add(archive, path, Buffer.from(text));
  return XLSX.CFB.write(archive, { type: 'buffer', fileType: 'zip' });
}

/** Insert fixture metadata while retaining valid central-directory offsets for all real workbook entries. */
function insertZipBytes(source: Buffer, at: number, extra: Buffer): Buffer {
  const result = Buffer.concat([source.subarray(0, at), extra, source.subarray(at)]);
  const end = source.lastIndexOf(Buffer.from('504b0506', 'hex'));
  const central = source.readUInt32LE(end + 16);
  let position = central;
  for (let index = 0; index < source.readUInt16LE(end + 10); index++) {
    const local = source.readUInt32LE(position + 42);
    result.writeUInt32LE(local + (local >= at ? extra.length : 0), position + (position >= at ? extra.length : 0) + 42);
    position += 46 + source.readUInt16LE(position + 28) + source.readUInt16LE(position + 30) + source.readUInt16LE(position + 32);
  }
  result.writeUInt32LE(central + (at < central ? extra.length : 0), end + extra.length + 16);
  result.writeUInt32LE(source.readUInt32LE(end + 12) + (at >= central ? extra.length : 0), end + extra.length + 12);
  return result;
}

describe('Excel attachment text extraction', () => {
  for (const bookType of ['xlsx', 'xls'] as const) {
    it(`${bookType}: preserves sheet names, real row/column coordinates and formatted scalar values`, () => {
      const sheet: XLSX.WorkSheet = {
        B3: { t: 's', v: '项目' }, C3: { t: 's', v: '金额' }, D3: { t: 's', v: '日期' }, E3: { t: 's', v: '完成' },
        B4: { t: 's', v: '复旦课程' }, C4: { t: 'n', v: 1234.5, z: '#,##0.00' },
        D4: { t: 'n', v: 45292, z: 'yyyy-mm-dd' }, E4: { t: 'b', v: true },
        C5: { t: 'n', v: 0.125, z: '0.0%' }, E5: { t: 'b', v: false }, '!ref': 'B3:E5',
      };
      const result = parseSpreadsheet(workbookBuffer(bookType, [ ['预算', sheet], ['备注', XLSX.utils.aoa_to_sheet([['第二页正文']])] ]), `.${bookType}`);
      expect(result.mime).toBe(bookType === 'xlsx'
        ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
        : 'application/vnd.ms-excel');
      expect(result.text).toContain('工作表：预算');
      expect(result.text).toContain('| 行号 | B | C | D | E |');
      expect(result.text).toContain('| 3 | 项目 | 金额 | 日期 | 完成 |');
      expect(result.text).toContain('| 4 | 复旦课程 | 1,234.50 | 2024-01-01 | TRUE |');
      expect(result.text).toContain('| 5 |  | 12.5% |  | FALSE |');
      expect(result.text).toContain('工作表：备注');
      expect(result.text).toContain('第二页正文');
      expect(result.text).not.toContain('| 1 |  |');
    });
  }

  it('escapes Markdown and HTML in cells while preserving line breaks visibly', () => {
    const sheet = XLSX.utils.aoa_to_sheet([['a|b', '<script>alert(1)</script>\nnext', '[click](https://example.com)', '\\*bold*']]);
    const { text } = parseSpreadsheet(workbookBuffer('xlsx', [['表|格', sheet]]), '.XLSX');
    expect(text).toContain('表\\|格');
    expect(text).toContain('a\\|b');
    expect(text).toContain('&lt;script&gt;alert\\(1\\)&lt;/script&gt;<br>next');
    expect(text).toContain('\\[click\\]\\(https://example.com\\)');
    expect(text).toContain('\\\\\\*bold\\*');
    expect(text).not.toContain('<script>');
  });

  it('shows cached results and formula text, and marks uncached formula results without calculating', () => {
    const sheet: XLSX.WorkSheet = {
      A1: { t: 'n', v: 2 }, B1: { t: 'n', f: 'A1+1', v: 99 },
      C1: { t: 'n', f: 'SUM(A1:B1)' }, D1: { t: 'n', f: '1/0', v: 0 }, '!ref': 'A1:D1',
    };
    const { text } = parseSpreadsheet(workbookBuffer('xlsx', [['公式', sheet]]), '.xlsx');
    expect(text).toContain('99（公式：=A1+1）');
    expect(text).toContain('无缓存结果（公式：=SUM\\(A1:B1\\)）');
    expect(text).toContain('0（公式：=1/0）');
  });

  it('preserves BIFF XLS formulas and their cached result without recalculating', () => {
    // SheetJS writes BIFF formulas from precompiled tokens. This is the BIFF8 token stream for $A$1+1.
    const formulaCell: XLSX.CellObject & { bf: number[] } = { t: 'n', v: 99, bf: [9, 0, 0x44, 0, 0, 0, 0, 0x1e, 1, 0, 0x03] };
    const sheet: XLSX.WorkSheet = { A1: { t: 'n', v: 2 }, B1: formulaCell, '!ref': 'A1:B1' };
    const { text } = parseSpreadsheet(workbookBuffer('xls', [['旧公式', sheet]]), '.xls');
    expect(text).toContain('99（公式：=$A$1+1）');
  });

  it('handles a giant sparse range without filling the blank rectangle', () => {
    // Writing with a giant !ref would itself visit a huge rectangle; change only the XML dimension after creating a real workbook.
    const source = workbookBuffer('xlsx', [['稀疏', XLSX.utils.aoa_to_sheet([['起点']])]]);
    const archive = XLSX.CFB.read(source, { type: 'buffer' });
    const entry = XLSX.CFB.find(archive, '/xl/worksheets/sheet1.xml');
    const xml = Buffer.from(entry.content).toString().replace(/<dimension[^>]*\/>/, '<dimension ref="A1:XFD1048576"/>')
      .replace('</sheetData>', '<row r="1048576"><c r="XFD1048576" t="str"><v>终点</v></c></row></sheetData>');
    XLSX.CFB.utils.cfb_add(archive, '/xl/worksheets/sheet1.xml', Buffer.from(xml));
    const { text } = parseSpreadsheet(XLSX.CFB.write(archive, { type: 'buffer', fileType: 'zip' }), '.xlsx');
    expect(text).toContain('| 行号 | A | XFD |');
    expect(text).toContain('| 1 | 起点 |  |');
    expect(text).toContain('| 1048576 |  | 终点 |');
    expect(text.length).toBeLessThan(500);
  });

  it('uses cell coordinates for wide sparse data instead of creating a quadratic table', () => {
    const rows = Array.from({ length: 400 }, (_, index) => `<row r="${index + 1}"><c r="${XLSX.utils.encode_col(index)}${index + 1}" t="str"><v>值${index}</v></c></row>`).join('');
    const archive = XLSX.CFB.read(workbookBuffer('xlsx', [['对角', XLSX.utils.aoa_to_sheet([['first']])]]), { type: 'buffer' });
    const entry = XLSX.CFB.find(archive, '/xl/worksheets/sheet1.xml');
    const xml = Buffer.from(entry.content).toString().replace(/<sheetData>.*?<\/sheetData>/s, `<sheetData>${rows}</sheetData>`);
    XLSX.CFB.utils.cfb_add(archive, '/xl/worksheets/sheet1.xml', Buffer.from(xml));
    const { text } = parseSpreadsheet(XLSX.CFB.write(archive, { type: 'buffer', fileType: 'zip' }), '.xlsx');
    expect(text).toContain('| 单元格 | 内容 |');
    expect(text).toContain('| A1 | 值0 |');
    expect(text).toContain('| OJ400 | 值399 |');
    expect(text.length).toBeLessThan(15000);
  });

  it.each(['.xlsx', '.xls'])('rejects renamed text/HTML files for %s rather than treating them as spreadsheets', (extension) => {
    expect(() => parseSpreadsheet(Buffer.from('name,value\n预算,123'), extension)).toThrow(/Excel|电子表格/);
    expect(() => parseSpreadsheet(Buffer.from('<html><table><tr><td>伪装</td></tr></table></html>'), extension)).toThrow(/Excel|电子表格/);
  });

  it('rejects other ZIP documents and corrupt containers with a useful Chinese error', () => {
    expect(() => parseSpreadsheet(zipBuffer({ 'word/document.xml': '<document>Word</document>' }), '.xlsx')).toThrow(/Excel|电子表格/);
    expect(() => parseSpreadsheet(Buffer.from('504b0304000000', 'hex'), '.xlsx')).toThrow(/损坏|无法读取|无效/);
    expect(() => parseSpreadsheet(Buffer.from('d0cf11e0a1b11ae1', 'hex'), '.xls')).toThrow(/损坏|无法读取|无效/);
  });

  it('rejects encrypted Office containers with a password-specific Chinese explanation', () => {
    const container = XLSX.CFB.utils.cfb_new();
    XLSX.CFB.utils.cfb_add(container, '/EncryptedPackage', Buffer.from('encrypted payload'));
    XLSX.CFB.utils.cfb_add(container, '/EncryptionInfo', Buffer.from('encryption metadata'));
    const encrypted = XLSX.CFB.write(container, { type: 'buffer' });
    expect(() => parseSpreadsheet(encrypted, '.xlsx')).toThrow(/加密|密码/);
  });

  it('recognizes an XLS FILEPASS record as password protection', () => {
    const container = XLSX.CFB.read(workbookBuffer('xls', [['表', XLSX.utils.aoa_to_sheet([['正文']])]]), { type: 'buffer' });
    const entry = XLSX.CFB.find(container, '/Workbook');
    const workbookStream = Buffer.from(entry.content);
    const afterBof = 4 + workbookStream.readUInt16LE(2);
    // BIFF8 XOR FILEPASS record (encryption type, key and verifier); parsing must stop before reading worksheet content.
    const filePass = Buffer.from([0x2f, 0, 6, 0, 0, 0, 0, 0, 0, 0]);
    XLSX.CFB.utils.cfb_add(container, '/Workbook', Buffer.concat([workbookStream.subarray(0, afterBof), filePass, workbookStream.subarray(afterBof)]));
    expect(() => parseSpreadsheet(XLSX.CFB.write(container, { type: 'buffer' }), '.xls')).toThrow(/加密|密码/);
  });

  it('rejects inputs exceeding the populated-cell or output-text budget explicitly', () => {
    const cells = XLSX.utils.aoa_to_sheet(Array.from({ length: 251 }, () => Array(100).fill(1)));
    expect(() => parseSpreadsheet(workbookBuffer('xlsx', [['过大1', cells], ['过大2', cells]]), '.xlsx')).toThrow(/单元格.*过多|超过.*单元格/);
    const longText = XLSX.utils.aoa_to_sheet(Array.from({ length: 20 }, () => ['字'.repeat(30000)]));
    expect(() => parseSpreadsheet(workbookBuffer('xlsx', [['过长1', longText], ['过长2', longText]]), '.xlsx')).toThrow(/文本.*过长|正文.*超过/);
  });

  it('rejects unsupported formats and identifies empty worksheets', () => {
    const buffer = workbookBuffer('xlsx', [['空表', XLSX.utils.aoa_to_sheet([])]]);
    expect(() => parseSpreadsheet(buffer, '.xlsb')).toThrow(/不支持/);
    expect(parseSpreadsheet(buffer, '.xlsx').text).toContain('空工作表');
  });

  it('rejects oversized input and declared ZIP expansion before decoding spreadsheet content', () => {
    expect(() => parseSpreadsheet(Buffer.alloc(26 * 1024 * 1024), '.xlsx')).toThrow(/文件.*过大|文件.*超过/);
    const buffer = workbookBuffer('xlsx', [['表', XLSX.utils.aoa_to_sheet([['small']])]]);
    const central = buffer.indexOf(Buffer.from('504b0102', 'hex'));
    expect(central).toBeGreaterThan(0);
    buffer.writeUInt32LE(100 * 1024 * 1024, central + 24);
    expect(() => parseSpreadsheet(buffer, '.xlsx')).toThrow(/解压.*过大|解压.*超过/);
  });

  it('rejects a dangerous local ZIP size before SheetJS can allocate from that field', () => {
    const buffer = workbookBuffer('xlsx', [['表', XLSX.utils.aoa_to_sheet([['small']])]], true);
    const central = buffer.indexOf(Buffer.from('504b0102', 'hex'));
    const local = buffer.readUInt32LE(central + 42);
    buffer.writeUInt32LE(1024 * 1024 * 1024, local + 22);
    const allocate = Buffer.allocUnsafe;
    let dangerousAllocation = false;
    const guard = vi.spyOn(Buffer, 'allocUnsafe').mockImplementation((size: number) => {
      if (size > 80 * 1024 * 1024) {
        dangerousAllocation = true;
        throw new Error('allocation tripwire');
      }
      return allocate(size);
    });
    try {
      expect(() => parseSpreadsheet(buffer, '.xlsx')).toThrow(/损坏|无效|解压/);
      expect(dangerousAllocation).toBe(false);
    } finally { guard.mockRestore(); }
  });

  it('accepts compressed XLSX, and rejects mismatched local names, methods, offsets, sizes and ZIP64 sentinels', () => {
    const source = workbookBuffer('xlsx', [['表', XLSX.utils.aoa_to_sheet([['压缩正文']])]], true);
    expect(parseSpreadsheet(source, '.xlsx').text).toContain('压缩正文');
    const central = source.indexOf(Buffer.from('504b0102', 'hex'));
    const local = source.readUInt32LE(central + 42);
    const mutations: Array<(buffer: Buffer) => void> = [
      (buffer) => buffer.writeUInt32LE(0xffffffff, local + 22),
      (buffer) => buffer.writeUInt32LE(0xffffffff, central + 20),
      (buffer) => buffer.writeUInt32LE(0xffffffff, central + 42),
      (buffer) => buffer.writeUInt16LE(0xffff, central + 34),
      (buffer) => buffer.writeUInt16LE(0, local + 8),
      (buffer) => buffer.writeUInt32LE(buffer.readUInt32LE(local + 18) + 1, local + 18),
      (buffer) => { buffer[local + 30] ^= 1; },
    ];
    for (const mutate of mutations) {
      const modified = Buffer.from(source);
      mutate(modified);
      expect(() => parseSpreadsheet(modified, '.xlsx')).toThrow(/损坏|无效|ZIP64/);
    }
  });

  it.each([false, true])('accepts verified streaming descriptors (signature=%s) and rejects false descriptor sizes', (signature) => {
    const source = workbookBuffer('xlsx', [['表', XLSX.utils.aoa_to_sheet([['流式正文']])]], true);
    const central = source.indexOf(Buffer.from('504b0102', 'hex'));
    const local = source.readUInt32LE(central + 42);
    const compressed = source.readUInt32LE(central + 20);
    const dataEnd = local + 30 + source.readUInt16LE(local + 26) + source.readUInt16LE(local + 28) + compressed;
    const descriptor = Buffer.alloc(signature ? 16 : 12);
    const start = signature ? 4 : 0;
    if (signature) descriptor.writeUInt32LE(0x08074b50);
    source.copy(descriptor, start, central + 16, central + 28);
    const modified = insertZipBytes(source, dataEnd, descriptor);
    modified.writeUInt16LE(source.readUInt16LE(local + 6) | 8, local + 6);
    modified.fill(0, local + 14, local + 26);
    modified.writeUInt16LE(source.readUInt16LE(central + 8) | 8, central + descriptor.length + 8);
    const before = Buffer.from(modified);
    expect(parseSpreadsheet(modified, '.xlsx').text).toContain('流式正文');
    expect(modified.equals(before)).toBe(true);
    modified.writeUInt32LE(0x7fffffff, dataEnd + start + 8);
    expect(() => parseSpreadsheet(modified, '.xlsx')).toThrow(/损坏|无效/);
  });

  it.each(['local', 'central'] as const)('rejects ZIP64 extras in %s headers even without ZIP64 sentinel sizes', (location) => {
    const source = workbookBuffer('xlsx', [['表', XLSX.utils.aoa_to_sheet([['正文']])]], true);
    const central = source.indexOf(Buffer.from('504b0102', 'hex'));
    const local = source.readUInt32LE(central + 42);
    const extra = Buffer.from([1, 0, 8, 0, 0, 0, 0, 0x40, 0, 0, 0, 0]);
    const offset = location === 'local' ? local + 30 + source.readUInt16LE(local + 26) : central + 46 + source.readUInt16LE(central + 28);
    const modified = insertZipBytes(source, offset, extra);
    if (location === 'local') modified.writeUInt16LE(extra.length, local + 28);
    else modified.writeUInt16LE(extra.length, central + 30);
    expect(() => parseSpreadsheet(modified, '.xlsx')).toThrow(/ZIP64/);
  });

  it('rejects a compressed payload that expands beyond matching local and central size claims', () => {
    const source = workbookBuffer('xlsx', [['表', XLSX.utils.aoa_to_sheet([['正文']])]], true);
    const central = source.indexOf(Buffer.from('504b0102', 'hex'));
    const local = source.readUInt32LE(central + 42);
    source.writeUInt32LE(1, local + 22);
    source.writeUInt32LE(1, central + 24);
    expect(() => parseSpreadsheet(source, '.xlsx')).toThrow(/损坏|无效/);
  });
});
