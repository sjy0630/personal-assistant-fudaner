import { posix } from 'node:path';
import { crc32 } from 'node:zlib';
import * as yauzl from 'yauzl';
import { load, type CheerioAPI } from 'cheerio';
import { parser as saxParser } from 'sax';
import type { Element, AnyNode } from 'domhandler';
import { parseLegacyPresentation, markdownTable, type PresentationSlide } from './presentation-legacy';

const MAX_INPUT = 64 * 1024 * 1024;
const MAX_EXPANDED = 128 * 1024 * 1024;
const MAX_XML = 8 * 1024 * 1024;
const MAX_SLIDES = 1000;
const MAX_TEXT = 2_000_000;
const COMPOUND_MAGIC = Buffer.from('d0cf11e0a1b11ae1', 'hex');
const damaged = () => new Error('PowerPoint 演示文稿损坏或格式无效，请重新导出后导入。');
const limit = () => new Error('PowerPoint 演示文稿超出解析限制，请拆分文件后导入。');

/** Text import only: never executes macros, follows external links, or invokes Office. */
export async function parsePresentation(buffer: Buffer, extension: string): Promise<{ mime: string; text: string }> {
  if (buffer.length > MAX_INPUT) throw limit();
  const ext = extension.toLowerCase();
  if (!['.ppt', '.pptx'].includes(ext)) throw new Error('不支持的 PowerPoint 演示文稿格式。');
  try {
    let slides: PresentationSlide[];
    const compound = buffer.subarray(0, 8).equals(COMPOUND_MAGIC);
    if (ext === '.ppt' || compound) {
      if (!compound) throw damaged();
      slides = parseLegacyPresentation(buffer, ext, MAX_SLIDES);
    } else {
      if (buffer.readUInt32LE(0) !== 0x04034b50) throw damaged();
      slides = await parsePptx(buffer);
    }
    if (!slides.length) throw new Error('PowerPoint 演示文稿没有可导入的幻灯片。');
    let length = 0;
    const pages = slides.map((slide, index) => {
      let text = `## 第 ${index + 1} 张幻灯片\n\n` + (slide.blocks.filter(Boolean).join('\n\n') ||
        (slide.nonText ? '（本页包含图片或其他非文本内容，未提取到文字）' : '（本页为空白页）'));
      if (slide.notes.trim()) text += `\n\n### 讲者备注\n\n${slide.notes}`;
      length += text.length;
      if (length > MAX_TEXT) throw limit();
      return text;
    });
    return { mime: ext === '.ppt' ? 'application/vnd.ms-powerpoint' : 'application/vnd.openxmlformats-officedocument.presentationml.presentation', text: pages.join('\n\n') };
  } catch (error) {
    if (error instanceof Error && /[\u3400-\u9fff]/u.test(error.message)) throw error;
    throw damaged();
  }
}

/** Lazy ZIP iteration checks declared sizes before opening streams and actual bytes while reading. */
async function readXmlParts(buffer: Buffer): Promise<Map<string, Buffer>> {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(buffer, { lazyEntries: true, autoClose: true, validateEntrySizes: true, strictFileNames: true }, (error, zip) => {
      if (error || !zip) { reject(damaged()); return; }
      const parts = new Map<string, Buffer>();
      const names = new Set<string>();
      let total = 0;
      let finished = false;
      const fail = (reason: Error) => { if (!finished) { finished = true; zip.close(); reject(reason); } };
      zip.on('error', () => fail(damaged()));
      zip.on('end', () => { if (!finished) { finished = true; resolve(parts); } });
      if (zip.entryCount > 10000) { fail(limit()); return; }
      zip.on('entry', (entry: yauzl.Entry) => {
        const name = entry.fileName;
        const xml = /(?:\.xml|\.rels)$/i.test(name);
        total += entry.uncompressedSize;
        if (names.has(name) || /(?:^|\/)\.\.(?:\/|$)|^\/|\\|\0/.test(name)) { fail(damaged()); return; }
        names.add(name);
        if (entry.generalPurposeBitFlag & 1) { fail(new Error('暂不支持加密的 PowerPoint 演示文稿，请先解除密码保护。')); return; }
        if (total > MAX_EXPANDED || (xml && entry.uncompressedSize > MAX_XML)) { fail(limit()); return; }
        if (!xml || name.endsWith('/')) { zip.readEntry(); return; }
        zip.openReadStream(entry, (streamError, stream) => {
          if (streamError || !stream) { fail(damaged()); return; }
          let size = 0;
          let checksum = 0;
          const chunks: Buffer[] = [];
          stream.on('data', (chunk: Buffer) => {
            size += chunk.length;
            if (size > MAX_XML || size > entry.uncompressedSize) { stream.destroy(); fail(limit()); return; }
            checksum = crc32(chunk, checksum);
            chunks.push(chunk);
          });
          stream.on('error', () => fail(damaged()));
          stream.on('end', () => {
            if (finished) return;
            if (size !== entry.uncompressedSize || checksum !== entry.crc32) { fail(damaged()); return; }
            parts.set(name, Buffer.concat(chunks));
            zip.readEntry();
          });
        });
      });
      zip.readEntry();
    });
  });
}

