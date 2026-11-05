import { afterEach, describe, expect, it } from 'vitest';
import { Db } from '../src/main/db/db';
import { Repo } from '../src/main/db/repo';
import type { CardRef, ChatMessage } from '../src/shared/types';

const opened: Db[] = [];
afterEach(() => opened.splice(0).forEach(db => db.close()));
function setup(): Repo {
  const db = new Db(':memory:');
  opened.push(db);
  return new Repo(db);
}
const card = (type: CardRef['type'], id: string): CardRef => ({ type, id, title: '结果' });
function message(repo: Repo, cards: CardRef[], role: ChatMessage['role'] = 'assistant'): ChatMessage {
  return repo.addMessage({ role, content: '已经创建', cards: repo.prepareUndoCards(cards) });
}
function goal(repo: Repo) { return repo.addGoal({ level: 'week', title: '本周阅读', createdBy: 'assistant' }); }
function task(repo: Repo, goalId?: string) { return repo.addTask({ title: '阅读第一章', source: 'assistant', goalId }); }
function resource(repo: Repo) { return repo.addResource({ title: '阅读成果', kind: 'assistant_output', mime: 'text/markdown', text: '本轮整理的内容', path: 'C:/do-not-delete/report.md' }); }
function count(repo: Repo, table: string, column: string, id: string): number {
  return repo.db.get<{ n: number }>(`SELECT count(*) AS n FROM ${table} WHERE ${column}=?`, id)!.n;
}

