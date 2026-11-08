import { afterEach, beforeEach, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Db } from '../src/main/db/db';
import { Repo } from '../src/main/db/repo';
import { DocumentPreview } from '../src/main/library/document-preview';
let db: Db;
let repo: Repo;
let folder: string;
beforeEach(async () => { db = new Db(':memory:'); repo = new Repo(db); folder = await mkdtemp(join(tmpdir(), 'preview-test-')); });
afterEach(async () => { db.close(); await rm(folder, { recursive: true, force: true }); });
it('按资源 ID 读取已有 PDF 原文件，旧资源无需重新导入', async () => {
  const path = join(folder, 'test.pdf');
  await writeFile(path, '%PDF-1.7\noriginal pages');
  const resource = repo.addResource({ title: 'test', kind: 'upload', mime: 'application/pdf', text: 'text', path });
  const bytes = await new DocumentPreview(repo).read(resource.id);
  expect(Buffer.from(bytes).toString()).toBe('%PDF-1.7\noriginal pages');
});
it('原文件已移动时显示可操作的错误', async () => {
  const resource = repo.addResource({ title: 'test', kind: 'upload', mime: 'application/pdf', text: '', path: join(folder, 'missing.pdf') });
  await expect(new DocumentPreview(repo).read(resource.id)).rejects.toThrow('重新上传');
});
it('拒绝将任意路径作为资源 ID 读取', async () => {
  await expect(new DocumentPreview(repo).read(join(folder, 'private.pdf'))).rejects.toThrow('原文件不可用');
});
it('拒绝已替换成无效内容的 PDF', async () => {
  const path = join(folder, 'bad.pdf'); await writeFile(path, 'invalid');
  const resource = repo.addResource({ title: 'test', kind: 'upload', mime: 'application/pdf', text: '', path });
  await expect(new DocumentPreview(repo).read(resource.id)).rejects.toThrow('PDF 内容无效');
});
it('旧版 PPT 保留文字阅读并明确原版式支持范围', async () => {
  const resource = repo.addResource({ title: 'test', kind: 'upload', mime: 'application/vnd.ms-powerpoint', text: 'text', path: join(folder, 'test.ppt') });
  await expect(new DocumentPreview(repo).read(resource.id)).rejects.toThrow('旧版 PPT');
});