type Xml = { $: CheerioAPI; root: Element };
const local = (node: AnyNode) => node.type === 'tag' ? node.name.split(':').at(-1) : '';
const elements = (node: Element, name?: string) => node.children.filter((child): child is Element => child.type === 'tag' && (!name || local(child) === name));
function descendants(xml: Xml, node: Element, name: string): Element[] {
  return xml.$(node).find('*').toArray().filter((entry): entry is Element => entry.type === 'tag' && local(entry) === name);
}

function parseXml(bytes: Buffer | undefined, rootName?: string): Xml {
  if (!bytes) throw damaged();
  const source = bytes[0] === 0xff && bytes[1] === 0xfe ? bytes.subarray(2).toString('utf16le') : bytes.toString('utf8');
  if (/<!DOCTYPE|<!ENTITY/i.test(source)) throw damaged();
  const validator = saxParser(true, { xmlns: true });
  let depth = 0;
  let nodes = 0;
  validator.onopentag = () => { if (++depth > 128 || ++nodes > 100000) throw limit(); };
  validator.onclosetag = () => { depth--; };
  validator.onerror = () => { throw damaged(); };
  validator.write(source).close();
  if (depth !== 0) throw damaged();
  const $ = load(source, { xml: true });
  const roots = $.root().children().toArray().filter((node): node is Element => node.type === 'tag');
  if (roots.length !== 1 || (rootName && local(roots[0]) !== rootName)) throw damaged();
  return { $, root: roots[0] };
}

type Relationship = { target: string; type: string; external: boolean };
function relationships(parts: Map<string, Buffer>, source: string): Map<string, Relationship> {
  const name = source ? posix.join(posix.dirname(source), '_rels', posix.basename(source) + '.rels') : '_rels/.rels';
  const xml = parseXml(parts.get(name), 'Relationships');
  const result = new Map<string, Relationship>();
  for (const rel of elements(xml.root, 'Relationship')) {
    const { Id, Target, Type, TargetMode } = rel.attribs;
    if (!Id || !Target || !Type || result.has(Id)) throw damaged();
    result.set(Id, { target: Target, type: Type, external: TargetMode === 'External' });
  }
  return result;
}

