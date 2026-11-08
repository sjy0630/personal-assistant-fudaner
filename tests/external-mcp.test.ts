import { afterEach, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { McpHub } from '../src/main/mcp/hub';
import { childEnv, externalServerName, launchOf, sanitizeExternal, toolAllowed, EXTERNAL_PRESETS } from '../src/main/mcp/external';
import { AppContext } from '../src/main/app-context';
import { nullChannels } from '../src/main/engine/channels';
import type { ExternalMcpConfig } from '../src/shared/types';

const FAKE = join(__dirname, 'fixtures', 'fake-mcp-server.mjs');
const custom = (patch: Partial<ExternalMcpConfig> = {}): ExternalMcpConfig => ({ id: 'fake', preset: 'custom', name: '假服务', enabled: true, command: process.execPath, args: [FAKE], ...patch });

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const c of cleanups.splice(0)) await c(); });

describe('外部 MCP 服务：连接与权限', () => {
  it('只开放只读工具；没开放的工具模型看不到、也调不到', async () => {
    const hub = new McpHub();
    cleanups.push(() => hub.close());
    const cfg = custom();
    const r = await hub.connectStdio(externalServerName(cfg), { ...launchOf(cfg), env: childEnv() }, (t) => toolAllowed(cfg, t), { timeoutMs: 20_000 });
    expect(r).toEqual({ tools: ['search_holes'], blocked: ['sports_book'] });
    expect(hub.llmTools().map((t) => t.function.name)).toEqual(['ext_fake__search_holes']);
    expect(await hub.call('ext_fake__search_holes', { keyword: '食堂' })).toMatchObject({ ok: true, text: '找到关于「食堂」的 2 条结果' });
    const blocked = await hub.call('ext_fake__sports_book', { venue: '正大' });
    expect(blocked.ok).toBe(false);
    expect(blocked.text).toContain('没有开放');
  });

  it('自定义服务勾选「开放全部工具」后才开放写操作', async () => {
    const hub = new McpHub();
    cleanups.push(() => hub.close());
    const cfg = custom({ allowAllTools: true });
    const r = await hub.connectStdio(externalServerName(cfg), { ...launchOf(cfg), env: childEnv() }, (t) => toolAllowed(cfg, t), { timeoutMs: 20_000 });
    expect(r.tools).toEqual(['search_holes', 'sports_book']);
  });

  it('命令找不到、服务启动就退出时，给出能看懂的原因', async () => {
    const hub = new McpHub();
    cleanups.push(() => hub.close());
    await expect(hub.connectStdio('ext-x', { command: 'definitely-not-a-command-fudaner', args: [] }, () => true, { timeoutMs: 5_000 })).rejects.toThrow('找不到命令');
    await expect(hub.connectStdio('ext-y', { command: process.execPath, args: [FAKE], env: { ...childEnv(), FAKE_MCP_CRASH: '1' } }, () => true, { timeoutMs: 10_000 })).rejects.toThrow('missing credentials');
  });
});

describe('预设', () => {
  it('ehall 没填文件夹时提示', () => {
    expect(() => launchOf({ id: 'ehall', preset: 'ehall', name: 'ehall', enabled: true, dir: '' })).toThrow('文件夹路径');
    expect(launchOf({ id: 'ehall', preset: 'ehall', name: 'ehall', enabled: true, dir: '/Users/me/ehall' })).toMatchObject({ command: 'uv', cwd: '/Users/me/ehall' });
  });

  it('ehall 只开放查询，预约和取消不开放', () => {
    const ehall: ExternalMcpConfig = { id: 'ehall', preset: 'ehall', name: 'ehall', enabled: true, dir: '/x' };
    expect(toolAllowed(ehall, { name: 'electricity_get_remaining' })).toBe(true);
    expect(toolAllowed(ehall, { name: 'sports_book' })).toBe(false);
    expect(toolAllowed(ehall, { name: 'billiards_cancel' })).toBe(false);
    expect(toolAllowed(ehall, { name: 'schedule_book', annotations: { readOnlyHint: true } })).toBe(false);
    expect(EXTERNAL_PRESETS.every((p) => p.repo.startsWith('https://github.com/'))).toBe(true);
  });

  it('子进程环境：补上常见安装路径，不传应用内部的密钥变量', () => {
    const env = childEnv({ PATH: '/usr/bin', HOME: '/Users/me', OPENAI_API_KEY: 'sk-x', FUDANER_DEMO: '1', LANG: 'zh_CN.UTF-8' }, '/Users/me', 'darwin');
    expect(env.PATH.split(':')).toContain('/Users/me/.local/bin');
    expect(env.PATH.split(':')).toContain('/opt/homebrew/bin');
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.FUDANER_DEMO).toBeUndefined();
    expect(env.LANG).toBe('zh_CN.UTF-8');
  });

  it('Windows 环境使用分号和 Windows 安装路径', () => {
    const env = childEnv({ PATH: 'C:\\Windows;C:\\Tools', USERPROFILE: 'C:\\Users\\me' }, 'C:\\Users\\me', 'win32');
    expect(env.PATH.split(';')).toContain('C:\\Users\\me\\.local\\bin');
    expect(env.PATH.split(';')).toContain('C:\\Tools');
    expect(env.PATH).not.toContain('/opt/homebrew');
  });

  it('设置页传来的配置只保留认识的字段', () => {
    const r = sanitizeExternal([
      { id: 'Ehall!', preset: 'ehall', name: 'ehall', enabled: true, command: 'rm', args: ['-rf', '/'] },
      { id: 'old', preset: 'danta', name: '已内置的旧预设', enabled: true },
      { id: 'x', preset: 'evil', name: 'x', enabled: true },
      { id: 'c1', preset: 'custom', name: '自定义', enabled: true, command: 'node', args: ['a.js', 3], allowAllTools: true },
    ]);
    expect(r).toEqual([
      { id: 'ehall-', preset: 'ehall', name: 'ehall', enabled: true, dir: undefined, command: undefined, args: undefined, cwd: undefined, allowAllTools: undefined },
      { id: 'c1', preset: 'custom', name: '自定义', enabled: true, dir: undefined, command: 'node', args: ['a.js'], cwd: undefined, allowAllTools: true },
    ]);
  });
});

describe('应用里接入', () => {
  it('按设置连接，旦旦的工具里出现扩展服务；关闭后断开', async () => {
    const ctx = new AppContext({ dbPath: ':memory:', channels: nullChannels, elearning: () => null, mail: () => null });
    cleanups.push(() => ctx.close());
    await ctx.start();
    ctx.repo.setSettings({ externalMcp: [custom(), { id: 'ehall', preset: 'ehall', name: 'ehall', enabled: true }] });
    const status = await ctx.reloadExternal();
    expect(status.find((s) => s.id === 'fake')).toMatchObject({ state: 'ok', tools: ['search_holes'], blocked: ['sports_book'] });
    expect(status.find((s) => s.id === 'ehall')).toMatchObject({ state: 'error' });
    expect(ctx.hub.llmTools().some((t) => t.function.name === 'ext_fake__search_holes')).toBe(true);
    expect(ctx.executorHub.llmTools().some((t) => t.function.name.startsWith('ext_'))).toBe(false);
    ctx.repo.setSettings({ externalMcp: [custom({ enabled: false })] });
    await ctx.reloadExternal();
    expect(ctx.hub.llmTools().some((t) => t.function.name.startsWith('ext_'))).toBe(false);
  }, 30_000);
});
