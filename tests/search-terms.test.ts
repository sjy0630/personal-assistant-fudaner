import { afterEach, describe, expect, it } from 'vitest';
import { Db } from '../src/main/db/db';
import { Repo } from '../src/main/db/repo';

const dbs: Db[] = [];
afterEach(() => { for (const db of dbs.splice(0)) db.close(); });
function repo() { const db = new Db(':memory:'); dbs.push(db); return new Repo(db); }

describe('多关键词搜索', () => {
  it('邮件查询按空格拆成多个关键词，全部命中即可，不要求整句原样出现', () => {
    const r = repo();
    r.upsertItem({ source: 'mail', kind: 'email', sourceId: 'm1', title: '2027 春季学期赴新加坡国立大学交换项目报名通知', body: '报名截止 11 月 20 日', publishedAt: '2026-11-06T02:00:00.000Z', sender: '国际处 <io@fudan.edu.cn>', done: false });
    r.upsertItem({ source: 'mail', kind: 'email', sourceId: 'm2', title: '2027 届校园招聘宣讲会', body: '欢迎参加', publishedAt: '2026-11-06T02:00:00.000Z', sender: 'hr@example.com', done: false });
    expect(r.listItems({ kind: 'email', query: '新加坡国立大学 交换 2027' }).map(i => i.sourceId)).toEqual(['m1']);
    expect(r.listItems({ kind: 'email', query: '  交换  ' }).map(i => i.sourceId)).toEqual(['m1']);
    expect(r.listItems({ kind: 'email', query: '交换 宣讲会' })).toEqual([]);
  });

  it('资源搜索多个词同时命中为空时退回任一词命中并去重', () => {
    const r = repo();
    const handout = r.addResource({ title: '数据结构-期中复习讲义', kind: 'upload', mime: 'text/markdown', text: '期中考试范围：第 1–6 章，复习重点是链表。' });
    expect(r.search('复习 讲义 提纲').map(h => h.id)).toEqual([handout.id]);
    expect(r.search('复习 讲义').map(h => h.id)).toEqual([handout.id]);
    expect(r.search('提纲 大纲')).toEqual([]);
  });
});
