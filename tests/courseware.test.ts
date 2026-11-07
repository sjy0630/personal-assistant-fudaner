import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import JSZip from 'jszip';
import { CanvasClient } from '../packages/mcp-fudan-elearning/src/client';
import type { FudanAuth } from '../packages/fudan-auth/src';
import { pptxToMarkdown } from '../src/main/library/parse';
import { AppContext } from '../src/main/app-context';
import { DemoElearningClient } from '../src/main/demo/demo';
import { nullChannels } from '../src/main/engine/channels';

/** eLearning 课件：列文件、下载、导入资源库（接口格式按 Canvas，内容虚构） */
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
const noPermission = () => json({ status: 'unauthorized', errors: [{ message: 'user not authorized to perform that action' }] }, 401);
const client = (fetch: ReturnType<typeof vi.fn>) => new CanvasClient({ fetch } as unknown as FudanAuth);

describe('课件列表与下载', () => {
  it('读「文件」栏目，带上文件夹名，隐藏和锁定的文件不列出', async () => {
    const fetch = vi.fn(async (_p: string, url: string) => {
      if (url.includes('/folders')) return json([{ id: 7, full_name: 'course files/课件' }]);
      return json([
        { id: 11, display_name: '第5讲 链表.pptx', size: 2048000, 'content-type': 'application/vnd.ms-powerpoint', updated_at: '2026-11-01T00:00:00Z', folder_id: 7 },
        { id: 12, display_name: '答案.pdf', locked_for_user: true },
      ]);
    });
    const files = await client(fetch).listFiles('1', '第5讲');
    expect(files).toEqual([{ id: '11', name: '第5讲 链表.pptx', size: 2048000, contentType: 'application/vnd.ms-powerpoint', updatedAt: '2026-11-01T00:00:00Z', folder: '课件' }]);
    expect(String(fetch.mock.calls[0][1])).toContain('search_term=');
  });

  it('老师隐藏了「文件」栏目时，从「单元」里找文件', async () => {
    const fetch = vi.fn(async (_p: string, url: string) => {
      if (url.includes('/courses/1/files?') || url.includes('/folders')) return noPermission();
      if (url.includes('/modules')) return json([{ name: '第 5 周', items: [{ type: 'File', content_id: 21, title: '链表讲义' }, { type: 'Assignment', content_id: 3 }] }]);
      return json({ id: 21, display_name: '链表讲义.pdf', size: 1000 });
    });
    expect(await client(fetch).listFiles('1')).toEqual([{ id: '21', name: '链表讲义.pdf', size: 1000, contentType: undefined, updatedAt: undefined, folder: '第 5 周' }]);
  });

  it('下载：先拿带校验的地址，再用登录会话下载；超大文件不下载', async () => {
    const fetch = vi.fn(async (_p: string, url: string) => {
      if (url.includes('/api/v1/files/11')) return json({ display_name: '第5讲.pdf', size: 3, url: 'https://elearning.fudan.edu.cn/files/11/download?verifier=x' });
      if (url.includes('/api/v1/files/99')) return json({ display_name: '录像.mp4', size: 500 * 1024 * 1024, url: 'https://x' });
      return new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { 'content-type': 'application/pdf' } });
    });
    const file = await client(fetch).downloadFile('11');
    expect(file).toMatchObject({ name: '第5讲.pdf', contentType: 'application/pdf' });
    expect([...file.data]).toEqual([1, 2, 3]);
    expect(fetch.mock.calls[1][1]).toContain('verifier=x');
    await expect(client(fetch).downloadFile('99')).rejects.toThrow('200 MB');
    await expect(client(fetch).downloadFile('../x')).rejects.toThrow('文件 id');
  });
});

describe('PPT 导入资源库', () => {
  it('按页提取文字和备注', async () => {
    const zip = new JSZip();
    const slide = (texts: string[]) => `<p:sld><p:cSld><p:spTree>${texts.map((t) => `<a:p><a:r><a:t>${t}</a:t></a:r></a:p>`).join('')}</p:spTree></p:cSld></p:sld>`;
    zip.file('ppt/slides/slide2.xml', slide(['链表的插入', 'O(1) &amp; O(n)']));
    zip.file('ppt/slides/slide10.xml', slide(['小结']));
    zip.file('ppt/slides/slide1.xml', slide(['第5讲 链表']));
    zip.file('ppt/notesSlides/notesSlide1.xml', slide(['开场先复习数组', '1']));
    const md = await pptxToMarkdown(await zip.generateAsync({ type: 'uint8array' }));
    expect(md).toBe('## 第 1 页\n第5讲 链表\n\n> 备注：开场先复习数组\n\n## 第 2 页\n链表的插入\nO(1) & O(n)\n\n## 第 10 页\n小结');
  });
});

describe('对话里下载课件（演示模式）', () => {
  const cleanups: (() => Promise<void>)[] = [];
  afterEach(async () => { for (const c of cleanups.splice(0)) await c(); });
  it('列出、下载到「下载/Fudaner/课程名」、导入资源库；同名不覆盖', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fudaner-dl-'));
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    const demo = new DemoElearningClient();
    const ctx = new AppContext({ dbPath: ':memory:', channels: nullChannels, elearning: () => demo, mail: () => null, downloadsDir: () => dir });
    cleanups.push(() => ctx.close());
    ctx.repo.setSettings({ demoMode: true });
    await ctx.start();
    await ctx.syncAll();
    const course = ctx.repo.listCourses()[0];
    const list = await ctx.hub.call('fudan_elearning__list_files', { course_code: course.code });
    expect(list.ok).toBe(true);
    const files = JSON.parse(list.text).files as { file_id: string; name: string }[];
    expect(files.length).toBe(2);
    const first = JSON.parse((await ctx.hub.call('fudan_elearning__download_file', { file_id: files[0].file_id, course_code: course.code })).text);
    expect(first.saved_to.startsWith(join(dir, 'Fudaner', course.name))).toBe(true);
    expect(await readFile(first.saved_to, 'utf8')).toContain('演示讲义');
    expect(ctx.repo.getResource(first.resource_id)).toMatchObject({ kind: 'courseware', courseId: course.id });
    const again = JSON.parse((await ctx.hub.call('fudan_elearning__download_file', { file_id: files[0].file_id, course_code: course.code })).text);
    expect(again.saved_to).not.toBe(first.saved_to);
    expect(again.name).toContain('(1)');
    expect(ctx.repo.getKv<{ path: string }[]>('recent_downloads', [])[0].path).toBe(again.saved_to);
    const missing = await ctx.hub.call('fudan_elearning__list_files', { course_code: '不存在的课' });
    expect(missing.ok).toBe(false);
  });
});
