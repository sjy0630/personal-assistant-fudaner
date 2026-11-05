import { writeFile } from 'node:fs/promises';
import { cpus, totalmem } from 'node:os';
import { it, expect } from 'vitest';

const enabled = process.env.EVAL_PERF === '1';

it.runIf(enabled)('记录本机 Ollama 生成速度（单次探针，不冒充邮件分类耗时）', async () => {
  if (process.env.EVAL_KIND !== 'local') throw new Error('性能探针只支持 EVAL_KIND=local');
  const model = process.env.EVAL_MODEL;
  const baseURL = process.env.EVAL_BASE_URL;
  if (!model || !baseURL) throw new Error('请显式配置本机 EVAL_MODEL 和 EVAL_BASE_URL');
  let url: URL;
  try { url = new URL(baseURL); } catch { throw new Error('本机性能探针地址无效'); }
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || !['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('性能探针仅允许无凭据的本机回环地址');
  const started = performance.now();
  let data: Record<string, unknown>;
  try {
    const response = await fetch(new URL('/api/generate', url), {
      method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(90_000),
      body: JSON.stringify({ model, stream: false, prompt: '请用中文给一名大学生列出五条安排每周学习计划的具体建议，每条一句话。', options: { temperature: 0, num_predict: 128 } }),
    });
    if (!response.ok) throw new Error('local_request_failed');
    data = await response.json() as Record<string, unknown>;
  } catch { throw new Error('本机 Ollama 性能探针失败；检查服务与已安装的模型，未保存服务端原始报错'); }
  expect(data.done).toBe(true);
  const count = Number(data.eval_count);
  const durationNs = Number(data.eval_duration);
  expect(Number.isFinite(count) && count > 0).toBe(true);
  expect(Number.isFinite(durationNs) && durationNs > 0).toBe(true);
  const round = (n: number) => Math.round(n * 100) / 100;
  const wallMs = round(performance.now() - started);
  let residency: { weightBytes: number | null; residentVramBytes: number | null; contextLength: number | null } | null = null;
  try {
    const response = await fetch(new URL('/api/ps', url), { signal: AbortSignal.timeout(3_000) });
    if (response.ok) {
      const ps = await response.json() as { models?: { name?: string; model?: string; size?: number; size_vram?: number; context_length?: number }[] };
      const selected = ps.models?.find((m) => m.name === model || m.model === model);
      if (selected) residency = { weightBytes: selected.size ?? null, residentVramBytes: selected.size_vram ?? null, contextLength: selected.context_length ?? null };
    }
  } catch { /* GPU residency is optional and never inferred from token speed. */ }
  const result = {
    generatedAt: new Date().toISOString(), model, kind: 'local', sampleCount: 1,
    workload: 'Fixed Chinese study-planning prompt; maximum 128 generated tokens; temperature 0; no key.',
    evalCount: count, evalDurationNs: durationNs, tokensPerSecond: round(count / (durationNs / 1e9)),
    wallMs, loadMs: Number(data.load_duration ?? 0) / 1e6,
    promptTokens: typeof data.prompt_eval_count === 'number' ? data.prompt_eval_count : null,
    residency,
    machine: { cpu: cpus()[0]?.model ?? 'unknown', memoryGiB: round(totalmem() / 1024 ** 3), node: process.version, platform: process.platform },
    limitations: [
      'One probe, not a repeated performance benchmark; may include initial model loading.',
      'tokensPerSecond is Ollama eval_count / eval_duration and excludes load/prompt evaluation; wallMs is end-to-end.',
      'This is not the time to classify 8 emails. See results.json for classification wall times.',
      'Ollama residency reports allocated VRAM; GPU hardware must be verified separately.',
    ],
  };
  await writeFile(new URL('./ollama-performance.json', import.meta.url), `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  console.log(`本机性能探针：${model}，${result.tokensPerSecond} token/s，生成 ${count} token；单次墙钟 ${round(result.wallMs / 1000)} 秒（不是邮件分类耗时）。`);
});