describe('安全撤销助理本轮写入', () => {
  it('撤销目标及其任务，清理全部索引并把同消息附属任务标为已撤销', () => {
    const repo = setup(), g = goal(repo), t = task(repo, g.id);
    const m = message(repo, [card('goal', g.id), card('task', t.id)]);
    expect(m.cards.every(c => typeof c.undoToken === 'string')).toBe(true);
    const updated = repo.undoMessageResult(m.id, 'goal', g.id);
    expect(repo.getGoal(g.id)).toBeUndefined();
    expect(repo.getTask(t.id)).toBeUndefined();
    expect(count(repo, 'search_index', 'object_id', g.id)).toBe(0);
    expect(count(repo, 'search_index', 'object_id', t.id)).toBe(0);
    expect(updated.cards.map(c => c.undone)).toEqual([true, true]);
    expect(repo.getMessage(m.id)).toEqual(updated);
    expect(repo.undoMessageResult(m.id, 'goal', g.id)).toEqual(updated);
    expect(repo.undoMessageResult(m.id, 'task', t.id)).toEqual(updated);
  });

  it('资源撤销清理分块和搜索，任务撤销只删除对应任务', () => {
    const repo = setup(), r = resource(repo), t = task(repo), keep = task(repo);
    const m = message(repo, [card('resource', r.id), card('task', t.id)]);
    expect(count(repo, 'resource_chunks', 'resource_id', r.id)).toBeGreaterThan(0);
    repo.undoMessageResult(m.id, 'resource', r.id);
    expect(repo.getResource(r.id)).toBeUndefined();
    expect(count(repo, 'resource_chunks', 'resource_id', r.id)).toBe(0);
    expect(count(repo, 'search_index', 'object_id', r.id)).toBe(0);
    const updated = repo.undoMessageResult(m.id, 'task', t.id);
    expect(repo.getTask(t.id)).toBeUndefined();
    expect(count(repo, 'search_index', 'object_id', t.id)).toBe(0);
    expect(repo.getTask(keep.id)).toBeDefined();
    expect(updated.cards.map(c => c.undone)).toEqual([true, true]);
  });

  it.each(['goal', 'task', 'resource'] as const)('后续修改 %s 时拒绝撤销且不改消息', type => {
    const repo = setup(), entity = type === 'goal' ? goal(repo) : type === 'task' ? task(repo) : resource(repo);
    const m = message(repo, [card(type, entity.id)]);
    const table = { goal: 'goals', task: 'tasks', resource: 'resources' }[type];
    repo.db.run(`UPDATE ${table} SET title=? WHERE id=?`, '用户已修改', entity.id);
    expect(() => repo.undoMessageResult(m.id, type, entity.id)).toThrow(/[\u4e00-\u9fff]/);
    expect(count(repo, table, 'id', entity.id)).toBe(1);
    expect(repo.getMessage(m.id)).toEqual(m);
  });

  it('目标补入新任务或任务提醒状态变化后拒绝整体撤销', () => {
    const repo = setup(), g = goal(repo), t = task(repo, g.id);
    const m = message(repo, [card('goal', g.id)]);
    repo.markReminderSent(t.id, 'later');
    expect(() => repo.undoMessageResult(m.id, 'goal', g.id)).toThrow();
    const g2 = goal(repo), m2 = message(repo, [card('goal', g2.id)]), added = task(repo, g2.id);
    expect(() => repo.undoMessageResult(m2.id, 'goal', g2.id)).toThrow();
    expect(repo.getGoal(g2.id)).toBeDefined();
    expect(repo.getTask(added.id)).toBeDefined();
  });

  it('仅为助理可删除来源签发权限，输入伪造 token 也会剥除', () => {
    const repo = setup();
    const goals = [
      repo.addGoal({ level: 'week', title: '用户目标', createdBy: 'user' }),
      repo.addGoal({ level: 'week', title: '系统目标', createdBy: 'system' }),
      repo.addGoal({ level: 'course', title: '课程目标', createdBy: 'assistant' }),
    ];
    const mixed = goal(repo); repo.addTask({ goalId: mixed.id, title: '用户任务', source: 'user' }); goals.push(mixed);
    const school = task(repo); repo.db.run('UPDATE tasks SET item_id=? WHERE id=?', 'school-item', school.id);
    const user = repo.addTask({ title: '用户任务', source: 'user' });
    const imported = repo.addTask({ title: '平台任务', source: 'elearning' });
    const uploads = ['upload', 'courseware', 'replay_note'].map(kind => repo.addResource({ title: '资料', kind: kind as 'upload' | 'courseware' | 'replay_note', mime: 'text/plain', text: '原资料' }));
    const cards = [...goals.map(g => card('goal', g.id)), ...[school, user, imported].map(t => card('task', t.id)), ...uploads.map(r => card('resource', r.id)), ...(['ticket', 'feed', 'item'] as const).map(type => card(type, 'other'))];
    const prepared = repo.prepareUndoCards(cards.map(c => ({ ...c, undoToken: 'forged', undone: true })));
    expect(prepared.every(c => c.undoToken === undefined && !c.undone)).toBe(true);
    const m = repo.addMessage({ role: 'assistant', content: '只读卡片', cards: prepared });
    for (const c of prepared) expect(() => repo.undoMessageResult(m.id, c.type, c.id)).toThrow();
    expect(goals.every(g => repo.getGoal(g.id))).toBe(true);
    expect(repo.getTask(school.id)).toBeDefined();
    expect(repo.getResource(uploads[0].id)).toBeDefined();
  });

  it('不接受跨消息对象、缺少服务端权限、用户或工具消息的撤销请求', () => {
    const repo = setup(), a = task(repo), b = task(repo);
    const m = message(repo, [card('task', a.id)]);
    const other = message(repo, [card('task', b.id)]);
    const unsigned = repo.addMessage({ role: 'assistant', content: '引用', cards: [card('task', b.id)] });
    const user = message(repo, [card('task', a.id)], 'user');
    const tool = message(repo, [card('task', a.id)], 'tool');
    for (const id of [m.id, unsigned.id, user.id, tool.id, 'missing']) {
      const target = id === user.id || id === tool.id ? a.id : b.id;
      expect(() => repo.undoMessageResult(id, 'task', target)).toThrow();
    }
    expect(() => repo.undoMessageResult(other.id, 'resource', b.id)).toThrow();
    expect(repo.getTask(a.id)).toBeDefined(); expect(repo.getTask(b.id)).toBeDefined();
  });

  it('先撤销同消息的任务，再撤销未被改动的父目标', () => {
    const repo = setup(), g = goal(repo), a = task(repo, g.id), b = task(repo, g.id);
    const m = message(repo, [card('goal', g.id), card('task', a.id), card('task', b.id)]);
    repo.undoMessageResult(m.id, 'task', a.id);
    repo.undoMessageResult(m.id, 'task', b.id);
    const result = repo.undoMessageResult(m.id, 'goal', g.id);
    expect(repo.getGoal(g.id)).toBeUndefined();
    expect(result.cards.every(c => c.undone)).toBe(true);
  });

  it('任务撤销不能刷新已经被用户修改的父目标或其他结果权限', () => {
    const repo = setup(), g = goal(repo), a = task(repo, g.id), b = task(repo, g.id), r = resource(repo);
    const m = message(repo, [card('goal', g.id), card('task', a.id), card('task', b.id), card('resource', r.id)]);
    repo.db.run('UPDATE goals SET description=? WHERE id=?', '后来修改', g.id);
    repo.db.run('UPDATE resources SET text=? WHERE id=?', '后来修改', r.id);
    repo.undoMessageResult(m.id, 'task', a.id);
    expect(() => repo.undoMessageResult(m.id, 'goal', g.id)).toThrow();
    expect(() => repo.undoMessageResult(m.id, 'resource', r.id)).toThrow();
    expect(repo.getGoal(g.id)).toBeDefined(); expect(repo.getTask(b.id)).toBeDefined();
  });

  it('后来补任务不能借撤销旧任务恢复父目标权限', () => {
    const repo = setup(), g = goal(repo), a = task(repo, g.id);
    const m = message(repo, [card('goal', g.id), card('task', a.id)]);
    const added = task(repo, g.id);
    repo.undoMessageResult(m.id, 'task', a.id);
    expect(() => repo.undoMessageResult(m.id, 'goal', g.id)).toThrow();
    expect(repo.getTask(added.id)).toBeDefined();
  });

  it('目标和成果只要关联工单就拒绝签发或执行撤销', () => {
    const repo = setup(), g = goal(repo), r = resource(repo);
    const m = message(repo, [card('goal', g.id), card('resource', r.id)]);
    const ticket = repo.addTicket({ title: '执行', request: '继续处理', mandate: 'explicit', status: 'working', goalId: g.id });
    repo.setTicketStatus(ticket.id, 'done', r.id);
    expect(repo.prepareUndoCards([card('goal', g.id), card('resource', r.id)]).every(c => !c.undoToken)).toBe(true);
    expect(() => repo.undoMessageResult(m.id, 'goal', g.id)).toThrow();
    expect(() => repo.undoMessageResult(m.id, 'resource', r.id)).toThrow();
    expect(repo.getGoal(g.id)).toBeDefined(); expect(repo.getResource(r.id)).toBeDefined();
  });

  it('数据库更新消息失败时整体回滚实体、分块和索引', () => {
    const repo = setup(), r = resource(repo), m = message(repo, [card('resource', r.id)]);
    repo.db.raw.exec("CREATE TRIGGER block_undo BEFORE UPDATE ON chat_messages BEGIN SELECT RAISE(ABORT, '模拟消息更新失败'); END");
    expect(() => repo.undoMessageResult(m.id, 'resource', r.id)).toThrow('模拟消息更新失败');
    expect(repo.getResource(r.id)).toBeDefined();
    expect(count(repo, 'resource_chunks', 'resource_id', r.id)).toBeGreaterThan(0);
    expect(count(repo, 'search_index', 'object_id', r.id)).toBe(1);
    expect(repo.getMessage(m.id)).toEqual(m);
  });
});
