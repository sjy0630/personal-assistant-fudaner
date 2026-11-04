import { describe, expect, it } from 'vitest';
import { parseFile } from '../src/main/library/parse';

/** 资源库文件解析：演示用的复习讲义（PDF 与 Markdown）都能取出中文正文 */
describe('资源库文件解析', () => {
  it('PDF：能提取中文正文', async () => {
    const r = await parseFile('demo-assets/数据结构-期中复习讲义.pdf');
    expect(r.mime).toBe('application/pdf');
    expect(r.title).toBe('数据结构-期中复习讲义');
    expect(r.text).toContain('二叉搜索树');
  });

  it('Markdown：原样读取', async () => {
    const r = await parseFile('demo-assets/数据结构-期中复习讲义.md');
    expect(r.mime).toBe('text/markdown');
    expect(r.text).toContain('循环队列判空');
  });

  it('不支持的类型给出清楚的提示', async () => {
    await expect(parseFile('resources/icon.png')).rejects.toThrow('暂不支持的文件类型');
  });
});
