import { readCompoundFile } from 'archive-codec';
import {
  readCurrentUserAtom, readUserEditAtom, readPersistDirectoryAtom, readRecordAt,
  readSlideListWithText, readNotesListWithText, readNotesContainerAtom, readTextBody,
  type PptRecord, type SlidePersist,
  OfficeArtSpContainer, OfficeArtSpgrContainer, OfficeArtFSP, OfficeArtClientTextbox,
  OfficeArtClientAnchor, OfficeArtChildAnchor, OfficeArtFOPT, OfficeArtTertiaryFOPT,
  RT_Document, RT_DocumentAtom, RT_Drawing, RT_Notes, RT_Slide, RT_SlideAtom,
  RT_SlideListWithText, RT_OutlineTextRefAtom, RT_TextCharsAtom,
} from 'ppt-codec';

export interface PresentationSlide { blocks: string[]; notes: string; nonText: boolean }

export function markdownTable(rows: string[][]): string {
  const width = Math.max(0, ...rows.map(row => row.length));
  const row = (cells: string[]) => '| ' + Array.from({ length: width }, (_, i) =>
    (cells[i] ?? '').replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\r?\n/g, ' / ')).join(' | ') + ' |';
  return [row(rows[0]), row(Array(width).fill('---')), ...rows.slice(1).map(row)].join('\n');
}

const invalid = () => new Error('PowerPoint 演示文稿损坏或格式无效，请重新导出后导入。');
const limit = () => new Error('PowerPoint 演示文稿超出解析限制，请拆分文件后导入。');
const u32 = (record: PptRecord, at: number) => {
  if (record.data.length < at + 4) throw invalid();
  return new DataView(record.data.buffer, record.data.byteOffset, record.data.byteLength).getUint32(at, true);
};

/** Validate allocation-table references before the CFB reader sizes its FAT array.
 * A cyclic DIFAT with repeated sector IDs must not amplify a small input into a
 * multi-gigabyte allocation. [MS-CFB] 2.2/2.5 define the counts and unique FAT locations.
 */
function validateAllocationTable(buffer: Buffer): void {
  if (buffer.length < 512) throw invalid();
  const shift = buffer.readUInt16LE(30);
  if (![9, 12].includes(shift)) throw invalid();
  const sectorSize = 2 ** shift;
  const sectorCount = Math.floor(buffer.length / sectorSize) - 1;
  const fatCount = buffer.readUInt32LE(44);
  const difatCount = buffer.readUInt32LE(72);
  if (!fatCount || fatCount > sectorCount || difatCount > sectorCount) throw invalid();
  const fat = new Set<number>();
  const difat = new Set<number>();
  const accept = (sector: number) => {
    if (sector === 0xffffffff) return;
    if (sector >= sectorCount || fat.has(sector) || fat.size >= fatCount) throw invalid();
    fat.add(sector);
  };
  for (let offset = 76; offset < 512; offset += 4) accept(buffer.readUInt32LE(offset));
  let at = buffer.readUInt32LE(68);
  while (at !== 0xfffffffe) {
    if (at >= sectorCount || difat.has(at) || difat.size >= difatCount) throw invalid();
    difat.add(at);
    const start = (at + 1) * sectorSize;
    for (let offset = start; offset < start + sectorSize - 4; offset += 4) accept(buffer.readUInt32LE(offset));
    at = buffer.readUInt32LE(start + sectorSize - 4);
  }
  if (fat.size !== fatCount || difat.size !== difatCount || [...difat].some(id => fat.has(id))) throw invalid();
}

/** [MS-PPT] live objects only. Rendering is intentionally avoided: the upstream
 * geometry decoder rejects some valid Impress complex shape properties. These
 * scalar/text readers do not interpret image data, macros or complex properties.
 */
