import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { EventEmitter } from 'node:events';
const state = vi.hoisted(() => ({ fetch: vi.fn(), windows: [] as (EventEmitter & { webContents: EventEmitter & { getURL(): string }; close(): void; focus: ReturnType<typeof vi.fn>; isDestroyed(): boolean })[] }));
vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events');
  class Window extends EventEmitter {
    webContents = Object.assign(new EventEmitter(), { getURL: () => 'https://elearning.fudan.edu.cn/' });
    destroyed = false;
    constructor() { super(); state.windows.push(this); }
    focus = vi.fn();
    isDestroyed() { return this.destroyed; }
    close() { this.destroyed = true; this.emit('closed'); }
    loadURL() { return Promise.resolve(); }
  }
  return { BrowserWindow: Window, session: { fromPartition: () => ({ fetch: state.fetch }) } };
});
import { AuthManager } from '../src/main/auth/auth-manager';
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
const settle = async () => { for (let i = 0; i < 15; i++) await Promise.resolve(); };
beforeEach(() => { state.fetch.mockReset(); state.windows.length = 0; });
describe('UIS 登录生命周期', () => {
  it('已有会话无需再次经过 UIS，身份接口通过后关闭窗口', async () => {
    state.fetch.mockResolvedValue(json({ id: 12 }));
    const auth = new AuthManager(); const login = auth.requestLogin();
    state.windows[0].webContents.emit('did-navigate', {}, 'https://elearning.fudan.edu.cn/');
    await login;
    expect(state.windows[0].isDestroyed()).toBe(true);
    expect(await auth.status('elearning')).toBe('ok');
    expect(state.fetch.mock.calls[0][1]).toMatchObject({ credentials: 'include' });
  });
  it('恶意前缀域名不能触发身份验证或关窗', async () => {
    const auth = new AuthManager(); const login = auth.requestLogin(); const rejected = expect(login).rejects.toThrow('完成');
    state.windows[0].webContents.emit('did-navigate', {}, 'https://elearning.fudan.edu.cn.evil.example/');
    expect(state.fetch).not.toHaveBeenCalled();
    state.windows[0].close(); await rejected;
  });
  it('HTML 登录页不能冒充已登录，取消登录会失败', async () => {
    state.fetch.mockResolvedValue(new Response('<html>login</html>'));
    const auth = new AuthManager(); const login = auth.requestLogin(); const rejected = expect(login).rejects.toThrow('完成');
    state.windows[0].webContents.emit('did-navigate', {}, 'https://elearning.fudan.edu.cn/');
    await settle(); expect(state.windows[0].isDestroyed()).toBe(false);
    state.windows[0].close(); await rejected;
  });
  it('重复登录等待同一个窗口完成', async () => {
    const auth = new AuthManager(); const first = auth.requestLogin(); const second = auth.requestLogin();
    expect(second).toBe(first); expect(state.windows).toHaveLength(1);
    const rejected = expect(first).rejects.toThrow(); state.windows[0].close(); await rejected;
  });
  it('401 会更新缓存并要求重新登录', async () => {
    state.fetch.mockResolvedValueOnce(json({ id: 12 })).mockResolvedValueOnce(json({}, 401));
    const auth = new AuthManager(); expect(await auth.status('elearning')).toBe('ok');
    await expect(auth.fetch('elearning', 'https://elearning.fudan.edu.cn/api/v1/courses')).rejects.toThrow('重新登录');
    expect(await auth.status('elearning')).toBe('need_login');
  });
  it('已登录但没有权限的 401（如课程花名册）不算登录过期', async () => {
    state.fetch.mockResolvedValueOnce(json({ id: 12 })).mockResolvedValueOnce(json({ status: 'unauthorized', errors: [{ message: 'user not authorized to perform that action' }] }, 401));
    const auth = new AuthManager(); expect(await auth.status('elearning')).toBe('ok');
    const res = await auth.fetch('elearning', 'https://elearning.fudan.edu.cn/api/v1/courses/1/users');
    expect(res.status).toBe(401);
    expect(await auth.status('elearning')).toBe('ok');
    expect(auth.cachedStatus('elearning')).toBe('ok');
  });
});
