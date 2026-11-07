import OpenAI from 'openai';
import type { ModelConfig, Settings } from '../../shared/types';
import type { Embedder } from './memory-recall';

export interface LlmMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: { id: string; type: 'function'; function: { name: string; arguments: string } }[];
  tool_call_id?: string;
}

export interface LlmTool {
  type: 'function';
  function: { name: string; description?: string; parameters: Record<string, unknown> };
}

export interface LlmResult {
  content: string;
  toolCalls: { id: string; name: string; arguments: string }[];
}

export interface LlmOptions {
  tools?: LlmTool[]; json?: boolean; temperature?: number; maxTokens?: number;
  onDelta?: (text: string) => void;
  signal?: AbortSignal;
}
export interface LlmClient {
  /** 用于决策记录展示，如 "local:qwen2.5:7b" */
  readonly label: string;
  chat(messages: LlmMessage[], opts?: LlmOptions): Promise<LlmResult>;
}

/** OpenAI 兼容协议客户端：云端（DeepSeek、通义、Kimi…）和本地（Ollama 等）共用。 */
export class OpenAiCompatClient implements LlmClient {
  private readonly client: OpenAI;
  readonly label: string;

  constructor(private readonly cfg: ModelConfig, kind: 'cloud' | 'local') {
    this.client = new OpenAI({ baseURL: cfg.baseURL, apiKey: cfg.apiKey || 'not-needed', timeout: 60_000, maxRetries: 1 });
    this.label = `${kind}:${cfg.model}`;
  }

  async chat(messages: LlmMessage[], opts: LlmOptions = {}): Promise<LlmResult> {
    const params = {
      model: this.cfg.model,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      messages: messages as any,
      tools: opts.tools?.length ? opts.tools : undefined,
      temperature: opts.temperature ?? 0.4,
      max_tokens: opts.maxTokens,
      response_format: opts.json ? { type: 'json_object' as const } : undefined,
    };
    if (opts.onDelta) {
      // DeepSeek V4/Flash 默认先深入思考，短正文可能在思考结束后集中返回。
      // 主对话使用官方快速回复开关，正文直接生成；后台请求保留原有模式。
      // https://api-docs.deepseek.com/guides/thinking_mode/
      const fastDeepSeek = this.label.startsWith('cloud:') && /^deepseek-(?:v4(?:[.\-]|$)|flash(?:-|$)|chat$)/i.test(this.cfg.model.trim());
      const stream = await this.client.chat.completions.create({
        ...params, stream: true, ...(fastDeepSeek ? { thinking: { type: 'disabled' as const } } : {}),
      }, { signal: opts.signal });
      let content = '';
      let finished: string | null = null;
      const calls = new Map<number, { id: string; name: string; arguments: string }>();
      for await (const chunk of stream) {
        opts.signal?.throwIfAborted();
        const choice = chunk.choices.find((c) => c.index === 0);
        if (!choice) continue;
        if (choice.delta.content) { content += choice.delta.content; opts.onDelta(choice.delta.content); }
        for (const part of choice.delta.tool_calls ?? []) {
          const call = calls.get(part.index) ?? { id: '', name: '', arguments: '' };
          call.id += part.id ?? ''; call.name += part.function?.name ?? ''; call.arguments += part.function?.arguments ?? '';
          calls.set(part.index, call);
        }
        if (choice.finish_reason) finished = choice.finish_reason;
      }
      opts.signal?.throwIfAborted();
      const toolCalls = [...calls.entries()].sort(([a], [b]) => a - b).map(([, c]) => c);
      // 回复太长、碰到输出上限：保留已经生成的正文，提示被截断（没有半截的工具调用时）
      if (finished === 'length' && content && !toolCalls.length) {
        const note = '\n\n> 回复太长，后面被截断了。可以让我「接着说」。';
        opts.onDelta(note);
        return { content: content + note, toolCalls: [] };
      }
      if (finished !== 'stop' && finished !== 'tool_calls') throw new Error(`模型回复未完整结束（${finished ?? '连接提前断开'}）`);
      if (toolCalls.some((c) => !c.id || !c.name)) throw new Error('工具调用未完整接收');
      return { content, toolCalls };
    }
    const res = await this.client.chat.completions.create(params, { signal: opts.signal });
    const choice = res.choices[0];
    if (choice?.finish_reason === 'length' && choice.message.content && !choice.message.tool_calls?.length) {
      return { content: `${choice.message.content}\n\n> 回复太长，后面被截断了。`, toolCalls: [] };
    }
    if (!choice || (choice.finish_reason !== 'stop' && choice.finish_reason !== 'tool_calls')) {
      throw new Error(`模型回复未完整结束（${choice?.finish_reason ?? '没有返回内容'}）`);
    }
    const m = choice.message;
    const toolCalls = (m.tool_calls ?? [])
      .filter((t) => t.type === 'function')
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .map((t: any) => ({ id: t.id as string, name: t.function.name as string, arguments: t.function.arguments as string }));
    if (toolCalls.some((call) => !call.id || !call.name)) throw new Error('工具调用未完整接收');
    return {
      content: m?.content ?? '',
      toolCalls,
    };
  }
}

