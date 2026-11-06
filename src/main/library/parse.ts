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
  if (['.md', '.markdown', '.txt', '.csv', '.json'].includes(ext)) {
    return { title, mime: ext === '.md' || ext === '.markdown' ? 'text/markdown' : 'text/plain', text: buf.toString('utf8') };
  }
  throw new Error(`暂不支持的文件类型：${ext}（支持 PDF、Word、Markdown、TXT）`);
}
