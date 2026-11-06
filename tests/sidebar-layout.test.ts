import { describe, expect, it } from 'vitest';
import { readSidebarLayout, writeSidebarLayout, SIDEBAR_LAYOUT_KEY } from '../src/renderer/src/theme/sidebar-layout';

describe('侧栏布局偏好', () => {
  it('未保存时默认左右展开', () => {
    expect(readSidebarLayout({ getItem: () => null })).toEqual({ leftCollapsed: false, rightCollapsed: false });
  });
  it('保存后重新读取，两个侧栏互不影响', () => {
    const values = new Map<string, string>();
    const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
    writeSidebarLayout(storage, { leftCollapsed: true, rightCollapsed: false });
    expect(readSidebarLayout(storage)).toEqual({ leftCollapsed: true, rightCollapsed: false });
    writeSidebarLayout(storage, { ...readSidebarLayout(storage), rightCollapsed: true });
    expect(JSON.parse(values.get(SIDEBAR_LAYOUT_KEY)!)).toEqual({ leftCollapsed: true, rightCollapsed: true });
    writeSidebarLayout(storage, { ...readSidebarLayout(storage), leftCollapsed: false });
    expect(readSidebarLayout(storage)).toEqual({ leftCollapsed: false, rightCollapsed: true });
  });
  it.each(['broken', 'null', '[]', '"false"', '{"leftCollapsed":"true","rightCollapsed":3}'])('损坏或错误类型的配置 %s 不会隐藏导航', (value) => {
    expect(readSidebarLayout({ getItem: () => value })).toEqual({ leftCollapsed: false, rightCollapsed: false });
  });
  it('只恢复有效的布尔值，忽略未知字段', () => {
    expect(readSidebarLayout({ getItem: () => '{"leftCollapsed":true,"unknown":"ignored"}' })).toEqual({ leftCollapsed: true, rightCollapsed: false });
  });
  it('本地存储读取或写入失败时不抛错', () => {
    expect(readSidebarLayout({ getItem: () => { throw Error('blocked'); } })).toEqual({ leftCollapsed: false, rightCollapsed: false });
    expect(() => writeSidebarLayout({ setItem: () => { throw Error('full'); } }, { leftCollapsed: true, rightCollapsed: true })).not.toThrow();
    expect(readSidebarLayout(undefined)).toEqual({ leftCollapsed: false, rightCollapsed: false });
  });
});
