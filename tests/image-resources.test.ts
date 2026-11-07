import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import sharp from 'sharp';
import { Db } from '../src/main/db/db';
import { Repo } from '../src/main/db/repo';
import { ResourceImages } from '../src/main/library/resource-images';
import { registerIpc } from '../src/main/ipc';
import type { Resource, ResourceImage } from '../src/shared/types';

const handlers = vi.hoisted(() => new Map<string, (...args: unknown[]) => Promise<unknown>>());
vi.mock('electron', () => ({ ipcMain: { handle: (name: string, fn: (...args: unknown[]) => Promise<unknown>) => handlers.set(name, fn) } }));
const opened: Db[] = [];
const directories: string[] = [];
afterEach(async () => {
  opened.splice(0).forEach((db) => db.close());
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
async function setup() {
  const directory = await mkdtemp(join(tmpdir(), 'fudaner-image-resource-')); directories.push(directory);
  const db = new Db(join(directory, 'qa.sqlite')); opened.push(db);
  const repo = new Repo(db);
  const imageDir = join(directory, 'images');
  const images = new ResourceImages(repo, imageDir);
  registerIpc({ repo, images, agent: { state: () => null } } as never, {} as never);
  const invoke = <T>(name: string, ...args: unknown[]) => handlers.get(name)!(undefined, ...args) as Promise<T>;
  return { directory, imageDir, repo, images, invoke };
}
it('正常 IPC 导入后图片有独立副本，原文件删除和服务重建后仍能预览', async () => {
  const { directory, imageDir, repo, invoke } = await setup();
  const source = join(directory, '用户截图.webp');
  await sharp({ create: { width: 40, height: 20, channels: 3, background: '#ff0000' } }).webp().toFile(source);
  const resource = await invoke<Resource>('library.upload', source);
  expect(resource.mime).toBe('image/png');
  expect(resource.text).not.toContain('base64');
  expect(repo.getResourceFilePath(resource.id)).not.toBe(source);
  await rm(source);
  const image = await new ResourceImages(repo, imageDir).read(resource.id);
  expect(image).toMatchObject({ mime: 'image/png', width: 40, height: 20 });
  const pixels = await sharp(Buffer.from(image!.dataUrl.split(',')[1], 'base64')).raw().toBuffer();
  expect(pixels[0]).toBeGreaterThan(240);
  await invoke('library.remove', resource.id);
  expect(repo.getResource(resource.id)).toBeUndefined();
  expect(await readdir(imageDir)).toEqual([]);
});
it('数据库里伪造的任意本地路径不会作为图片传出', async () => {
  const { directory, repo, images } = await setup();
  const path = join(directory, 'private.png'); await writeFile(path, 'private-content');
  const resource = repo.addResource({ title: '图片', kind: 'upload', mime: 'image/png', text: '', path });
  await expect(images.read(resource.id)).rejects.toThrow('本地副本不可用');
  await images.removeFile(path);
  expect(await readFile(path, 'utf8')).toBe('private-content');
});
it('清除本地内容会移除图片副本和引用记录', async () => {
  const { directory, imageDir, repo, invoke } = await setup();
  const path = join(directory, '原图.png');
  await sharp({ create: { width: 10, height: 10, channels: 3, background: 'blue' } }).png().toFile(path);
  const resource = await invoke<Resource>('library.upload', path);
  expect(await invoke<ResourceImage>('library.image', resource.id)).toHaveProperty('dataUrl');
  await invoke('dev.wipe');
  expect(repo.getResource(resource.id)).toBeUndefined();
  expect(await readdir(imageDir)).toEqual([]);
  expect((await readFile(path)).length).toBeGreaterThan(0);
});

it('粘贴截图的内存字节可导入，非图片和超大内容会被拒绝', async () => {
  const { invoke, repo } = await setup();
  const bytes = await sharp({ create: { width: 16, height: 8, channels: 3, background: 'red' } }).png().toBuffer();
  const resource = await invoke<Resource>('library.uploadImage', '截图.png', new Uint8Array(bytes));
  expect(await invoke<ResourceImage>('library.image', resource.id)).toMatchObject({ width: 16, height: 8 });
  await expect(invoke('library.uploadImage', 'file.txt', new Uint8Array(bytes))).rejects.toThrow('仅支持图片');
  await expect(invoke('library.uploadImage', 'too-large.png', new Uint8Array(25 * 1024 * 1024 + 1))).rejects.toThrow('25 MB');
  expect(repo.listResources()).toHaveLength(1);
});

it('保存索引中途失败时，资源记录和图片副本一起回滚', async () => {
  const { invoke, repo, imageDir } = await setup();
  const bytes = await sharp({ create: { width: 16, height: 8, channels: 3, background: 'red' } }).png().toBuffer();
  const failingIndex = vi.spyOn(repo, 'indexForSearch').mockImplementation(() => { throw new Error('模拟磁盘写入失败'); });
  await expect(invoke('library.uploadImage', '截图.png', bytes)).rejects.toThrow('模拟磁盘写入失败');
  failingIndex.mockRestore();
  expect(repo.listResources()).toEqual([]);
  expect(await readdir(imageDir)).toEqual([]);
});
