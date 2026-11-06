import { afterEach, describe, expect, it, vi } from 'vitest';
const handlers = vi.hoisted(() => new Map<string, (...args: unknown[]) => Promise<unknown>>());
vi.mock('electron', () => ({ ipcMain: { handle: (name: string, fn: (...args: unknown[]) => Promise<unknown>) => handlers.set(name, fn) } }));
import { Db } from '../src/main/db/db';
import { Repo } from '../src/main/db/repo';
import { registerIpc } from '../src/main/ipc';

const opened: Db[] = [];
afterEach(() => opened.splice(0).forEach((db) => db.close()));
function setup() {
  const db = new Db(':memory:'); opened.push(db);
  const repo = new Repo(db);
  for (let i = 0; i < 260; i++) repo.addMessage({ id: `message-${i}`, role: 'assistant', content: `消息 ${i}`, createdAt: new Date(Date.UTC(2026, 10, 4, 8, i)).toISOString() });
  registerIpc({ repo } as never, {} as never);
  return { repo, history: (limit: number, id?: string) => handlers.get('chat.history')!(undefined, limit, id) as Promise<{ id: string }[]> };
}
describe('通知消息历史定位', () => {
  it('旧通知超过最近 200 条仍返回目标及相邻上下文', async () => {
    const { history } = setup();
    const rows = await history(200, 'message-15');
    expect(rows.map((m) => m.id)).toContain('message-15');
    expect(rows.map((m) => m.id)).toContain('message-14');
    expect(rows.map((m) => m.id)).toContain('message-16');
    expect(rows.length).toBeLessThanOrEqual(200);
  });
  it('通知消息已清理时返回空结果，不能误定位到别的消息', async () => {
    expect(await setup().history(200, 'removed-message')).toEqual([]);
  });
  it('不带定位目标时仍返回最新消息', async () => {
    const { history } = setup();
    const rows = await history(200);
    expect(rows).toHaveLength(200);
    expect(rows.at(-1)?.id).toBe('message-259');
  });
  it('同一时间创建的消息也能确定性地包含目标', async () => {
    const { repo, history } = setup();
    for (let i = 0; i < 260; i++) repo.addMessage({ id: `tie-${i}`, role: 'assistant', content: '同时创建', createdAt: '2026-11-05T00:00:00Z' });
    const rows = await history(20, 'tie-150');
    expect(rows.map((m) => m.id)).toEqual(Array.from({ length: 20 }, (_, i) => `tie-${140 + i}`));
  });
});
