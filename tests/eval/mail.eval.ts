import { readFile, writeFile } from 'node:fs/promises';
import { cpus, totalmem } from 'node:os';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { AppContext } from '../../src/main/app-context';
import { OpenAiCompatClient, type LlmClient, type LlmMessage, type LlmOptions } from '../../src/main/ai/llm';
import { classifyMails, ruleClassify, type MailAi } from '../../src/main/ai/mail';
import { linkMail } from '../../src/main/courses/registry';
import { DemoElearningClient, DemoMailClient } from '../../src/main/demo/demo';
import { nullChannels } from '../../src/main/engine/channels';
import { score, validateSamples, type MailSample, type Metric, type Prediction } from './metrics';

// EVAL_DATASET=human 使用人工标注集（mails.human.json），结果另存，不覆盖演示集结果。
const human = process.env.EVAL_DATASET === 'human';
const fixtureUrl = new URL(human ? '../fixtures/mails.human.json' : '../fixtures/mails.json', import.meta.url);
const metadataUrl = new URL(human ? '../fixtures/mails.human.meta.json' : '../fixtures/mails.meta.json', import.meta.url);
const resultUrl = new URL(human ? './results-human.json' : './results.json', import.meta.url);
const materialUrl = new URL(human ? './MATERIALS-REPORT-HUMAN.md' : './MATERIALS-REPORT.md', import.meta.url);
type Kind = 'cloud' | 'local';
type DatasetMetadata = {
  datasetId: string; provenance: string; independentHumanLabels: boolean; formalCompetitionDataset: boolean;
  sampleCount: number; referenceNow: string; timeZone: string; labelPolicy: string[]; limitations: string[];
};
type CallTiming = { elapsedMs: number; status: 'completed' | 'failed' };
const round = (n: number) => Math.round(n * 100) / 100;
const format = (metric: Metric | null | undefined) => metric?.accuracy == null ? '—' : `${round(metric.accuracy * 100)}% (${metric.correct}/${metric.total})`;

/** Only explicit EVAL_* settings are used. Never reads the application's real database or settings. */
function modelConfig(): { kind: Kind; client: LlmClient } | null {
  const kind = process.env.EVAL_KIND;
  const baseURL = process.env.EVAL_BASE_URL;
  const model = process.env.EVAL_MODEL;
  if (!kind && !baseURL && !model) return null;
  if ((kind !== 'cloud' && kind !== 'local') || !baseURL || !model) throw new Error('评测需同时设置 EVAL_KIND=cloud|local、EVAL_BASE_URL、EVAL_MODEL');
  let url: URL;
  try { url = new URL(baseURL); } catch { throw new Error('EVAL_BASE_URL 不是有效地址'); }
  if (url.username || url.password || url.search || url.hash || !['http:', 'https:'].includes(url.protocol)) throw new Error('评测地址不可带凭据、查询参数或片段');
  if (kind === 'local' && !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) throw new Error('local 评测仅允许本机回环地址');
  // Cloud credentials are read only inside the runner when the user explicitly opts into cloud evaluation.
  const apiKey = kind === 'cloud' ? process.env.EVAL_API_KEY : '';
  if (kind === 'cloud' && !apiKey) throw new Error('云端评测需由用户在本机设置 EVAL_API_KEY；不要粘贴或提交密钥');
  return { kind, client: new OpenAiCompatClient({ baseURL, model, apiKey: apiKey ?? '' }, kind) };
}

/** EVAL_KIND=cloud 时可再用 EVAL_LOCAL_BASE_URL / EVAL_LOCAL_MODEL 同时评估本机模型，一次输出完整三行表。 */
function modelConfigs(): { kind: Kind; client: LlmClient }[] {
  const primary = modelConfig();
  const baseURL = process.env.EVAL_LOCAL_BASE_URL, model = process.env.EVAL_LOCAL_MODEL;
  if (primary?.kind !== 'cloud' || !baseURL || !model) return primary ? [primary] : [];
  const url = new URL(baseURL);
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.username || url.password) throw new Error('EVAL_LOCAL_BASE_URL 仅允许无凭据的本机回环地址');
  return [primary, { kind: 'local', client: new OpenAiCompatClient({ baseURL, model, apiKey: '' }, 'local') }];
}

function timedClient(client: LlmClient, calls: CallTiming[]): LlmClient {
  return {
    label: client.label,
    async chat(messages: LlmMessage[], options?: LlmOptions) {
      const start = performance.now();
      try {
        const timeout = AbortSignal.timeout(60_000);
        const signal = options?.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
        const result = await client.chat(messages, { ...options, signal });
        calls.push({ elapsedMs: round(performance.now() - start), status: 'completed' });
        return result;
      } catch (error) {
        calls.push({ elapsedMs: round(performance.now() - start), status: 'failed' });
        throw error;
      }
    },
  };
}

