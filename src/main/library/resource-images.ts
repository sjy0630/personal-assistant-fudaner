import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, join, resolve } from 'node:path';
import type { ResourceImage } from '../../shared/types';
import type { Repo } from '../db/repo';
import { normalizeImage } from './images';

export class ImageAttachmentError extends Error {}

/** 图片只从应用保存的像素副本读取，接口和模型均不接收任意本地路径。 */
export class ResourceImages {
  private readonly directory: string;
  constructor(private readonly repo: Repo, directory: string) { this.directory = resolve(directory); }

  async save(image: Awaited<ReturnType<typeof normalizeImage>>): Promise<string> {
    await mkdir(this.directory, { recursive: true });
    const path = join(this.directory, `${randomUUID()}${image.mime === 'image/png' ? '.png' : '.jpg'}`);
    await writeFile(path, image.data, { flag: 'wx' });
    return path;
  }

  private managed(path: string): boolean {
    return dirname(resolve(path)) === this.directory && /^[a-f0-9-]{36}\.(png|jpg)$/.test(basename(path));
  }

  async read(id: string): Promise<ResourceImage | null> {
    const resource = this.repo.getResource(id);
    if (!resource?.mime.startsWith('image/')) return null;
    const path = this.repo.getResourceFilePath(id);
    if (!path || !this.managed(path)) throw new ImageAttachmentError('这张图片的本地副本不可用，请重新上传。');
    try {
      const image = await normalizeImage(await readFile(path), extname(path));
      return { dataUrl: `data:${image.mime};base64,${image.data.toString('base64')}`, mime: image.mime, width: image.width, height: image.height };
    } catch { throw new ImageAttachmentError('无法读取这张图片，请重新上传后再试。'); }
  }

  async removeFile(path?: string): Promise<void> {
    if (!path || !this.managed(path)) return;
    try { await unlink(path); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }

  async clear(): Promise<void> {
    let names: string[];
    try { names = await readdir(this.directory); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
    for (const name of names) await this.removeFile(join(this.directory, name));
  }
}
