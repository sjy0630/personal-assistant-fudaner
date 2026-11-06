import { useEffect, useState } from 'react';
import type { ModelConfig, Settings } from '../../../../shared/types';
import { api } from '../../api';
import { modelProblem } from '../onboarding-state';
import { choosePreset, prepareModel } from '../settings-state';
import { Feedback, Loading, same, useLoad, useTask, type PanelProps } from './support';
import styles from './Settings.module.css';

const EMPTY: ModelConfig = { baseURL: '', model: '', apiKey: '' };
const PRESETS = [
  { name: 'DeepSeek', baseURL: 'https://api.deepseek.com', model: 'deepseek-chat' },
  {
    name: '通义千问',
    baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    model: 'qwen-plus',
  },
  { name: 'Kimi', baseURL: 'https://api.moonshot.cn/v1', model: 'kimi-latest' },
  { name: '智谱 GLM', baseURL: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4-plus' },
];
export function ModelSettings({ onDirty, onBusy }: PanelProps) {
  const loaded = useLoad(() => api.settings.get());
  const [saved, setSaved] = useState<Settings | null>(null);
  const [draft, setDraft] = useState<Settings | null>(null);
  const [results, setResults] = useState<
    Partial<Record<'cloud' | 'local', { ok: boolean; text: string }>>
  >({});
  const task = useTask(onBusy);
  useEffect(() => {
    if (loaded.value) {
      setSaved(loaded.value);
      setDraft(loaded.value);
    }
  }, [loaded.value]);
  useEffect(() => {
    onDirty(!same(draft, saved));
  }, [draft, saved, onDirty]);
  if (!draft || !saved) return <Loading error={loaded.error} retry={loaded.retry} />;

  const edit = (kind: 'cloud' | 'local', patch: Partial<ModelConfig>) => {
    const cfg = draft[kind] ?? EMPTY;
    // 修改服务地址时清除旧密钥，防止误发给另一个服务。
    const next =
      patch.baseURL !== undefined
        ? { ...choosePreset(cfg, { baseURL: patch.baseURL, model: cfg.model }), ...patch }
        : { ...cfg, ...patch };
    setDraft({ ...draft, [kind]: next });
    setResults((r) => ({ ...r, [kind]: undefined }));
    task.clear();
  };
  const save = (kind: 'cloud' | 'local', test: boolean) =>
    task.run(
      kind,
      async () => {
        const cfg = prepareModel(draft[kind] ?? EMPTY, kind);
        await api.settings.set({ [kind]: cfg });
        const current = await api.settings.get();
        setSaved((s) => s && { ...s, [kind]: current[kind] });
        setDraft((s) => s && { ...s, [kind]: current[kind] });
        if (test) {
          const result = await api.settings.testModel(kind);
          setResults((r) => ({
            ...r,
            [kind]: {
              ok: result.ok,
              text: result.ok ? '连接测试通过。' : modelProblem(result.message),
            },
          }));
        } else setResults((r) => ({ ...r, [kind]: undefined }));
      },
      test ? '配置已保存，连接测试结果见上方。' : '配置已保存，尚未测试连接。'
    );
  const section = (kind: 'cloud' | 'local') => {
    const cfg = draft[kind] ?? EMPTY;
    return (
      <section className={styles.section}>
        <h2>{kind === 'cloud' ? '云端模型' : '本地模型（可选）'}</h2>
        <p className={styles.hint}>
          {kind === 'cloud'
            ? '用于对话、规划和后台工单。支持自定义 OpenAI 兼容网关，保留你在引导页配置的地址和模型名。'
            : '已运行 Ollama 或其他本机兼容服务时再配置。隐私任务优先使用本地模型；未配置时可使用规则处理。'}
        </p>
        <div className={styles.presets}>
          {kind === 'cloud' ? (
            PRESETS.map((p) => (
              <button
                type="button"
                key={p.name}
                onClick={() => {
                  setDraft({ ...draft, cloud: choosePreset(cfg, p) });
                  setResults((r) => ({ ...r, cloud: undefined }));
                  task.clear();
                }}
              >
                {p.name}
              </button>
            ))
          ) : (
            <button
              type="button"
              onClick={() =>
                edit('local', { baseURL: 'http://127.0.0.1:11434/v1', model: 'qwen2.5:3b' })
              }
            >
              填入 Ollama 示例
            </button>
          )}
        </div>
        <label>
          服务地址（{kind === 'cloud' ? '云端' : '本地'}）
          <input
            type="url"
            value={cfg.baseURL}
            onChange={(e) => edit(kind, { baseURL: e.target.value })}
            spellCheck={false}
            autoComplete="off"
          />
        </label>
        <label>
          模型名（{kind === 'cloud' ? '云端' : '本地'}）
          <input
            value={cfg.model}
            onChange={(e) => edit(kind, { model: e.target.value })}
            spellCheck={false}
            autoComplete="off"
          />
        </label>
        <label>
          API Key（{kind === 'cloud' ? '云端' : '本地，可不填'}）
          <input
            type="password"
            value={cfg.apiKey}
            onChange={(e) => edit(kind, { apiKey: e.target.value })}
            autoComplete="off"
            spellCheck={false}
          />
        </label>
        <p className={styles.hint}>
          已保存的密钥以遮罩显示。更换服务地址会清空旧密钥，请重新填写。
        </p>
        <div className={styles.actions}>
          <button type="button" onClick={() => void save(kind, false)}>
            仅保存{kind === 'cloud' ? '云端' : '本地'}配置
          </button>
          <button className="primary" type="button" onClick={() => void save(kind, true)}>
            {task.busy === kind
              ? '正在处理…'
              : `保存并测试${kind === 'cloud' ? '云端' : '本地'}连接`}
          </button>
          {kind === 'local' && saved.local && (
            <button
              type="button"
              className="ghost"
              onClick={() =>
                void task.run(
                  'remove',
                  async () => {
                    await api.settings.set({ local: undefined });
                    setSaved((s) => s && { ...s, local: undefined });
                    setDraft((s) => s && { ...s, local: undefined });
                    setResults((r) => ({ ...r, local: undefined }));
                  },
                  '本地模型配置已清除。'
                )
              }
            >
              清除本地模型配置
            </button>
          )}
        </div>
        {results[kind] && (
          <p
            role={results[kind]?.ok ? 'status' : 'alert'}
            className={results[kind]?.ok ? styles.success : styles.error}
          >
            {results[kind]?.text}
          </p>
        )}
      </section>
    );
  };
  return (
    <>
      <fieldset className={styles.form} disabled={!!task.busy}>
        {section('cloud')}
        {section('local')}
        <section className={styles.section}>
          <h2>隐私任务的云端授权</h2>
          <p className={styles.hint}>
            邮件分类、记忆提取和主动研判优先使用本地模型。只有你明确允许时，模型路由才会为这些任务选择云端服务；本地模型运行中报错不会自动转发。
          </p>
          <label className={styles.check}>
            <input
              type="checkbox"
              checked={!!draft.allowSensitiveToCloud}
              onChange={(e) => {
                setDraft({ ...draft, allowSensitiveToCloud: e.target.checked });
                task.clear();
              }}
            />
            没有配置本地模型时，允许将隐私任务交给所选云端服务
          </label>
          <button
            type="button"
            onClick={() =>
              void task.run('privacy', async () => {
                await api.settings.set({ allowSensitiveToCloud: !!draft.allowSensitiveToCloud });
                setSaved(
                  (s) => s && { ...s, allowSensitiveToCloud: !!draft.allowSensitiveToCloud }
                );
              })
            }
          >
            保存隐私任务授权
          </button>
        </section>
      </fieldset>
      <Feedback {...task} />
    </>
  );
}