/** 常用厂商预设（设置页使用） */
export const MODEL_PRESETS: { name: string; kind: 'cloud' | 'local'; baseURL: string; model: string }[] = [
  { name: 'DeepSeek', kind: 'cloud', baseURL: 'https://api.deepseek.com', model: 'deepseek-chat' },
  { name: '通义千问', kind: 'cloud', baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus' },
  { name: 'Kimi', kind: 'cloud', baseURL: 'https://api.moonshot.cn/v1', model: 'kimi-latest' },
  { name: '智谱 GLM', kind: 'cloud', baseURL: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4-plus' },
  { name: 'Ollama（本地）', kind: 'local', baseURL: 'http://127.0.0.1:11434/v1', model: 'qwen2.5:7b' },
];

/**
 * 模型路由（PRD §6.1、§6.2）。
 * - 高敏感任务（邮件、记忆、研判）优先本地；本地不可用时，只有用户允许才改用云端，否则返回 null（调用方退回规则处理）。
 * - 复杂任务（对话、规划、工单）优先云端；云端不可用时用本地。
 */
// activity_extract：从公开文章里提取活动，内容公开、不敏感，优先云端
export type AiTask = 'mail_classify' | 'link' | 'memory_extract' | 'assess' | 'chat' | 'brief' | 'plan' | 'ticket' | 'activity_extract';
const SENSITIVE: AiTask[] = ['mail_classify', 'link', 'memory_extract', 'assess'];

export class ModelRouter {
  private cache = new Map<string, LlmClient>();

  constructor(private readonly getSettings: () => Settings, private readonly factory = (cfg: ModelConfig, kind: 'cloud' | 'local'): LlmClient => new OpenAiCompatClient(cfg, kind)) {}

  private client(kind: 'cloud' | 'local'): LlmClient | null {
    const cfg = this.getSettings()[kind];
    if (!cfg?.baseURL || !cfg.model) return null;
    const key = `${kind}|${cfg.baseURL}|${cfg.model}|${cfg.apiKey}`;
    if (!this.cache.has(key)) this.cache.set(key, this.factory(cfg, kind));
    return this.cache.get(key)!;
  }

  for(task: AiTask): LlmClient | null {
    const local = this.client('local');
    const cloud = this.client('cloud');
    if (SENSITIVE.includes(task)) {
      if (local) return local;
      return this.getSettings().allowSensitiveToCloud ? cloud : null;
    }
    return cloud ?? local;
  }

  hasAny(): boolean {
    return !!(this.client('local') || this.client('cloud'));
  }
}

/** 地址是不是本机（本机的向量服务收到记忆内容不出电脑） */
export function isLocalUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname;
    return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]';
  } catch { return false; }
}

