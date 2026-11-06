import { describe, expect, it } from 'vitest';
import { parseFile } from '../src/main/library/parse';
import { Db } from '../src/main/db/db';
import { Repo } from '../src/main/db/repo';

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

it('删除旧资源时同时清理正文分块和搜索索引，保留同名资源', () => {
  const db = new Db(':memory:');
  try {
    const repo = new Repo(db);
    const oldResource = repo.addResource({ title: 'PRD', kind: 'upload', mime: 'text/plain', text: '旧版本内容' });
    const newResource = repo.addResource({ title: 'PRD', kind: 'upload', mime: 'text/plain', text: '新版本内容' });
    expect(repo.search('PRD').map((hit) => hit.id)).toContain(oldResource.id);
    expect(db.get('SELECT id FROM resource_chunks WHERE resource_id = ?', oldResource.id)).toBeDefined();

    repo.removeResource(oldResource.id);
    repo.removeResource(oldResource.id);

    expect(repo.getResource(oldResource.id)).toBeUndefined();
    expect(db.get('SELECT id FROM resource_chunks WHERE resource_id = ?', oldResource.id)).toBeUndefined();
    expect(repo.search('PRD').map((hit) => hit.id)).toEqual([newResource.id]);
  } finally {
    db.close();
  }
});
