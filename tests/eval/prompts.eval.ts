import { writeFile } from 'node:fs/promises';
import { expect, it } from 'vitest';
import { OpenAiCompatClient, parseJsonLoose, type LlmClient } from '../../src/main/ai/llm';
import { memoryExtractPrompt, morningPrompt } from '../../src/main/ai/prompts';
import { memoryOutput } from '../../src/main/ai/validation';
import { assess } from '../../src/main/engine/assess';
import type { Trigger } from '../../src/shared/types';

const enabled = process.env.EVAL_PROMPTS === '1';
const referenceNow = '2026-11-06T10:00:00+08:00';
const facts = [
  '今天是2026年11月6日。',
  '今天只有一节课：数据结构，13:30–15:10，地点H2215。',
  'Lab 5：链表与栈，今天23:59截止，目前未交。',
  '15:10之后空闲。没有其他已知课程、邮件或活动。',
].join('\n');
const stableDialog = '用户：我每周二晚上19:00到21:00固定参加社团活动。\n助理：建议你从下周起每天早上7:00跑步。';
const casualDialog = '用户：我今天午饭吃了一碗面，味道还行。\n助理：好，下午出门记得留出路上时间。';
const ids = ['morning-grounding', 'low-value-assessment', 'stable-user-memory', 'casual-no-memory'] as const;
type Outcome = {
  id: typeof ids[number]; passed: boolean; elapsedMs: number; actualModel: string;
  checks: Record<string, boolean>; input: string; rawOutput: string | null; parsedOutput?: unknown; error?: string;
};

