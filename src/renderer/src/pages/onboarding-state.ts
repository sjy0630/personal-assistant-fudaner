import type { FudanerApi } from '../../../shared/ipc';
import type { ModelConfig, Profile } from '../../../shared/types';

type CompletionApi = {
  profile: Pick<FudanerApi['profile'], 'set'>;
  settings: Pick<FudanerApi['settings'], 'set'>;
};

/** 标记最后写入。保存失败时下次启动仍显示引导，且不覆盖其他设置。 */
export async function finishOnboarding(api: CompletionApi, profile: Profile): Promise<void> {
  const assistantName = profile.assistantName.trim();
  if (!assistantName) throw new Error('请给助理起一个名字。');
  await api.profile.set({ ...profile, assistantName });
  await api.settings.set({ onboardingCompleted: true });
}

export function validateModel(config: ModelConfig): string | null {
  try {
    const url = new URL(config.baseURL.trim());
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new Error();
  } catch {
    return '请填写有效的 HTTP 或 HTTPS 模型服务地址。';
  }
  if (!config.model.trim()) return '请填写服务商提供的模型名。';
  return null;
}

/** 服务端原文可能包含请求信息，界面只呈现可执行的说明。 */
export function modelProblem(message: string): string {
  if (/401|403|unauthor|authentication|api.?key|鉴权/i.test(message)) return 'API Key 无效或没有访问权限，请检查密钥及所选模型的权限。';
  if (/429|quota|balance|credit|余额|配额/i.test(message)) return '请求受限或额度不足，请检查服务商余额，稍后再试。';
  if (/404|not.?found|model.*exist/i.test(message)) return '未找到接口或模型，请核对服务地址和模型名。';
  if (/timeout|timed.?out|超时/i.test(message)) return '连接超时，请检查网络或本地模型是否已启动，再试一次。';
  return '暂时无法连接模型，请核对服务地址、模型名及网络后重试。';
}
