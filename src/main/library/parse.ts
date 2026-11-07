import { readFile, stat } from 'node:fs/promises';
import { basename, extname } from 'node:path';
import { createRequire } from 'node:module';
import { pdfPageToMarkdown, pdfLayout, wordToMarkdown, type PdfTextItem, type PdfOperators, type WordNode } from './structure';
import { IMAGE_EXTENSIONS, SPREADSHEET_EXTENSIONS, PRESENTATION_EXTENSIONS, MAX_ATTACHMENT_BYTES, supportedAttachment, ATTACHMENT_FORMATS_LABEL } from '../../shared/attachment-formats';
import { normalizeImage } from './images';
import { parseSpreadsheet } from './spreadsheet';
import { parsePresentation } from './presentation';

export interface ParsedFile {
  title: string;
  mime: string;
  text: string;
  image?: Awaited<ReturnType<typeof normalizeImage>>;
}

export async function parseImageBytes(name: string, bytes: Uint8Array): Promise<ParsedFile> {
  const ext = extname(name).toLowerCase();
  if (!IMAGE_EXTENSIONS.some((value) => value === ext)) throw new Error('粘贴附件仅支持图片，请用文件按钮导入文档。');
  if (!(bytes instanceof Uint8Array) || !bytes.byteLength) throw new Error('图片内容为空，请重新粘贴。');
  if (bytes.byteLength > MAX_ATTACHMENT_BYTES) throw new Error('单张图片最大支持 25 MB，请缩小图片后重试。');
  const title = basename(name, ext);
  const image = await normalizeImage(Buffer.from(bytes), ext);
  const text = `# ${title}\n\n图片 · ${image.width} × ${image.height} 像素${image.note ? `\n\n${image.note}` : ''}\n\n引用这张图片到对话后，可用支持图片的模型阅读。`;
  return { title, mime: image.mime, text, image };
}

/** 资源库文件解析（PRD §5.4）：PDF、Word、Markdown、纯文本 → 文本 */
export async function parseFile(path: string): Promise<ParsedFile> {
  const ext = extname(path).toLowerCase();
  const title = basename(path, ext);
  if (!supportedAttachment(path)) throw new Error(`暂不支持的文件类型：${ext}（支持${ATTACHMENT_FORMATS_LABEL}）`);
  const info = await stat(path);
  if (!info.isFile() || !info.size) throw new Error('文件为空或无法读取，请重新选择。');
  if (info.size > MAX_ATTACHMENT_BYTES) throw new Error('单个附件最大支持 25 MB，请缩小文件后重试。');
  const buf = await readFile(path);
  if (IMAGE_EXTENSIONS.some((value) => value === ext)) {
    return parseImageBytes(path, buf);
  }
  if (SPREADSHEET_EXTENSIONS.some((value) => value === ext)) return { title, ...parseSpreadsheet(buf, ext) };
  if (PRESENTATION_EXTENSIONS.some((value) => value === ext)) return { title, ...await parsePresentation(buf, ext) };
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
  if (['.md', '.markdown', '.txt', '.csv', '.json'].includes(ext)) {
    return { title, mime: ext === '.md' || ext === '.markdown' ? 'text/markdown' : 'text/plain', text: buf.toString('utf8') };
  }
  throw new Error(`暂不支持的文件类型：${ext}（支持 PDF、Word、Markdown、TXT）`);
}
