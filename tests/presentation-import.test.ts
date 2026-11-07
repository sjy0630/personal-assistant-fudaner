import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CFB } from 'xlsx';
import * as ppt from 'ppt-codec';
import { parsePresentation } from '../src/main/library/presentation';

const fixture = (ext: string) => readFileSync(new URL(`./fixtures/presentation-original.${ext}`, import.meta.url));
const open = (bytes: Buffer) => CFB.read(bytes, { type: 'buffer' });
const write = (cfb: unknown, kind = 'zip'): Buffer => Buffer.from(CFB.write(cfb, { type: 'buffer', fileType: kind, compression: true }));
function zip(entries: Record<string, string | Buffer>) {
  const file = CFB.utils.cfb_new();
  for (const [name, contents] of Object.entries(entries)) CFB.utils.cfb_add(file, name, Buffer.from(contents));
  return write(file);
}
function changeZip(name: string, change: (text: string) => string) {
  const file = open(fixture('pptx'));
  const entry = CFB.find(file, `/${name}`);
  CFB.utils.cfb_add(file, `/${name}`, Buffer.from(change(Buffer.from(entry.content).toString('utf8'))));
  return write(file);
}

function legacyState() {
  const file = open(fixture('ppt'));
  const stream = new Uint8Array(CFB.find(file, 'PowerPoint Document').content);
  const current = ppt.readCurrentUserAtom(new Uint8Array(CFB.find(file, 'Current User').content));
  const persisted = ppt.buildPersistDirectory(stream, current.offsetToCurrentEdit);
  const document = ppt.resolvePersistObject(stream, persisted.directory, persisted.currentEdit.docPersistIdRef, 'document');
  const list = ppt.childRecords(document).find(record => record.header.recType === ppt.RT_SlideListWithText && record.header.recInstance === 0)!;
  return { file, stream, current, ...persisted, document, list, slides: ppt.readSlideListWithText(list) };
}
const rawRecord = (record: ppt.PptRecord) => record.stream.slice(record.offset, record.dataOffset + record.data.length);
function rewrite(record: ppt.PptRecord, atom: (record: ppt.PptRecord) => Uint8Array<ArrayBuffer>): Uint8Array<ArrayBuffer> {
  return record.header.recVer === 0xf
    ? ppt.writeContainer(record.header.recType, ppt.childRecords(record).map(child => rewrite(child, atom)), { recInstance: record.header.recInstance })
    : atom(record);
}