async function evaluate(samples: MailSample[], now: Date, kind: 'rules' | Kind, client: LlmClient | null) {
  // All course data and mail are fictitious and the database exists only in memory.
  const elearning = new DemoElearningClient(() => now);
  const mail = new DemoMailClient(() => now);
  const ctx = new AppContext({ dbPath: ':memory:', channels: nullChannels, elearning: () => elearning, mail: () => mail });
  try {
    ctx.repo.setSettings({ demoMode: true });
    const synced = await ctx.syncAll(now);
    expect(synced.errors).toEqual([]);
    for (const sample of samples) {
      if (!sample.label.course) continue;
      const course = ctx.repo.listCourses().find((c) => c.name === sample.label.course);
      expect(course, `未知课程标注：${sample.id}`).toBeDefined();
      if (sample.label.assignment) expect(ctx.repo.listItems({ kind: 'assignment', courseId: course!.id }).some((a) => a.title === sample.label.assignment), `未知作业标注：${sample.id}`).toBe(true);
    }
    const items = samples.map((sample) => ctx.repo.upsertItem({
      source: 'mail', kind: 'email', sourceId: `eval:${sample.id}`, title: sample.subject,
      body: sample.body, publishedAt: sample.sentAt, sender: `${sample.fromName} <${sample.from}>`, done: false,
    }).item);
    const calls: CallTiming[] = [];
    const started = performance.now();
    const classified = client ? await classifyMails(items, timedClient(client, calls), { now }) : null;
    const predictions: Prediction[] = items.map((item, index) => {
      const ai: MailAi = classified?.results.get(item.id) ?? ruleClassify(item, now);
      const linked = linkMail(ctx.repo, item, ai.courseHint);
      return {
        id: samples[index].id, category: ai.category, deadline: ai.deadline ?? null,
        course: linked.course?.name ?? null, assignment: linked.assignment?.title ?? null,
        source: client ? ai.source : 'rules',
      };
    });
    const elapsedMs = round(performance.now() - started);
    const modelItems = predictions.filter((p) => p.source === 'model');
    const modelIds = new Set(modelItems.map((p) => p.id));
    const logicalBatches = Math.ceil(samples.length / 8);
    return {
      kind, requestedModel: client?.label ?? 'rules', actualModel: classified?.model ?? 'rules',
      status: client ? modelItems.length === samples.length ? 'complete' : modelItems.length ? 'mixed' : 'fallback' : 'complete',
      metrics: score(samples, predictions),
      modelOnlyMetrics: client ? score(samples.filter((s) => modelIds.has(s.id)), modelItems) : null,
      diagnostics: classified?.diagnostics ?? null,
      timing: {
        totalMs: elapsedMs, logicalBatches, averageLogicalBatchMs: round(elapsedMs / logicalBatches),
        apiCalls: calls.length, averageApiCallMs: calls.length ? round(calls.reduce((sum, call) => sum + call.elapsedMs, 0) / calls.length) : null,
        calls, includesColdStart: 'First model call may include Ollama loading; no warm-up is excluded.',
      },
      predictions,
    };
  } finally { await ctx.close(); }
}

