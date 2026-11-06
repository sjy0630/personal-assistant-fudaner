import { describe, expect, it, vi } from 'vitest';
const handlers = vi.hoisted(() => new Map<string, (...args: unknown[]) => Promise<unknown>>());
vi.mock('electron', () => ({
  ipcMain: {
    handle: (name: string, fn: (...args: unknown[]) => Promise<unknown>) => handlers.set(name, fn),
  },
}));
import { registerIpc } from '../src/main/ipc';

describe('设置页手动同步', () => {
  it('开发者的同步运行也不能吞掉数据源错误', async () => {
    const ctx = {
      repo: {},
      syncAll: async () => ({ errors: ['offline'] }),
      engine: { tick: async () => [] },
      executor: { runNext: async () => undefined },
    };
    registerIpc(ctx as never, {} as never);
    await expect(handlers.get('dev.tick')!(undefined)).rejects.toThrow('同步');
  });
  it('来源报告失败时向页面返回失败，避免误报已同步', async () => {
    const ctx = {
      repo: {},
      syncAll: async () => ({ errors: ['eLearning: expired'] }),
      engine: { tick: async () => [] },
    };
    registerIpc(ctx as never, {} as never);
    await expect(handlers.get('platforms.syncNow')!(undefined)).rejects.toThrow('同步');
  });
  it('来源成功时正常完成', async () => {
    const ctx = {
      repo: {},
      syncAll: async () => ({ errors: [] }),
      engine: { tick: async () => [] },
    };
    registerIpc(ctx as never, {} as never);
    await expect(handlers.get('platforms.syncNow')!(undefined)).resolves.toBeUndefined();
  });
});