describe('PowerPoint 附件', () => {
  for (const ext of ['pptx', 'ppt']) {
    it(`读取真正的 ${ext} 文件的页码、中文段落、表格和讲者备注`, async () => {
      const result = await parsePresentation(fixture(ext), `.${ext}`);
      expect(result.mime).toBe(ext === 'ppt' ? 'application/vnd.ms-powerpoint' : 'application/vnd.openxmlformats-officedocument.presentationml.presentation');
      expect(result.text.match(/## 第 \d+ 张幻灯片/g)).toHaveLength(4);
      expect(result.text).toContain('第一张：复旦课程');
      expect(result.text).toContain('中文 English café µ');
      expect(result.text).toContain('第二段');
      expect(result.text).toContain('| 项目 | 金额 |');
      expect(result.text).toContain('| 咖啡 | 12.50 |');
      expect(result.text).toContain('讲者备注：请介绍校园');
      expect(result.text).toContain('第 3 张幻灯片\n\n（本页为空白页）');
      expect(result.text).toContain('第 4 张幻灯片\n\n（本页包含图片或其他非文本内容，未提取到文字）');
      expect(result.text.indexOf('第一张：')).toBeLessThan(result.text.indexOf('第二张：'));
    });
  }
  it('依据演示文稿中的关系顺序读取，而非按 slide 文件名排序', async () => {
    const bytes = changeZip('ppt/presentation.xml', text => text.replace(/(<p:sldId\b[^>]*\/>)(<p:sldId\b[^>]*\/>)/, '$2$1'));
    const result = await parsePresentation(bytes, '.pptx');
    expect(result.text.indexOf('第二张：')).toBeLessThan(result.text.indexOf('第一张：'));
    expect(result.text.match(/## 第 \d+ 张幻灯片/g)).toHaveLength(4);
  });
  it('表格保留空单元格、单元格内段落和 Markdown 竖线', async () => {
    const bytes = changeZip('ppt/slides/slide2.xml', text => text.replace('<a:t>咖啡</a:t>', '<a:t>A|B</a:t></a:r></a:p><a:p><a:r><a:t>续行</a:t>')
      .replace('<a:t>12.50</a:t>', '<a:t></a:t>'));
    const result = await parsePresentation(bytes, '.PPTX');
    expect(result.text).toContain('| A\\|B / 续行 |  |');
  });
  it('PPT 仅使用最新保存的顺序和对象，不泄漏旧版本或已删除的幻灯片文字', async () => {
    const state = legacyState();
    const groups: ppt.PptRecord[][] = [];
    for (const record of ppt.childRecords(state.list)) {
      if (record.header.recType === ppt.RT_SlidePersistAtom) groups.push([]);
      groups.at(-1)!.push(record);
    }
    // Save a second edit, deleting slide 1 and moving the image slide before the table.
    const updatedList = ppt.writeContainer(ppt.RT_SlideListWithText, [groups[3], groups[1], groups[2]].flat().map(rawRecord));
    const document = ppt.writeContainer(ppt.RT_Document, ppt.childRecords(state.document).map(record =>
      record.offset === state.list.offset ? updatedList : rawRecord(record)));
    const second = ppt.resolvePersistObject(state.stream, state.directory, state.slides[1].persistIdRef, 'slide');
    const slide = rewrite(second, record => record.header.recType === ppt.RT_TextCharsAtom && Buffer.from(record.data).toString('utf16le').includes('第二张：')
      ? ppt.writeAtom(ppt.RT_TextCharsAtom, ppt.utf16le('最新版本：费用表')) : rawRecord(record));
    const directory = ppt.writePersistDirectoryAtom([
      { persistId: state.currentEdit.docPersistIdRef, offset: state.stream.length },
      { persistId: state.slides[1].persistIdRef, offset: state.stream.length + document.length },
    ]);
    const editOffset = state.stream.length + document.length + slide.length + directory.length;
    const edit = ppt.writeUserEditAtom({ ...state.currentEdit, offsetLastEdit: state.current.offsetToCurrentEdit,
      offsetPersistDirectory: editOffset - directory.length });
    CFB.utils.cfb_add(state.file, 'PowerPoint Document', Buffer.from(ppt.concatBytes(state.stream, document, slide, directory, edit)));
    CFB.utils.cfb_add(state.file, 'Current User', Buffer.from(ppt.writeCurrentUserAtom(editOffset)));
    const result = await parsePresentation(write(state.file, 'cfb'), '.ppt');
    expect(result.text.match(/## 第 \d+ 张幻灯片/g)).toHaveLength(3);
    expect(result.text).toContain('最新版本：费用表');
    expect(result.text).not.toContain('第一张：复旦课程');
    expect(result.text).not.toContain('第二张：费用表');
    expect(result.text.indexOf('其他非文本内容')).toBeLessThan(result.text.indexOf('最新版本：费用表'));
  });
  it('PPT 的 TextBytes 使用零高字节 UTF-16，而不是 UTF-8 或 Windows-1252', async () => {
    const state = legacyState();
    const first = ppt.resolvePersistObject(state.stream, state.directory, state.slides[0].persistIdRef, 'slide');
    const slide = rewrite(first, record => record.header.recType === ppt.RT_TextCharsAtom && Buffer.from(record.data).toString('utf16le').includes('第一张：')
      ? ppt.writeAtom(ppt.RT_TextBytesAtom, new Uint8Array([0x4c, 0x61, 0x74, 0x69, 0x6e, 0x20, 0xe9, 0x20, 0xb5, 0x20, 0x80])) : rawRecord(record));
    const directory = ppt.writePersistDirectoryAtom([{ persistId: state.slides[0].persistIdRef, offset: state.stream.length }]);
    const editOffset = state.stream.length + slide.length + directory.length;
    const edit = ppt.writeUserEditAtom({ ...state.currentEdit, offsetLastEdit: state.current.offsetToCurrentEdit,
      offsetPersistDirectory: editOffset - directory.length });
    CFB.utils.cfb_add(state.file, 'PowerPoint Document', Buffer.from(ppt.concatBytes(state.stream, slide, directory, edit)));
    CFB.utils.cfb_add(state.file, 'Current User', Buffer.from(ppt.writeCurrentUserAtom(editOffset)));
    const result = await parsePresentation(write(state.file, 'cfb'), '.ppt');
    expect(result.text).toContain('Latin é µ \u0080');
    expect(result.text).not.toContain('€');
  });
  it('拒绝改名的任意 ZIP、二进制和格式不匹配文件', async () => {
    await expect(parsePresentation(zip({ 'readme.txt': 'hello' }), '.pptx')).rejects.toThrow(/PowerPoint|演示文稿/);
    await expect(parsePresentation(Buffer.from('random binary'), '.ppt')).rejects.toThrow(/PowerPoint|演示文稿/);
    await expect(parsePresentation(fixture('pptx'), '.ppt')).rejects.toThrow(/格式|PowerPoint/);
  });
  it('拒绝损坏或缺失的幻灯片关系，不静默漏页', async () => {
    const bytes = changeZip('ppt/_rels/presentation.xml.rels', text => text.replace('slides/slide1.xml', 'slides/missing.xml'));
    await expect(parsePresentation(bytes, '.pptx')).rejects.toThrow(/损坏|缺少|无效/);
    await expect(parsePresentation(fixture('ppt').subarray(0, 1024), '.ppt')).rejects.toThrow(/损坏|无效/);
  });
  it('拒绝截断 XML、DTD 和过深的 XML，避免静默恢复损坏内容', async () => {
    await expect(parsePresentation(changeZip('ppt/slides/slide1.xml', text => text.slice(0, -20)), '.pptx')).rejects.toThrow(/损坏|无效/);
    await expect(parsePresentation(changeZip('ppt/slides/slide1.xml', text => text.replace('<p:sld ', '<!DOCTYPE p:sld [<!ENTITY x "text">]><p:sld ')), '.pptx')).rejects.toThrow(/损坏|无效/);
    await expect(parsePresentation(changeZip('ppt/slides/slide1.xml', text => text.replace('<p:cSld>', '<p:cSld>' + '<p:sp>'.repeat(129))), '.pptx')).rejects.toThrow(/限制|超出/);
  });
  it('拒绝存在循环的旧版保存链', async () => {
    const state = legacyState();
    const bytes = Buffer.from(state.stream);
    bytes.writeUInt32LE(state.current.offsetToCurrentEdit, state.current.offsetToCurrentEdit + 16);
    CFB.utils.cfb_add(state.file, 'PowerPoint Document', bytes);
    await expect(parsePresentation(write(state.file, 'cfb'), '.ppt')).rejects.toThrow(/损坏|无效/);
  });
  it('拒绝循环或重复的复合文件分配表，不按恶意声明分配内存', async () => {
    const bytes = Buffer.from(fixture('ppt'));
    bytes.writeUInt32LE(bytes.readUInt32LE(76), 80); // Duplicate FAT sector in the header DIFAT.
    await expect(parsePresentation(bytes, '.ppt')).rejects.toThrow(/损坏|无效/);
  });
  it('校验 ZIP 成员的 CRC，拒绝内容完整性校验失败的文件', async () => {
    const bytes = Buffer.from(fixture('pptx'));
    const name = Buffer.from('ppt/slides/slide1.xml');
    for (let offset = 0; offset < bytes.length - 46; offset++) {
      if (bytes.readUInt32LE(offset) !== 0x02014b50) continue;
      const length = bytes.readUInt16LE(offset + 28);
      if (!bytes.subarray(offset + 46, offset + 46 + length).equals(name)) continue;
      bytes.writeUInt32LE((bytes.readUInt32LE(offset + 16) ^ 1) >>> 0, offset + 16);
      break;
    }
    await expect(parsePresentation(bytes, '.pptx')).rejects.toThrow(/损坏|无效/);
  });
  it('拒绝外部幻灯片关系', async () => {
    const bytes = changeZip('ppt/_rels/presentation.xml.rels', text => text.replace('Target="slides/slide1.xml"', 'Target="https://example.com/a.xml" TargetMode="External"'));
    await expect(parsePresentation(bytes, '.pptx')).rejects.toThrow(/外部|损坏|无效/);
  });
  it('明确报告加密的 Office 复合文件', async () => {
    const cfb = CFB.utils.cfb_new();
    CFB.utils.cfb_add(cfb, 'EncryptedPackage', Buffer.alloc(8));
    CFB.utils.cfb_add(cfb, 'EncryptionInfo', Buffer.alloc(8));
    await expect(parsePresentation(write(cfb, 'cfb'), '.pptx')).rejects.toThrow(/加密/);
    const legacy = open(fixture('ppt'));
    const user = Buffer.from(CFB.find(legacy, 'Current User').content);
    user.writeUInt32LE(0xf3d1c4df, 12);
    CFB.utils.cfb_add(legacy, 'Current User', user);
    await expect(parsePresentation(write(legacy, 'cfb'), '.ppt')).rejects.toThrow(/加密/);
  });
  it('在解压前拒绝超限的 ZIP 成员', async () => {
    const bytes = zip({ '[Content_Types].xml': 'x'.repeat(8 * 1024 * 1024 + 1) });
    await expect(parsePresentation(bytes, '.pptx')).rejects.toThrow(/限制|过大|超出/);
  });
  it('在解析前拒绝超过 64 MiB 的输入', async () => {
    await expect(parsePresentation(Buffer.alloc(64 * 1024 * 1024 + 1), '.ppt')).rejects.toThrow(/限制|过大|超出/);
  });
  it('拒绝超出页数上限的演示文稿', async () => {
    const bytes = changeZip('ppt/presentation.xml', text => text.replace(/(<p:sldId\b[^>]*\/>)/, '$1'.repeat(1001)));
    await expect(parsePresentation(bytes, '.pptx')).rejects.toThrow(/页数|限制|超出/);
  });
});
