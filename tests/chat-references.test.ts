import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveChatReference, safeExternalUrl } from '../src/main/chat/references';
import { Db } from '../src/main/db/db';
import { Repo } from '../src/main/db/repo';
import type { CardRef, Goal, Item, ReferenceOpenResult } from '../src/shared/types';

let db: Db;
let repo: Repo;
beforeEach(() => { db = new Db(':memory:'); repo = new Repo(db); });
afterEach(() => db.close());

function item(patch: Partial<Omit<Item, 'id'>> = {}) {
  return repo.upsertItem({
    source: 'mail', kind: 'email', sourceId: 'mail-1', title: '真实邮件标题',
    body: '请在周五前回复。\n谢谢。', publishedAt: '2026-11-05T09:00:00Z', done: false,
    sender: '王老师 <wang@example.com>', ...patch,
  }).item;
}

function goal(status: Goal['status'] = 'active') {
  return repo.addGoal({ title: '真实目标标题', level: 'week', description: '准备期中考试', createdBy: 'user', status });
}

function detail(result: ReferenceOpenResult) {
  expect(result.kind).toBe('detail');
  if (result.kind !== 'detail') throw new Error('预期详情');
  return result.detail;
}

describe('外部引用 URL 安全校验', () => {
  it.each([
    ['https://elearning.fudan.edu.cn/courses/1?x=2#assignment', 'https://elearning.fudan.edu.cn/courses/1?x=2#assignment'],
    [' http://example.com/a ', 'http://example.com/a'],
    ['HTTPS://EXAMPLE.COM/a', 'https://example.com/a'],
  ])('允许无凭证的 http/https 绝对链接 %s', (value, expected) => {
    expect(safeExternalUrl(value)).toBe(expected);
  });

  it.each([
    undefined, '', 'not a url', '/relative', '//example.com/path', 'https:example.com',
    'javascript:alert(1)', 'data:text/html,hello', 'file:///C:/Users/secret.txt',
    'mailto:wang@example.com', 'ftp://example.com/file', 'shell:Downloads',
    'ms-settings:privacy', 'https://user:password@example.com/', 'https://user@example.com/',
    'https://:password@example.com/', 'https://%75ser@example.com/', 'https://',
    'ht\ntps://example.com',
  ])('拒绝危险、本地、相对、无效或带凭证的链接 %s', (value) => {
    expect(safeExternalUrl(value)).toBeNull();
  });
});