/** OpenAI 兼容的向量接口 */
export class OpenAiEmbedder implements Embedder {
  private readonly client: OpenAI;
  readonly model: string;
  constructor(cfg: ModelConfig) {
    this.client = new OpenAI({ baseURL: cfg.baseURL, apiKey: cfg.apiKey || 'none', timeout: 20_000, maxRetries: 1 });
    this.model = cfg.model;
  }
  async embed(texts: string[]): Promise<number[][]> {
    const r = await this.client.embeddings.create({ model: this.model, input: texts.map((t) => t.slice(0, 2000)) });
    return [...r.data].sort((a, b) => a.index - b.index).map((d) => d.embedding as number[]);
  }
}

const embedders = new Map<string, Embedder>();
/**
 * 用户配置的向量模型。记忆和对话属于隐私内容：只有向量服务在本机，或用户允许把隐私任务交给云端时才用。
 */
export function embedderFor(settings: Settings): Embedder | null {
  const cfg = settings.embedding;
  if (!cfg?.baseURL || !cfg.model) return null;
  if (!isLocalUrl(cfg.baseURL) && !settings.allowSensitiveToCloud) return null;
  const key = `${cfg.baseURL}|${cfg.model}|${cfg.apiKey}`;
  if (!embedders.has(key)) embedders.set(key, new OpenAiEmbedder(cfg));
  return embedders.get(key)!;
}

/** 宽松地从模型输出里解析 JSON（容忍 ```json 包裹和前后多余文字） */
export function parseJsonLoose<T>(text: string): T | null {
  const cleaned = text.replace(/```(?:json)?/g, '').trim();
  const start = Math.min(...['{', '['].map((c) => cleaned.indexOf(c)).filter((i) => i >= 0));
  if (!Number.isFinite(start)) return null;
  const end = Math.max(cleaned.lastIndexOf('}'), cleaned.lastIndexOf(']'));
  try {
    return JSON.parse(cleaned.slice(start, end + 1)) as T;
  } catch {
    return null;
  }
}

/**
 * 模型调用失败的原因，翻译成用户看得懂、能自己处理的话（不包含 API Key 等敏感内容）。
 * contextTooLong：请求超出模型的上下文长度，可以缩短后重试。
 */
export function describeModelError(e: unknown): { text: string; contextTooLong: boolean } {
  const err = e as { status?: number; message?: string; code?: string; cause?: { code?: string } };
  const msg = String(err?.message ?? e ?? '').replace(/sk-[\w-]{6,}/g, 'sk-***').slice(0, 200);
  const status = err?.status;
  if (status === 400 && /context|length|token|too long|maximum/i.test(msg)) return { text: '这段对话太长，超出了模型一次能读的长度', contextTooLong: true };
  if (status === 401 || /invalid.*api.?key|authentication/i.test(msg)) return { text: 'API Key 无效或已过期，请到「设置 → 模型」检查', contextTooLong: false };
  if (status === 402 || /insufficient.*balance|余额/i.test(msg)) return { text: '模型账户余额不足，请到模型服务商那里充值', contextTooLong: false };
  if (status === 429) return { text: '请求太频繁或模型服务限流了，稍等一会儿再试', contextTooLong: false };
  if (status && status >= 500) return { text: `模型服务暂时不可用（${status}），稍后再试`, contextTooLong: false };
  if (status === 400) return { text: '模型服务拒绝了这次请求（400），可能是模型名或参数不对，详细原因已记录在运行日志里', contextTooLong: false };
  if (/timeout|timed out/i.test(msg)) return { text: '模型响应超时，可能是网络慢或问题太复杂，请重试', contextTooLong: false };
  if (/ENOTFOUND|ECONNREFUSED|ECONNRESET|fetch failed|network|Connection error/i.test(msg + (err?.cause?.code ?? ''))) return { text: '连不上模型服务，请检查网络和「设置 → 模型」里的服务地址', contextTooLong: false };
  // 其他错误不把服务返回的原文放进对话（可能包含敏感内容），详细原因只打印到运行日志
  return { text: '连接中断或模型未能正常返回，请检查网络和模型配置后重试', contextTooLong: false };
}
