import { readFile, stat } from 'node:fs/promises';
import type { Repo } from '../db/repo';
import { spreadsheetPreview } from './spreadsheet';

const supported = new Set(['application/pdf', 'application/vnd.openxmlformats-officedocument.presentationml.presentation', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document']);

/** 原文件只通过已导入资源的 ID 读取，不接受前端传入本地路径。 */
export class DocumentPreview {
  constructor(private readonly repo: Repo) {}

  async spreadsheet(id: string, rowOffset = 0, columnOffset = 0) {
    const resource = this.repo.getResource(id);
    const path = this.repo.getResourceFilePath(id);
    if (!resource || !path) throw new Error('原文件不可用，请重新上传。');
    const extension = resource.mime === 'application/vnd.ms-excel' ? '.xls' : resource.mime === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' ? '.xlsx' : null;
    if (!extension) throw new Error('此资源不是 Excel 工作簿。');
    const info = await stat(path).catch(() => null);
    if (!info?.isFile()) throw new Error('原文件已移动或删除，请重新上传。');
    if (info.size > 25 * 1024 * 1024) throw new Error('预览文件不能超过 25 MB。');
    return spreadsheetPreview(await readFile(path), extension, rowOffset, columnOffset);
  }

  async read(id: string): Promise<Uint8Array> {
    const resource = this.repo.getResource(id);
    const path = this.repo.getResourceFilePath(id);
    if (!resource || !path) throw new Error('原文件不可用，请重新上传。');
    if (!supported.has(resource.mime)) throw new Error('原版式预览支持 PDF 和 PPTX。旧版 PPT 请另存为 PPTX 或 PDF，也可切换文字阅读。');
    const info = await stat(path).catch(() => null);
    if (!info?.isFile()) throw new Error('原文件已移动或删除，请重新上传。');
    if (info.size > 25 * 1024 * 1024) throw new Error('预览文件不能超过 25 MB。');
    const bytes = await readFile(path);
    if (resource.mime === 'application/pdf' && bytes.subarray(0, 5).toString() !== '%PDF-') {
      throw new Error('PDF 内容无效，请重新导出后上传。');
    }
    if (resource.mime !== 'application/pdf' && (bytes.length < 4 || bytes.readUInt16LE(0) !== 0x4b50)) {
      throw new Error('PPTX 内容无效，请重新导出后上传。');
    }
    return new Uint8Array(bytes);
  }
}