describe('主对话引用解析', () => {
  it.each(['assignment', 'email', 'announcement', 'notice', 'replay'] as const)('有有效链接的 %s 打开原网页', (kind) => {
    const saved = item({ kind, url: 'https://example.com/original' });
    expect(resolveChatReference(repo, { type: 'item', id: saved.id })).toEqual({ kind: 'external', url: 'https://example.com/original' });
  });

  it('无 URL 的邮件展示数据库正文和发件人，不采用调用方标题', () => {
    const saved = item({ dueAt: '2026-11-06T10:00:00Z' });
    const ref = { type: 'item', id: saved.id, title: '伪造标题' } as CardRef;
    const value = detail(resolveChatReference(repo, ref));
    expect(value.title).toBe('真实邮件标题');
    expect(value.body).toBe('请在周五前回复。\n谢谢。');
    expect(value.fields).toEqual(expect.arrayContaining([
      { label: '发件人', value: '王老师 <wang@example.com>' },
      { label: '截止时间', value: '2026-11-06T10:00:00Z' },
    ]));
  });

  it.each(['javascript:alert(1)', 'file:///C:/secret.txt', 'https://user:pass@example.com', 'invalid'])('事项含不安全 URL 时仍能安全读取正文 %s', (url) => {
    const saved = item({ url });
    expect(detail(resolveChatReference(repo, { type: 'item', id: saved.id })).body).toContain('请在周五前回复');
  });

  it('资源跳转到资源库中的真实对象', () => {
    const saved = repo.addResource({ title: '复习提纲', kind: 'assistant_output', mime: 'text/markdown', text: '复习内容' });
    expect(resolveChatReference(repo, { type: 'resource', id: saved.id })).toEqual({ kind: 'page', page: 'library', id: saved.id });
  });

  it.each(['active', 'done'] as const)('%s 目标跳转到目标页', (status) => {
    const saved = goal(status);
    expect(resolveChatReference(repo, { type: 'goal', id: saved.id })).toEqual({ kind: 'page', page: 'goals', id: saved.id });
  });

  it('归档目标展示详情和状态', () => {
    const saved = goal('archived');
    const value = detail(resolveChatReference(repo, { type: 'goal', id: saved.id }));
    expect(value.title).toBe('真实目标标题');
    expect(value.body).toBe('准备期中考试');
    expect(value.fields).toContainEqual({ label: '状态', value: '已归档' });
  });

  it.each(['active', 'done'] as const)('属于 %s 目标的任务用任务 ID 定位目标页', (status) => {
    const parent = goal(status);
    const saved = repo.addTask({ title: '完成习题', goalId: parent.id, source: 'user' });
    expect(resolveChatReference(repo, { type: 'task', id: saved.id })).toEqual({ kind: 'page', page: 'goals', id: saved.id });
  });

  it('孤立任务展示任务详情、截止时间和状态', () => {
    const saved = repo.addTask({ title: '独立任务', dueAt: '2026-11-07T12:00:00Z', source: 'user' });
    const value = detail(resolveChatReference(repo, { type: 'task', id: saved.id }));
    expect(value.title).toBe('独立任务');
    expect(value.fields).toEqual(expect.arrayContaining([
      { label: '截止时间', value: '2026-11-07T12:00:00Z' }, { label: '状态', value: '待完成' },
    ]));
  });

  it('关联归档目标的任务展示详情', () => {
    const parent = goal('archived');
    const saved = repo.addTask({ title: '归档目标中的任务', goalId: parent.id, source: 'user' });
    expect(detail(resolveChatReference(repo, { type: 'task', id: saved.id })).title).toBe('归档目标中的任务');
  });

  it('仍可见的动态跳转到动态列表，被忽略的动态展示原文详情', () => {
    const saved = repo.addFeedCard({ type: 'insight', title: '学习建议', body: '每天复习半小时', reason: '即将期中', refs: [], actions: [], score: 0.5 })!;
    expect(resolveChatReference(repo, { type: 'feed', id: saved.id })).toEqual({ kind: 'page', page: 'feed', id: saved.id });
    repo.setFeedStatus(saved.id, 'dismissed', '暂时不需要');
    const value = detail(resolveChatReference(repo, { type: 'feed', id: saved.id }));
    expect(value.title).toBe('学习建议');
    expect(value.body).toBe('每天复习半小时');
    expect(value.fields).toContainEqual({ label: '忽略原因', value: '暂时不需要' });
  });

  it('工单详情包含请求、状态和来自数据库的成果资源及目标引用', () => {
    const parent = goal();
    const resource = repo.addResource({ title: '真实成果标题', kind: 'assistant_output', mime: 'text/plain', text: '完成内容' });
    const saved = repo.addTicket({ title: '整理资料', request: '整理本周全部课件', mandate: 'explicit', status: 'working', goalId: parent.id });
    repo.setTicketStatus(saved.id, 'done', resource.id);
    const value = detail(resolveChatReference(repo, { type: 'ticket', id: saved.id }));
    expect(value.title).toBe('整理资料');
    expect(value.body).toBe('整理本周全部课件');
    expect(value.fields).toContainEqual({ label: '状态', value: '已完成' });
    expect(value.related).toEqual(expect.arrayContaining([
      { type: 'resource', id: resource.id, title: '真实成果标题' },
      { type: 'goal', id: parent.id, title: '真实目标标题' },
    ]));
  });

  it('没有成果和关联目标的工单也可查看', () => {
    const saved = repo.addTicket({ title: '等待资料', request: '提供课件', mandate: 'explicit', status: 'waiting_user' });
    const value = detail(resolveChatReference(repo, { type: 'ticket', id: saved.id }));
    expect(value.body).toBe('提供课件');
    expect(value.fields).toContainEqual({ label: '状态', value: '等待你补充' });
    expect(value.related ?? []).toEqual([]);
  });

  it.each(['item', 'goal', 'task', 'resource', 'feed', 'ticket'] as const)('不存在的 %s 引用给出中文错误', (type) => {
    expect(() => resolveChatReference(repo, { type, id: 'missing-id' })).toThrow(/[\u4e00-\u9fff]/);
  });

  it('已删除对象不能凭旧引用打开', () => {
    const saved = item({ url: 'https://example.com/old' });
    repo.wipe();
    expect(() => resolveChatReference(repo, { type: 'item', id: saved.id })).toThrow(/[\u4e00-\u9fff]/);
  });

  it.each([null, undefined, {}, { type: 'item' }, { type: 'item', id: '' }, { type: 'item', id: '   ' }, { type: 'item', id: 7 }, { type: 'unknown', id: 'x' }])('拒绝运行时不合法的引用 %j', (ref) => {
    expect(() => resolveChatReference(repo, ref as Pick<CardRef, 'type' | 'id'>)).toThrow(/[\u4e00-\u9fff]/);
  });
});