function createClient(): LlmClient {
  if (process.env.EVAL_KIND !== 'local' || !process.env.EVAL_BASE_URL || !process.env.EVAL_MODEL) throw new Error('提示词smoke需要显式配置本机local模型');
  let url: URL;
  try { url = new URL(process.env.EVAL_BASE_URL); } catch { throw new Error('本机提示词smoke地址无效'); }
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || !['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('提示词smoke只允许无凭据的本机回环地址');
  return new OpenAiCompatClient({ baseURL: url.href, model: process.env.EVAL_MODEL, apiKey: '' }, 'local');
}

it.runIf(enabled)('真实本地模型提示词smoke：早安、低价值研判、稳定记忆、一次性闲聊', async () => {
  const actual = createClient();
  const results: Outcome[] = [];
  for (const id of ids) {
    const started = performance.now();
    let rawOutput: string | null = null;
    let toolCalls = 0;
    let calls = 0;
    const client: LlmClient = {
      label: actual.label,
      async chat(messages, options) {
        calls++;
        const timeout = AbortSignal.timeout(45_000);
        const signal = options?.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
        const result = await actual.chat(messages, { ...options, signal });
        rawOutput = result.content;
        toolCalls += result.toolCalls.length;
        return result;
      },
    };
    let input = '';
    let parsedOutput: unknown;
    let actualModel = actual.label;
    let checks: Record<string, boolean> = {};
    let error: string | undefined;
    try {
      if (id === 'morning-grounding') {
        input = facts;
        const response = await client.chat([{ role: 'user', content: morningPrompt({ facts, styleHint: '口吻自然简洁。' }) }], { temperature: 0.7, maxTokens: 400 });
        const text = response.content;
        const clocks = [...text.matchAll(/\b(\d{1,2})[:：](\d{2})\b/g)].map((match) => `${match[1].padStart(2, '0')}:${match[2]}`);
        checks = {
          nonEmpty: !!text.trim(),
          knownLabTitle: /Lab\s*5/i.test(text) && /链表/.test(text),
          knownDeadline: /23[:：]59/.test(text),
          knownCourse: text.includes('数据结构'),
          numericClockTimesGrounded: clocks.every((clock) => ['13:30', '15:10', '23:59'].includes(clock)),
          noOtherSeededCourse: !/数学分析|数分|大学物理|线性代数|学术英语|近现代史/.test(text),
          noOtherClassroom: [...text.matchAll(/\bH\d{4}\b/gi)].every((match) => match[0].toUpperCase() === 'H2215'),
        };
        parsedOutput = { numericClockTimes: clocks, reviewRequired: 'Regex checks cover known title/times/course names only; human review must check all facts, tone and natural-language times.' };
      } else if (id === 'low-value-assessment') {
        const event: Trigger = {
          id: 'prompt-smoke-general-mail', source: 'mail', kind: 'mail_new', sourceRef: 'fictitious-archive-receipt', threadKey: 'mail:fictitious-archive-receipt',
          payload: { category: 'other', from: '虚构归档系统', subject: '自动归档成功', summary: '普通系统回执，不需要回复或处理，没有截止时间，与用户目标或兴趣无关。' },
          occurredAt: referenceNow, disposition: 'pending',
        };
        input = JSON.stringify(event.payload);
        const result = await assess([event], { llm: client, memories: [], phase: 'regular', now: new Date(referenceNow), describe: (trigger) => JSON.stringify(trigger.payload) });
        actualModel = result.model;
        const raw = parseJsonLoose<Record<string, unknown>>(rawOutput ?? '');
        checks = {
          actualModelNotFallback: result.model === actual.label,
          lowAttentionAction: result.assessment.action === 'record' || result.assessment.action === 'digest',
          returnedReasonAtMost20: [...result.assessment.reason].length <= 20,
          rawReasonAtMost20: typeof raw?.reason === 'string' && [...raw.reason].length <= 20,
          noUnrequestedTicket: result.assessment.ticket === undefined,
        };
        parsedOutput = result;
      } else {
        const stable = id === 'stable-user-memory';
        input = stable ? stableDialog : casualDialog;
        const response = await client.chat([{ role: 'user', content: memoryExtractPrompt({ dialog: input, existing: '（暂无）' }) }], { json: true, temperature: 0, maxTokens: 600 });
        const parsed = memoryOutput.safeParse(parseJsonLoose<unknown>(response.content));
        const memories = (parsed.success ? parsed.data.memories : []).map((memory) => ({ type: 'type' in memory ? memory.type : undefined, content: memory.content }));
        checks = stable ? {
          validProductionSchema: parsed.success,
          userScheduleRetained: memories.some((memory) => memory.type === 'schedule' && /周二|星期二/.test(memory.content) && /社团/.test(memory.content) && /晚上|晚间|19|七点/.test(memory.content)),
          onlyUserScheduleFacts: memories.length > 0 && memories.every((memory) => memory.type === 'schedule' && /周二|星期二/.test(memory.content) && /社团/.test(memory.content)),
          assistantRunningAdviceNotRemembered: memories.every((memory) => !/跑步|每天|早上|早晨|晨跑|7[:：]00/.test(memory.content)),
        } : {
          validProductionSchema: parsed.success,
          noLongTermMemoryFromLunch: parsed.success && memories.length === 0,
        };
        parsedOutput = parsed.success ? parsed.data : { validProductionSchema: false };
      }
      checks.singleModelCall = calls === 1;
      checks.noToolCalls = toolCalls === 0;
    } catch { error = 'local_request_or_validation_failed; upstream details omitted'; }
    const outcome: Outcome = { id, passed: !error && Object.keys(checks).length > 0 && Object.values(checks).every(Boolean), elapsedMs: Math.round(performance.now() - started), actualModel, checks, input, rawOutput, parsedOutput, error };
    results.push(outcome);
    console.log(`${id}：${outcome.passed ? '通过' : '未通过'}，${Math.round(outcome.elapsedMs / 1000)}秒，实际来源${outcome.actualModel}。`);
  }
  await writeFile(new URL('./prompt-results.json', import.meta.url), `${JSON.stringify({
    generatedAt: new Date().toISOString(), model: actual.label, referenceNow, passed: results.filter((result) => result.passed).length, total: results.length, results,
    method: 'Four production-prompt smoke scenarios, one explicit local request each, 45-second request bounds. assess() must report the actual local model, never rules fallback. memoryOutput validates the actual generated JSON.',
    limitations: [
      'Four controlled fictitious scenarios are not a statistical prompt-quality benchmark and do not prove the PRD memory-acceptance target.',
      'Morning checks cover known Lab title, numeric deadline/clock values, course and classroom names; they cannot fully prove absence of unsupported natural-language facts. Raw text is retained for human review.',
      'Memory checks cover this explicit Tuesday schedule and rejection of assistant running advice; semantic accuracy outside these cases is not established.',
      'No cloud request, no key, no application account/settings or real mail is read.',
    ],
  }, null, 2)}\n`, 'utf8');
  expect(results.filter((result) => !result.passed).map((result) => result.id), '完整输出与失败项见tests/eval/prompt-results.json').toEqual([]);
}, 4 * 60_000);