export function parseLegacyPresentation(buffer: Buffer, extension: string, maxSlides: number): PresentationSlide[] {
  validateAllocationTable(buffer);
  const streams = readCompoundFile(new Uint8Array(buffer), { maxTotalBytes: 128 * 1024 * 1024 });
  if (streams.some(stream => ['EncryptedPackage', 'EncryptionInfo'].includes(stream.path))) {
    throw new Error('暂不支持加密的 PowerPoint 演示文稿，请先解除密码保护。');
  }
  if (extension !== '.ppt') throw invalid();
  const stream = streams.find(item => item.path === 'PowerPoint Document')?.bytes;
  const user = streams.find(item => item.path === 'Current User')?.bytes;
  if (!stream || !user) throw invalid();
  const current = readCurrentUserAtom(user);
  if (current.encrypted) throw new Error('暂不支持加密的 PowerPoint 演示文稿，请先解除密码保护。');

  let recordCount = 0;
  const children = (parent: PptRecord): PptRecord[] => {
    const result: PptRecord[] = [];
    const end = parent.dataOffset + parent.data.length;
    for (let offset = parent.dataOffset; offset < end;) {
      if (++recordCount > 200000 || offset + 8 > end) throw limit();
      const child = readRecordAt(stream, offset);
      const next = child.dataOffset + child.data.length;
      if (next > end) throw invalid();
      result.push(child);
      offset = next;
    }
    return result;
  };
  // Newest entry wins; older edits may still contain unchanged live objects.
  const directory = new Map<number, number>();
  let editOffset = current.offsetToCurrentEdit;
  let documentId = 0;
  let edits = 0;
  do {
    if (++edits > 4096) throw limit();
    const edit = readUserEditAtom(readRecordAt(stream, editOffset));
    if (!documentId) documentId = edit.docPersistIdRef;
    if (edit.encryptSessionPersistIdRef) throw new Error('暂不支持加密的 PowerPoint 演示文稿，请先解除密码保护。');
    const persistRecord = readRecordAt(stream, edit.offsetPersistDirectory);
    if (persistRecord.data.length > 800000) throw limit();
    for (const [id, offset] of readPersistDirectoryAtom(persistRecord)) {
      if (!directory.has(id)) directory.set(id, offset);
      if (directory.size > 100000) throw limit();
    }
    if (edit.offsetLastEdit >= editOffset && edit.offsetLastEdit !== 0) throw invalid();
    editOffset = edit.offsetLastEdit;
  } while (editOffset);
  const object = (id: number, type: number): PptRecord => {
    const offset = directory.get(id);
    if (offset === undefined) throw invalid();
    const record = readRecordAt(stream, offset);
    if (record.header.recType !== type || record.header.recVer !== 0xf) throw invalid();
    return record;
  };
  const document = object(documentId, RT_Document);
  const documentChildren = children(document);
  if (!documentChildren.some(child => child.header.recType === RT_DocumentAtom)) throw invalid();
  const list = (instance: number) => documentChildren.find(child => child.header.recType === RT_SlideListWithText && child.header.recInstance === instance);
  const slideList = list(0);
  if (!slideList) return [];
  children(slideList); // Bound the record count before the maintained list decoder allocates.
  const persists = readSlideListWithText(slideList);
  if (persists.length > maxSlides) throw new Error(`PowerPoint 演示文稿页数超出 ${maxSlides} 页限制，请拆分后导入。`);
  const seen = new Set<number>();

  const normalizedText = (records: readonly PptRecord[]): string => {
    for (const record of records) if (record.header.recType === RT_TextCharsAtom && record.data.length % 2) throw invalid();
    return (readTextBody(records) ?? '').replace(/\r\n?|\v/g, '\n').replace(/\0/g, '').trim();
  };
  const shapeText = (records: PptRecord[], persist?: SlidePersist): string => {
    const box = records.find(child => child.header.recType === OfficeArtClientTextbox);
    if (!box) return '';
    const textRecords = children(box);
    const reference = textRecords.find(child => child.header.recType === RT_OutlineTextRefAtom);
    if (!reference) return normalizedText(textRecords);
    const outline = persist?.texts[u32(reference, 0)];
    if (!outline) throw invalid();
    return normalizedText(outline.records);
  };
  const flags = (records: PptRecord[]) => {
    const identity = records.find(child => child.header.recType === OfficeArtFSP);
    if (!identity) throw invalid();
    return u32(identity, 4);
  };
  const isTable = (records: PptRecord[]) => {
    for (const record of records) {
      if (![OfficeArtFOPT, OfficeArtTertiaryFOPT, 0xf121].includes(record.header.recType)) continue;
      if (record.header.recInstance * 6 > record.data.length) throw invalid();
      const data = new DataView(record.data.buffer, record.data.byteOffset, record.data.byteLength);
      for (let index = 0; index < record.header.recInstance; index++) {
        const opid = data.getUint16(index * 6, true);
        if ((opid & 0x3fff) === 927 && !(opid & 0x4000) && (data.getUint32(index * 6 + 2, true) & 1)) return true;
      }
    }
    return false;
  };
  const position = (records: PptRecord[]) => {
    const childAnchor = records.find(child => child.header.recType === OfficeArtChildAnchor);
    const anchor = childAnchor ?? records.find(child => child.header.recType === OfficeArtClientAnchor);
    if (!anchor || ![8, 16].includes(anchor.data.length)) throw invalid();
    const view = new DataView(anchor.data.buffer, anchor.data.byteOffset, anchor.data.byteLength);
    const at = (i: number) => anchor.data.length === 8 ? view.getInt16(i * 2, true) : view.getInt32(i * 4, true);
    return childAnchor ? { x: at(0), y: at(1) } : { x: at(1), y: at(0) };
  };
  const extract = (container: PptRecord, persist?: SlidePersist): PresentationSlide => {
    const result: PresentationSlide = { blocks: [], notes: '', nonText: false };
    const drawing = children(container).find(child => child.header.recType === RT_Drawing);
    if (!drawing) return result;
    const walk = (record: PptRecord, depth: number) => {
      if (depth > 64) throw limit();
      const records = children(record);
      if (record.header.recType === OfficeArtSpContainer) {
        const bits = flags(records);
        if (bits & 8 || bits & 1 || bits & 4) return; // Deleted shapes/group metadata carry no live content.
        const text = shapeText(records, persist);
        if (text) result.blocks.push(text);
        else if (records.some(child => [OfficeArtClientAnchor, OfficeArtChildAnchor].includes(child.header.recType))) result.nonText = true;
        return;
      }
      if (record.header.recType === OfficeArtSpgrContainer) {
        const group = records.find(child => child.header.recType === OfficeArtSpContainer);
        const groupRecords = group ? children(group) : [];
        if (group && flags(groupRecords) & 8) return;
        if (group && isTable(groupRecords)) {
          const cells = records.filter(child => child !== group && child.header.recType === OfficeArtSpContainer)
            .map(child => children(child)).filter(items => !(flags(items) & 8))
            .map(items => ({ ...position(items), text: shapeText(items, persist) }));
          const xs = [...new Set(cells.map(cell => cell.x))].sort((a, b) => a - b);
          const ys = [...new Set(cells.map(cell => cell.y))].sort((a, b) => a - b);
          if (xs.length * ys.length > 100000) throw limit();
          const byPosition = new Map(cells.map(cell => [`${cell.x},${cell.y}`, cell.text]));
          const rows = ys.map(y => xs.map(x => byPosition.get(`${x},${y}`) ?? ''));
          if (rows.length) result.blocks.push(markdownTable(rows));
          return;
        }
      }
      for (const child of records) if (child.header.recVer === 0xf) walk(child, depth + 1);
    };
    walk(drawing, 0);
    return result;
  };

  const notesBySlide = new Map<number, string>();
  const notesList = list(2);
  if (notesList) {
    children(notesList);
    const notes = readNotesListWithText(notesList);
    if (notes.length > maxSlides) throw limit();
    for (const note of notes) {
      const container = object(note.persistIdRef, RT_Notes);
      const identity = readNotesContainerAtom(container);
      notesBySlide.set(identity.slideIdRef, extract(container).blocks.join('\n\n'));
    }
  }
  return persists.map(persist => {
    if (seen.has(persist.slideId)) throw invalid();
    seen.add(persist.slideId);
    const container = object(persist.persistIdRef, RT_Slide);
    if (!children(container).some(record => record.header.recType === RT_SlideAtom)) throw invalid();
    const slide = extract(container, persist);
    slide.notes = notesBySlide.get(persist.slideId) ?? '';
    return slide;
  });
}
