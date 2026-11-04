import { afterEach, describe, expect, it } from 'vitest';
import { Db } from '../src/main/db/db';
import { Repo } from '../src/main/db/repo';
import { seedDemoProfile } from '../src/main/demo/demo';
import { finishOnboarding, validateModel, modelProblem } from '../src/renderer/src/pages/onboarding-state';

const opened: Db[] = [];
afterEach(() => opened.splice(0).forEach((db) => db.close()));
function setup() {
  const db = new Db(':memory:');
  opened.push(db);
  const repo = new Repo(db);
  return { db, repo, api: {
    profile: { set: async (p: Parameters<Repo['setProfile']>[0]) => repo.setProfile(p) },
    settings: { set: async (s: Parameters<Repo['setSettings']>[0]) => repo.setSettings(s) },
  } };
}

describe('首次使用引导', () => {
  it('首次选择演示后重启，演示初始化不覆盖用户画像和风格', async () => {
    const { repo, api } = setup();
    repo.setSettings({ demoMode: true });
    await finishOnboarding(api, { assistantName: '我的助理', style: 'concise', proactivity: 'low', nickname: '我的昵称' });
    seedDemoProfile(repo);
    expect(repo.getProfile()).toMatchObject({ assistantName: '我的助理', style: 'concise', proactivity: 'low', nickname: '我的昵称' });
    expect(repo.listMemories()).toHaveLength(0);
  });
  it('完成后持久化画像和标记，保留原有模型和静默时段', async () => {
    const { repo, db, api } = setup();
    repo.setSettings({ cloud: { baseURL: 'https://example.test/v1', model: 'example', apiKey: 'fixture' }, quietHours: { start: '22:00', end: '08:00' } });
    await finishOnboarding(api, { assistantName: ' 小旦 ', style: 'warm', proactivity: 'medium', nickname: '小明' });
    const reloaded = new Repo(db);
    expect(reloaded.getProfile().assistantName).toBe('小旦');
    expect(reloaded.getProfile().nickname).toBe('小明');
    expect(reloaded.getSettings().onboardingCompleted).toBe(true);
    expect(reloaded.getSettings().cloud?.apiKey).toBe('fixture');
    expect(reloaded.getSettings().quietHours).toEqual({ start: '22:00', end: '08:00' });
  });
  it('画像保存失败时仍需要完成引导', async () => {
    const { repo, api } = setup();
    api.profile.set = async () => { throw new Error('disk full'); };
    await expect(finishOnboarding(api, { assistantName: '旦旦', style: 'warm', proactivity: 'medium' })).rejects.toThrow('disk full');
    expect(repo.getSettings().onboardingCompleted).not.toBe(true);
  });
  it('拒绝空白助理名，不写完成标记', async () => {
    const { repo, api } = setup();
    await expect(finishOnboarding(api, { assistantName: '   ', style: 'warm', proactivity: 'medium' })).rejects.toThrow('名字');
    expect(repo.getSettings().onboardingCompleted).not.toBe(true);
  });
  it.each([
    ['file:///private', 'model', '地址'],
    ['javascript:alert(1)', 'model', '地址'],
    ['https://example.test/v1', ' ', '模型名'],
  ])('阻止无效模型配置 %s', (baseURL, model, expected) => {
    expect(validateModel({ baseURL, model, apiKey: '' })).toContain(expected);
  });
  it('支持云端兼容网关及无密钥的本地模型', () => {
    expect(validateModel({ baseURL: 'https://example.test/v1', model: 'custom', apiKey: 'fixture' })).toBeNull();
    expect(validateModel({ baseURL: 'http://127.0.0.1:11434/v1', model: 'local', apiKey: '' })).toBeNull();
  });
  it('认证失败时给出下一步，不回显服务端原始信息', () => {
    expect(modelProblem('401 unauthorized: secret-value')).toContain('API Key');
    expect(modelProblem('401 unauthorized: secret-value')).not.toContain('secret-value');
    expect(modelProblem('unexpected secret-value')).not.toContain('secret-value');
  });
});
