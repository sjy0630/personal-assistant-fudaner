import type { CardRef, ResourceImage } from '../../shared/types';
import type { Repo } from '../db/repo';
import type { McpHub } from '../mcp/hub';
import { ImageAttachmentError } from '../library/resource-images';
import { parseJsonLoose } from './llm';

export type ImageReader = (id: string) => Promise<ResourceImage | null>;

/** 每次回复的图片预算。当前引用优先，历史和工具读取共用同一预算。 */
export class ChatImages {
  private readonly included = new Set<string>();
  private readonly toolReferences = new Map<string, CardRef>();
  private bytes = 0;
  constructor(private readonly repo: Repo, private readonly read?: ImageReader) {}

  async forRefs(refs: CardRef[], optional = false): Promise<{ dataUrl: string }[]> {
    const images: { dataUrl: string }[] = [];
    for (const ref of refs) {
      if (ref.type !== 'resource' || this.included.has(ref.id)) continue;
      const resource = this.repo.getResource(ref.id);
      if (!resource?.mime.startsWith('image/')) continue;
      if (this.included.size >= 6) {
        if (optional) continue;
        throw new ImageAttachmentError('一次最多读取 6 张图片，请减少图片后再发送。');
      }
      try {
        const image = await this.read?.(ref.id);
        if (!image) throw new ImageAttachmentError('这张图片暂时无法读取，请重新上传。');
        if (this.bytes + image.dataUrl.length > 24 * 1024 * 1024) throw new ImageAttachmentError('这组图片太大，请减少图片或缩小尺寸后再发送。');
        this.bytes += image.dataUrl.length;
        this.included.add(ref.id);
        images.push({ dataUrl: image.dataUrl });
      } catch (error) { if (!optional) throw error; }
    }
    return images;
  }

  async fromTool(result: Awaited<ReturnType<McpHub['call']>>): Promise<{ dataUrl: string }[]> {
    if (!result.ok || result.server !== 'fudaner-local' || result.tool !== 'read_resource') return [];
    const resource = parseJsonLoose<{ id?: unknown }>(result.text);
    if (typeof resource?.id !== 'string') return [];
    const stored = this.repo.getResource(resource.id);
    if (!stored?.mime.startsWith('image/')) return [];
    const ref: CardRef = { type: 'resource', id: stored.id, title: stored.title };
    const images = await this.forRefs([ref]);
    this.toolReferences.set(ref.id, ref);
    return images;
  }

  references(): CardRef[] { return [...this.toolReferences.values()]; }
}
