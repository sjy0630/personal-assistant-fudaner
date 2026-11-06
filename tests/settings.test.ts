import { describe, expect, it } from 'vitest';
import {
  prepareModel,
  choosePreset,
  prepareMail,
  needsMailPassword,
  validateQuietHours,
  cleanMemory,
  toggleObserveRule,
} from '../src/renderer/src/pages/settings-state';

describe('设置输入与保存边界', () => {
  it('更换邮箱服务器或端口时，不能沿用已保存的旧密码', () => {
    const original = { user: 'me@example.test', host: 'mail.example.test', port: 993 };
    expect(needsMailPassword(original, { ...original })).toBe(false);
    expect(needsMailPassword(original, { ...original, host: 'another.example.test' })).toBe(true);
    expect(needsMailPassword(original, { ...original, port: 994 })).toBe(true);
    expect(needsMailPassword(original, { ...original, user: 'other@example.test' })).toBe(true);
    expect(needsMailPassword(undefined, original)).toBe(true);
  });
  it('修改服务时不把旧服务的密钥发给新服务', () => {
    expect(
      choosePreset(
        { baseURL: 'https://old.test/v1', model: 'old', apiKey: 'fixture' },
        { baseURL: 'https://new.test/v1', model: 'new' }
      ).apiKey
    ).toBe('');
    expect(
      choosePreset(
        { baseURL: 'https://old.test/v1/', model: 'old', apiKey: 'masked' },
        { baseURL: 'https://old.test/v1', model: 'new' }
      ).apiKey
    ).toBe('masked');
  });
  it('模型配置规范化，保留遮罩密钥，无密钥云端被阻止', () => {
    expect(
      prepareModel(
        { baseURL: ' https://example.test/v1/ ', model: ' m ', apiKey: '••••••1234' },
        'cloud'
      )
    ).toEqual({ baseURL: 'https://example.test/v1', model: 'm', apiKey: '••••••1234' });
    expect(() =>
      prepareModel({ baseURL: 'https://example.test/v1', model: 'm', apiKey: '' }, 'cloud')
    ).toThrow('API Key');
    expect(
      prepareModel({ baseURL: 'http://127.0.0.1:11434/v1', model: 'm', apiKey: '' }, 'local').apiKey
    ).toBe('');
  });
  it('邮箱校验地址和端口，保留自定义服务器', () => {
    expect(
      prepareMail({ user: ' me@example.test ', host: ' mail.example.test ', port: 993 })
    ).toEqual({ user: 'me@example.test', host: 'mail.example.test', port: 993 });
    expect(() => prepareMail({ user: 'broken', host: 'server', port: 993 })).toThrow('邮箱地址');
    expect(() => prepareMail({ user: 'me@example.test', host: 'server', port: 0 })).toThrow('端口');
    expect(() =>
      prepareMail({ user: 'me@example.test', host: 'https://server', port: 993 })
    ).toThrow('服务器');
  });
  it('静默支持跨零点和相同起止时间，拒绝缺失或超范围', () => {
    expect(validateQuietHours({ start: '23:30', end: '07:30' })).toBeNull();
    expect(validateQuietHours({ start: '08:00', end: '08:00' })).toBeNull();
    expect(validateQuietHours({ start: '24:00', end: '07:00' })).toContain('时间');
    expect(validateQuietHours({ start: '', end: '07:00' })).toContain('时间');
  });
  it('记忆不能只包含空白', () => {
    expect(() => cleanMemory('  ')).toThrow('记忆');
    expect(cleanMemory(' 周二社团 ')).toBe('周二社团');
  });
  it('选择观察规则保留无法识别的既有规则，不重复添加', () => {
    expect(toggleObserveRule(['future_rule', 'mail_new'], 'assignment_new', true)).toEqual([
      'future_rule',
      'mail_new',
      'assignment_new',
    ]);
    expect(toggleObserveRule(['future_rule', 'mail_new'], 'mail_new', false)).toEqual([
      'future_rule',
    ]);
    expect(toggleObserveRule(['mail_new'], 'mail_new', true)).toEqual(['mail_new']);
  });
});
