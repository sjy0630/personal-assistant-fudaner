import type { ModelConfig, Settings } from '../../../shared/types';
import { validateModel } from './onboarding-state';

const normalizeUrl = (url: string) => url.trim().replace(/\/+$/, '');
export function choosePreset(
  current: ModelConfig,
  preset: Pick<ModelConfig, 'baseURL' | 'model'>
): ModelConfig {
  return {
    baseURL: preset.baseURL,
    model: preset.model,
    apiKey: normalizeUrl(current.baseURL) === normalizeUrl(preset.baseURL) ? current.apiKey : '',
  };
}
export function prepareModel(config: ModelConfig, kind: 'cloud' | 'local'): ModelConfig {
  const problem = validateModel(config);
  if (problem) throw new Error(problem);
  if (kind === 'cloud' && !config.apiKey.trim())
    throw new Error('请填写 API Key。原有密钥未修改时可直接保留遮罩。');
  return {
    baseURL: normalizeUrl(config.baseURL),
    model: config.model.trim(),
    apiKey: config.apiKey.trim(),
  };
}
export function prepareMail(mail: NonNullable<Settings['mail']>): NonNullable<Settings['mail']> {
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(mail.user.trim()))
    throw new Error('请填写有效的邮箱地址。');
  if (!/^[a-z\d.-]+$/i.test(mail.host.trim()))
    throw new Error('请填写邮箱服务器主机名，不要包含 https:// 或路径。');
  if (!Number.isInteger(mail.port) || mail.port < 1 || mail.port > 65535)
    throw new Error('请填写 1–65535 之间的整数端口。');
  return { user: mail.user.trim(), host: mail.host.trim(), port: mail.port };
}
export function needsMailPassword(
  saved: Settings['mail'],
  next: NonNullable<Settings['mail']>
): boolean {
  return (
    !saved ||
    saved.user.trim() !== next.user.trim() ||
    saved.host.trim().toLowerCase() !== next.host.trim().toLowerCase() ||
    saved.port !== next.port
  );
}
export function validateQuietHours(value: Settings['quietHours']): string | null {
  const valid = (s: string) => /^([01]\d|2[0-3]):[0-5]\d$/.test(s);
  return valid(value.start) && valid(value.end) ? null : '请填写有效的静默起止时间。';
}
export function cleanMemory(content: string): string {
  if (!content.trim()) throw new Error('请填写记忆内容，不能只输入空白。');
  return content.trim();
}
export function toggleObserveRule(rules: string[], rule: string, selected: boolean): string[] {
  return selected ? [...new Set([...rules, rule])] : rules.filter((r) => r !== rule);
}

/** Electron IPC 会给主进程错误添加前缀，只展示面向用户的操作提示。 */
export function settingsErrorMessage(error: unknown, fallback: string): string {
  if (!(error instanceof Error)) return fallback;
  const message = error.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '');
  return /^请/.test(message) ? message : fallback;
}