it('评测虚构邮件并输出规则/模型来源、分项指标和错例', async () => {
  const raw: unknown = JSON.parse(await readFile(fixtureUrl, 'utf8'));
  validateSamples(raw);
  const samples = raw;
  const metadata = JSON.parse(await readFile(metadataUrl, 'utf8')) as DatasetMetadata;
  expect(metadata.sampleCount).toBe(samples.length);
  expect(metadata.timeZone).toBe('Asia/Shanghai');
  const now = new Date(metadata.referenceNow);
  expect(Number.isFinite(now.getTime())).toBe(true);
  const configs = modelConfigs();
  const configured = configs.length > 0;
  const rules = await evaluate(samples, now, 'rules', null);
  const models: Awaited<ReturnType<typeof evaluate>>[] = [];
  for (const config of configs) models.push(await evaluate(samples, now, config.kind, config.client));
  const runs = [rules, ...models];
  const table = [rules, ...(['cloud', 'local'] as const).map((kind) => models.find((run) => run.kind === kind) ?? null)].map((run, index) => ({
    '模式': run?.requestedModel ?? (index === 1 ? '云端模型：未运行' : '本地模型：未运行'),
    '实际来源': run ? `${run.actualModel}; model=${run.metrics.sourceCounts.model ?? 0}, rules=${run.metrics.sourceCounts.rules ?? 0}` : '未选择该模式',
    '分类': run ? format(run.metrics.category) : '—',
    '截止': run ? format(run.metrics.deadline) : '—',
    '关联（规则）': run ? format(run.metrics.association) : '—',
    '平均每批秒': run ? round(run.timing.averageLogicalBatchMs / 1000) : '—',
  }));
  const result = {
    schemaVersion: 1, generatedAt: new Date().toISOString(), dataset: metadata,
    sampleCount: samples.length,
    distribution: {
      category: Object.fromEntries(['reply', 'action', 'course', 'notice', 'other'].map((category) => [category, samples.filter((s) => s.label.category === category).length])),
      deadlinePositive: samples.filter((s) => s.label.deadline !== null).length,
      deadlineNegative: samples.filter((s) => s.label.deadline === null).length,
      assignmentPositive: samples.filter((s) => s.label.assignment !== null).length,
      assignmentNegative: samples.filter((s) => s.label.assignment === null).length,
    },
    method: {
      deadline: 'Both rows use the production deterministic extractDeadline grounded in mail text, not model date extraction. Asia/Shanghai exact minute; null==null; invalid timestamps are wrong. Date-only textual deadlines use the documented 23:59 convention.',
      association: 'Exact course and assignment pair from linkMail rules; model courseHint may assist course lookup. No model assignment linker is implemented.',
      fallback: 'metrics includes fallbacks with explicit sourceCounts; modelOnlyMetrics selects items whose classification source is model, but their dates and associations still use common deterministic rules. A fallback-only run is not model accuracy.',
      timing: 'Fixed batches of 8, total pipeline wall time divided by logical batch count includes retries and cold start; API call durations are also recorded.',
      targets: { category: 0.85, deadline: 0.9, association: 0.8, formalValidation: false },
    },
    machine: { cpu: cpus()[0]?.model ?? 'unknown', memoryGiB: round(totalmem() / 1024 ** 3), node: process.version, platform: process.platform, gpu: 'Not auto-detected; verify separately before reporting GPU inference.' },
    skipped: (['cloud', 'local'] as const).filter((kind) => !models.some((run) => run.kind === kind)).map((kind) => ({ kind, reason: 'not explicitly configured for this invocation' })),
    runs,
  };
  await writeFile(resultUrl, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  const warning = metadata.formalCompetitionDataset && metadata.independentHumanLabels
    ? `数据集 ${metadata.datasetId}，共 ${samples.length} 封；正式结论仍需按评审要求复核。`
    : `当前只有 ${samples.length} 封 AI 演示标注样本，不是 M 的正式20/40封人工标注集；以下数据仅用于脚本联调，不代表正式准确率。`;
  const report = [
    '# 交给 M 的评测记录', '', warning, '',
    `参考日期：${metadata.referenceNow}。数据来源：${metadata.provenance}`, '',
    '| 模式 | 实际来源 | 分类 | 截止时间 | 关联（规则） | 每批平均秒 |', '| --- | --- | --- | --- | --- | --- |',
    ...table.map((row) => `| ${row['模式']} | ${row['实际来源']} | ${row['分类']} | ${row['截止']} | ${row['关联（规则）']} | ${row['平均每批秒']} |`), '',
    `截止正例 ${result.distribution.deadlinePositive} / 负例 ${result.distribution.deadlineNegative}；作业关联正例 ${result.distribution.assignmentPositive} / 负例 ${result.distribution.assignmentNegative}。`, '',
    ...runs.map((run) => `${run.requestedModel}：截止正例 ${format(run.metrics.deadlinePositive)}，空值负例 ${format(run.metrics.deadlineNegative)}；关联正例 ${format(run.metrics.association.positive)}，负例 ${format(run.metrics.association.negative)}。模型有效输出 ${run.metrics.sourceCounts.model ?? 0}/${samples.length} 封。`), '',
    '评测方法：读取虚构邮件及标注，使用相同课程总表分别评估规则和明确配置的模型分类；分类按单标签比较。规则行与模型行的截止字段均由生产代码共用的确定性 extractDeadline 从邮件原文提取，按上海时区精确到分钟，双方为空也计对，不代表独立的模型日期抽取准确率。关联使用现有 linkMail 规则，对课程与作业成对比对，并单列关联正负例；没有实现模型版作业关联。', '',
    '耗时是每批8封、含首次加载与失败重试的流水线墙钟时间；不是 token/s，也不能据此证明模型全部驻留GPU。规则回退会单独计数；回退结果不能当作模型准确率。', '',
    `机器实测：${result.machine.cpu}，物理内存 ${result.machine.memoryGiB} GiB，${result.machine.platform}，${result.machine.node}；显卡和GPU驻留须另行验证。`, '',
    `本次未做正式样本泛化验证、跨模型统计显著性检验、真实账号数据测试；不得在说明书中填成正式达标。完整错例与调用耗时见 ${human ? 'results-human.json' : 'results.json'}。`, '',
  ].join('\n');
  await writeFile(materialUrl, report, 'utf8');
  console.log(warning);
  if (!configured) console.log('未配置 EVAL_KIND / EVAL_BASE_URL / EVAL_MODEL：只运行规则，模型行跳过。');
  console.table(table);
  console.log(`结果：${fileURLToPath(resultUrl)}；说明：${fileURLToPath(materialUrl)}`);
});