function targetPart(source: string, rel: Relationship | undefined, kind: string): string {
  if (!rel || !rel.type.endsWith('/' + kind)) throw damaged();
  if (rel.external) throw new Error('演示文稿包含无效的外部幻灯片关系，无法导入。');
  const target = decodeURIComponent(rel.target);
  if (/^[a-z][a-z\d+.-]*:|\\|\0|[?#]/i.test(target)) throw damaged();
  const path = posix.normalize(target.startsWith('/') ? target.slice(1) : posix.join(posix.dirname(source), target));
  if (path === '..' || path.startsWith('../')) throw damaged();
  return path;
}

function paragraphText(xml: Xml, paragraph: Element): string {
  let result = '';
  for (const child of elements(paragraph)) {
    if (['r', 'fld'].includes(local(child) ?? '')) {
      for (const text of elements(child, 't')) result += xml.$(text).text();
    } else if (local(child) === 'br') result += '\n';
  }
  return result;
}
function bodyText(xml: Xml, node: Element): string {
  return descendants(xml, node, 'p').map(p => paragraphText(xml, p)).join('\n').trim();
}
function xmlSlide(xml: Xml, notes = false): PresentationSlide {
  const result: PresentationSlide = { blocks: [], notes: '', nonText: false };
  const tree = descendants(xml, xml.root, 'spTree')[0];
  if (!tree) throw damaged();
  const visit = (parent: Element) => {
    for (const shape of elements(parent)) {
      switch (local(shape)) {
        case 'grpSp': visit(shape); break;
        case 'AlternateContent': {
          const branch = elements(shape, 'Choice')[0] ?? elements(shape, 'Fallback')[0];
          if (branch) visit(branch);
          break;
        }
        case 'sp': case 'cxnSp': {
          const placeholder = descendants(xml, shape, 'ph')[0]?.attribs.type;
          if (notes && placeholder && ['sldImg', 'sldNum', 'hdr', 'ftr', 'dt'].includes(placeholder)) break;
          const body = elements(shape, 'txBody')[0];
          if (body) { const text = bodyText(xml, body); if (text) result.blocks.push(text); }
          break;
        }
        case 'graphicFrame': {
          const tables = descendants(xml, shape, 'tbl');
          for (const table of tables) {
            const rows = elements(table, 'tr').map(row => elements(row, 'tc').map(cell => bodyText(xml, cell)));
            if (rows.length) result.blocks.push(markdownTable(rows));
          }
          if (!tables.length) result.nonText = true;
          break;
        }
        case 'pic': case 'contentPart': result.nonText = true; break;
      }
    }
  };
  visit(tree);
  return result;
}

async function parsePptx(buffer: Buffer): Promise<PresentationSlide[]> {
  const parts = await readXmlParts(buffer);
  const types = parseXml(parts.get('[Content_Types].xml'), 'Types');
  const office = [...relationships(parts, '').values()].find(rel => rel.type.endsWith('/officeDocument'));
  const main = targetPart('', office, 'officeDocument');
  const type = elements(types.root, 'Override').find(node => node.attribs.PartName === '/' + main)?.attribs.ContentType;
  if (type !== 'application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml') throw damaged();
  const presentation = parseXml(parts.get(main), 'presentation');
  const namespace = presentation.root.attribs[presentation.root.name.includes(':') ? `xmlns:${presentation.root.name.split(':')[0]}` : 'xmlns'];
  if (!['http://schemas.openxmlformats.org/presentationml/2006/main', 'http://purl.oclc.org/ooxml/presentationml/main'].includes(namespace)) throw damaged();
  const ids = descendants(presentation, presentation.root, 'sldId');
  if (ids.length > MAX_SLIDES) throw new Error('PowerPoint 演示文稿页数超出 1000 页限制，请拆分后导入。');
  const rels = relationships(parts, main);
  const seen = new Set<string>();
  return ids.map(id => {
    const relationId = Object.entries(id.attribs).find(([key]) => key.endsWith(':id'))?.[1];
    const path = targetPart(main, rels.get(relationId ?? ''), 'slide');
    if (seen.has(path)) throw damaged();
    seen.add(path);
    const slide = xmlSlide(parseXml(parts.get(path), 'sld'));
    const relPath = posix.join(posix.dirname(path), '_rels', posix.basename(path) + '.rels');
    if (parts.has(relPath)) {
      const notes = [...relationships(parts, path).values()].filter(rel => rel.type.endsWith('/notesSlide'));
      if (notes.length > 1) throw damaged();
      if (notes[0]) slide.notes = xmlSlide(parseXml(parts.get(targetPart(path, notes[0], 'notesSlide')), 'notes'), true).blocks.join('\n\n');
    }
    return slide;
  });
}
