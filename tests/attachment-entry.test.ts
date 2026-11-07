import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import * as XLSX from 'xlsx';
import { parseFile } from '../src/main/library/parse';

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });
async function file(name: string, data: Buffer | string) {
  const dir = await mkdtemp(join(tmpdir(), 'fudaner-attachment-entry-')); dirs.push(dir);
  const path = join(dir, name); await writeFile(path, data); return path;
}
it('普通上传入口解析 Excel，并保留工作表与中文数据', async () => {
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([['课程', '分数'], ['数据结构', 98]]), '成绩表');
  const path = await file('成绩.xlsx', XLSX.write(book, { type: 'buffer', bookType: 'xlsx' }));
  const result = await parseFile(path);
  expect(result.mime).toBe('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  expect(result.text).toContain('成绩表');
  expect(result.text).toContain('数据结构');
  expect(result.text).toContain('98');
});
it('普通上传入口转换 SVG 为可显示和发送给模型的像素图片', async () => {
  const path = await file('图表.svg', '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="32"><rect width="64" height="32" fill="red"/></svg>');
  const result = await parseFile(path);
  expect(result.mime).toMatch(/^image\/(png|jpeg)$/);
  expect(result).toMatchObject({ image: { width: 64, height: 32 } });
  expect(result.text).toContain('64');
});
