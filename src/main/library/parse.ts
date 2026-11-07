import { readFile } from 'node:fs/promises';
import { basename, extname } from 'node:path';
import { createRequire } from 'node:module';
import { pdfPageToMarkdown, pdfLayout, wordToMarkdown, type PdfTextItem, type PdfOperators, type WordNode } from './structure';

/** 资源库文件解析（PRD §5.4）：PDF、Word、Markdown、纯文本 → 文本 */
export async function parseFile(path: string): Promise<{ title: string; mime: string; text: string }> {
  const ext = extname(path).toLowerCase();
  const title = basename(path, ext);
  const buf = await readFile(path);
  if (ext === '.pdf') {
    // 直接引用 lib 文件，避免 pdf-parse 入口在打包后读取测试文件的问题
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    type PdfPage = { getTextContent(options: object): Promise<{ items: PdfTextItem[] }>; getOperatorList(): Promise<PdfOperators> };
    // 与现有 pdf-parse 锁定的 PDF.js 版本一致；禁用字体 DOM，允许 Node 中读取绘图操作。
    const engine = createRequire(import.meta.url)('pdf-parse/lib/pdf.js/v1.10.100/build/pdf.js') as {
      PDFJS: { disableFontFace: boolean };
      getDocument(data: Buffer): Promise<{ numPages: number; getPage(n: number): Promise<PdfPage>; destroy(): Promise<void> }>;
    };
    engine.PDFJS.disableFontFace = true;
    const document = await engine.getDocument(buf);
    try {
      const pages: string[] = [];
      for (let n = 1; n <= document.numPages; n++) {
        const page = await document.getPage(n);
        const content = await page.getTextContent({ normalizeWhitespace: false, disableCombineTextItems: true });
        const operators = await page.getOperatorList();
        pages.push(pdfPageToMarkdown(content.items, n, pdfLayout(content.items, operators)));
      }
      return { title, mime: 'application/pdf', text: pages.join('\n\n') };
    } finally { await document.destroy(); }
  }
  if (ext === '.docx') {
    const mammoth = await import('mammoth');
    let text = '';
    await mammoth.convertToHtml({ buffer: buf }, {
      externalFileAccess: false,
      transformDocument: (document: WordNode) => { text = wordToMarkdown(document); return document; },
      convertImage: mammoth.images.imgElement(async () => ({ src: '' })),
    });
    return { title, mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', text };
  }
  if (ext === '.pptx') {
    return { title, mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', text: await pptxToMarkdown(buf) };
  }
  if (['.md', '.markdown', '.txt', '.csv', '.json'].includes(ext)) {
    return { title, mime: ext === '.md' || ext === '.markdown' ? 'text/markdown' : 'text/plain', text: buf.toString('utf8') };
  }
  throw new Error(`暂不支持的文件类型：${ext}（支持 PDF、Word、PPT（.pptx）、Markdown、TXT）`);
}

/** 能导入资源库的文件类型 */
export const PARSEABLE = ['.pdf', '.docx', '.pptx', '.md', '.markdown', '.txt', '.csv', '.json'];

/**
 * PPT（.pptx）→ 按页的 Markdown：每页的文字（按段落）和备注。
 * .pptx 是 zip 包，幻灯片在 ppt/slides/slideN.xml，文字在 <a:t> 里，段落是 <a:p>。
 */
export async function pptxToMarkdown(buf: Buffer | Uint8Array): Promise<string> {
  const { default: JSZip } = await import('jszip');
  const zip = await JSZip.loadAsync(buf);
  const decode = (s: string) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
  const paragraphs = (xml: string) => (xml.match(/<a:p>[\s\S]*?<\/a:p>|<a:p [\s\S]*?<\/a:p>/g) ?? [])
    .map((p) => (p.match(/<a:t>([^<]*)<\/a:t>|<a:t [^>]*>([^<]*)<\/a:t>/g) ?? []).map((t) => decode(t.replace(/<[^>]+>/g, ''))).join(''))
    .map((t) => t.trim()).filter(Boolean);
  const slideNo = (name: string) => Number(name.match(/(\d+)\.xml$/)?.[1] ?? 0);
  const slides = Object.keys(zip.files).filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n)).sort((a, b) => slideNo(a) - slideNo(b));
  const out: string[] = [];
  for (const name of slides) {
    const n = slideNo(name);
    const lines = paragraphs(await zip.file(name)!.async('string'));
    const notesFile = zip.file(`ppt/notesSlides/notesSlide${n}.xml`);
    const notes = notesFile ? paragraphs(await notesFile.async('string')).filter((t) => !/^\d+$/.test(t)) : [];
    out.push([`## 第 ${n} 页`, ...lines, ...(notes.length ? ['', `> 备注：${notes.join(' ')}`] : [])].join('\n'));
  }
  return out.join('\n\n');
}
