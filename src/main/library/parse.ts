import { readFile } from 'node:fs/promises';
import { basename, extname } from 'node:path';

/** 资源库文件解析（PRD §5.4）：PDF、Word、Markdown、纯文本 → 文本 */
export async function parseFile(path: string): Promise<{ title: string; mime: string; text: string }> {
  const ext = extname(path).toLowerCase();
  const title = basename(path, ext);
  const buf = await readFile(path);
  if (ext === '.pdf') {
    // 直接引用 lib 文件，避免 pdf-parse 入口在打包后读取测试文件的问题
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const pdf = (await import('pdf-parse/lib/pdf-parse.js')).default as (b: Buffer) => Promise<{ text: string }>;
    return { title, mime: 'application/pdf', text: (await pdf(buf)).text };
  }
  if (ext === '.docx') {
    const mammoth = await import('mammoth');
    return { title, mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', text: (await mammoth.extractRawText({ buffer: buf })).value };
  }
  if (['.md', '.markdown', '.txt', '.csv', '.json'].includes(ext)) {
    return { title, mime: ext === '.md' || ext === '.markdown' ? 'text/markdown' : 'text/plain', text: buf.toString('utf8') };
  }
  throw new Error(`暂不支持的文件类型：${ext}（支持 PDF、Word、Markdown、TXT）`);
}
