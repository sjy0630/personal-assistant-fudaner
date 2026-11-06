import { beforeEach, describe, expect, it, vi } from 'vitest';
const mock = vi.hoisted(() => ({ connect: vi.fn(), logout: vi.fn(), search: vi.fn(), fetch: vi.fn(), lock: vi.fn(), release: vi.fn(), config: vi.fn() }));
vi.mock('imapflow', () => ({ ImapFlow: class {
  constructor(config: unknown) { mock.config(config); }
  connect = mock.connect; logout = mock.logout; search = mock.search; fetch = mock.fetch; getMailboxLock = mock.lock;
} }));
import { ImapMailClient } from '../packages/mcp-fudan-mail/src/client';
const client = () => new ImapMailClient({ host: 'imap.example.com', port: 993, user: 'student@example.com', password: 'test-only' });
beforeEach(() => {
  vi.clearAllMocks();
  mock.connect.mockResolvedValue(undefined); mock.logout.mockResolvedValue(undefined);
  mock.lock.mockResolvedValue({ release: mock.release });
  mock.search.mockResolvedValue(Array.from({ length: 205 }, (_, n) => n + 1));
  mock.fetch.mockImplementation(async function* (uids: number[]) {
    for (const uid of uids) yield { uid, source: Buffer.from(`From: Teacher <ta@example.com>\r\nSubject: Homework ${uid}\r\nMessage-ID: <${uid}@example.com>\r\nDate: Fri, 6 Nov 2026 08:00:00 +0800\r\n\r\nPlease read.`) };
  });
});
describe('IMAP 只读同步', () => {
  it('超过 200 封全部按批读取，INBOX 只读，关闭连接', async () => {
    const rows = await client().fetchSince(new Date('2026-11-01'));
    expect(rows).toHaveLength(205);
    expect(mock.fetch.mock.calls.map((c) => c[0].length)).toEqual([100, 100, 5]);
    expect(mock.lock).toHaveBeenCalledWith('INBOX', { readOnly: true });
    expect(mock.release).toHaveBeenCalledOnce(); expect(mock.logout).toHaveBeenCalledOnce();
    expect(mock.config.mock.calls[0][0]).toMatchObject({ secure: true, connectionTimeout: 20000, socketTimeout: 60000 });
  });
  it('显式数量限制和零限制有效', async () => {
    expect(await client().fetchSince(new Date(), 2)).toHaveLength(2);
    expect(await client().fetchSince(new Date(), 0)).toHaveLength(0);
  });
  it('连接认证失败也清理连接，不暴露原始错误', async () => {
    mock.connect.mockRejectedValueOnce(Object.assign(new Error('secret'), { authenticationFailed: true }));
    await expect(client().fetchSince(new Date())).rejects.toThrow('客户端专用密码');
    expect(mock.logout).toHaveBeenCalledOnce();
  });
  it('读取中途断线不返回部分结果，释放锁和连接', async () => {
    mock.fetch.mockImplementationOnce(async function* () { throw new Error('socket'); yield undefined; });
    await expect(client().fetchSince(new Date())).rejects.toThrow('网络');
    expect(mock.release).toHaveBeenCalledOnce(); expect(mock.logout).toHaveBeenCalledOnce();
  });
});
