import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FudanerApi } from '../src/shared/ipc';
const bridge = vi.hoisted(() => ({ api: null as FudanerApi | null, listeners: new Set<(...args: unknown[]) => void>() }));
vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: (_key: string, api: FudanerApi) => { bridge.api = api; } },
  ipcRenderer: { invoke: vi.fn(), on: (_event: string, cb: (...args: unknown[]) => void) => bridge.listeners.add(cb), removeListener: (_event: string, cb: (...args: unknown[]) => void) => bridge.listeners.delete(cb) },
  webUtils: { getPathForFile: vi.fn() },
}));
const emit = (payload: unknown) => { for (const cb of bridge.listeners) cb(undefined, 'navigate', payload); };
beforeEach(async () => { vi.resetModules(); bridge.listeners.clear(); await import('../src/preload/index'); });
describe('通知导航的启动缓冲', () => {
  it('页面订阅前点击的通知保留最新目标', async () => {
    emit({ page: 'chat', id: 'first' }); emit({ page: 'chat', id: 'latest' });
    const cb = vi.fn(); bridge.api!.on('navigate', cb); await Promise.resolve();
    expect(cb).toHaveBeenCalledExactlyOnceWith({ page: 'chat', id: 'latest' });
  });
  it('缓冲的旧目标不能覆盖刚收到的新通知', async () => {
    emit({ page: 'chat', id: 'old' });
    const cb = vi.fn(); bridge.api!.on('navigate', cb); emit({ page: 'chat', id: 'new' }); await Promise.resolve();
    expect(cb).toHaveBeenCalledExactlyOnceWith({ page: 'chat', id: 'new' });
  });
  it('取消订阅后缓冲目标留给下一次订阅（兼容 StrictMode）', async () => {
    emit({ page: 'chat', id: 'pending' });
    const old = vi.fn(); const off = bridge.api!.on('navigate', old); off();
    const current = vi.fn(); bridge.api!.on('navigate', current); await Promise.resolve();
    expect(old).not.toHaveBeenCalled(); expect(current).toHaveBeenCalledExactlyOnceWith({ page: 'chat', id: 'pending' });
  });
  it('正常订阅时保留重复点击，并正确取消监听', () => {
    const cb = vi.fn(); const off = bridge.api!.on('navigate', cb);
    emit({ page: 'chat', id: 'same' }); emit({ page: 'chat', id: 'same' }); off(); emit({ page: 'chat', id: 'after' });
    expect(cb).toHaveBeenCalledTimes(2);
  });
});
