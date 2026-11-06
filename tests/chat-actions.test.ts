import { afterEach, expect, it, vi } from 'vitest';
import { Db } from '../src/main/db/db';
import { Repo } from '../src/main/db/repo';
import { registerIpc } from '../src/main/ipc';

const handlers = vi.hoisted(() => new Map<string, (...args: unknown[]) => Promise<unknown>>());
vi.mock('electron', () => ({ ipcMain: { handle: (name: string, fn: (...args: unknown[]) => Promise<unknown>) => handlers.set(name, fn) } }));

const opened: Db[] = [];
afterEach(() => opened.splice(0).forEach((db) => db.close()));

function setup() {
  const db = new Db(':memory:');
  opened.push(db);
  const repo = new Repo(db);
  const runNext = vi.fn(async () => null);
  const onMessage = vi.fn();
  const handleUserMessage = vi.fn<(text: string) => Promise<void>>().mockResolvedValue(undefined);
  registerIpc({ repo, agent: { state: () => null, handleUserMessage }, executor: { runNext } } as never, { onMessageUpdated: onMessage } as never);
  return { repo, runNext, onMessage, handleUserMessage, action: (id: string, kind: string, payload?: Record<string, unknown>) => handlers.get('chat.quickAction')!(undefined, id, kind, payload) };
}

it('仅执行原消息里的按钮，且一次工单决策同步更新两枚按钮', async () => {
  const { repo, action, runNext, onMessage } = setup();
  const first = repo.addTicket({ title: '材料清单', request: '整理材料', mandate: 'inferred', status: 'suggested' });
  const second = repo.addTicket({ title: '复习提纲', request: '整理提纲', mandate: 'inferred', status: 'suggested' });
  const payload = { ticketId: first.id };
  const msg = repo.addMessage({ role: 'assistant', content: '要我帮忙吗？', actions: [
    { label: '好', action: 'accept_ticket', payload }, { label: '不用', action: 'decline_ticket', payload },
  ] });
  await expect(action(msg.id, 'accept_ticket', { ticketId: second.id })).rejects.toThrow();
  expect(repo.getTicket(second.id)?.status).toBe('suggested');
  await action(msg.id, 'accept_ticket', payload);
  expect(repo.getTicket(first.id)?.status).toBe('queued');
  await expect(action(msg.id, 'decline_ticket', payload)).rejects.toThrow();
  expect(runNext).toHaveBeenCalledTimes(1);
  expect(repo.getMessage(msg.id)?.actions.map((button) => button.used)).toEqual([true, true]);
  expect(onMessage).toHaveBeenCalledWith(repo.getMessage(msg.id));
});

it('动态与对话共享同一次工单决策', async () => {
  const { repo, action, runNext, onMessage } = setup();
  const ticket = repo.addTicket({ title: '材料清单', request: '整理材料', mandate: 'inferred', status: 'suggested' });
  const payload = { ticketId: ticket.id };
  const button = { label: '好', action: 'accept_ticket', payload };
  const message = repo.addMessage({ role: 'assistant', content: '建议整理材料', actions: [button] });
  const card = repo.addFeedCard({ type: 'suggest_ticket', title: '材料清单', body: '整理材料', reason: '建议', refs: [], actions: [button], score: 0.8, dedupeKey: `ticket:${ticket.id}` })!;
  const feedAction = () => handlers.get('feed.act')!(undefined, card.id, 'accept_ticket');
  await feedAction();
  expect(repo.getFeedCard(card.id)?.status).toBe('accepted');
  expect(repo.getMessage(message.id)?.actions[0].used).toBe(true);
  expect(onMessage).toHaveBeenCalledWith(repo.getMessage(message.id));
  await expect(action(message.id, 'accept_ticket', payload)).rejects.toThrow();
  await expect(feedAction()).rejects.toThrow();
  expect(runNext).toHaveBeenCalledTimes(1);
});

it('阻止等待中的重复发送，失败后保留原按钮供重试', async () => {
  const { repo, action, handleUserMessage } = setup();
  const payload = { text: '帮我看看今天的安排' };
  const msg = repo.addMessage({ role: 'assistant', content: '看日程？', actions: [{ label: '好', action: 'say', payload }] });
  let reject!: (error: Error) => void;
  handleUserMessage.mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail; }));
  const first = action(msg.id, 'say', payload);
  await expect(action(msg.id, 'say', payload)).rejects.toThrow();
  reject(new Error('busy'));
  await expect(first).rejects.toThrow('busy');
  expect(repo.getMessage(msg.id)?.actions[0].used).toBeUndefined();
  await action(msg.id, 'say', payload);
  expect(repo.getMessage(msg.id)?.actions[0].used).toBe(true);
  expect(handleUserMessage).toHaveBeenCalledTimes(2);
});
