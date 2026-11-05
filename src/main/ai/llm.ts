import OpenAI from 'openai';
import type { ModelConfig, Settings } from '../../shared/types';

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
      const stream = await this.client.chat.completions.create({ ...params, stream: true }, { signal: opts.signal });
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
      if (finished !== 'stop' && finished !== 'tool_calls') throw new Error('模型回复未完整结束');
      const toolCalls = [...calls.entries()].sort(([a], [b]) => a - b).map(([, c]) => c);
      if (toolCalls.some((c) => !c.id || !c.name)) throw new Error('工具调用未完整接收');
      return { content, toolCalls };
    }
    const res = await this.client.chat.completions.create(params, { signal: opts.signal });
    const m = res.choices[0]?.message;
    return {
      content: m?.content ?? '',
      toolCalls: (m?.tool_calls ?? [])
        .filter((t) => t.type === 'function')
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .map((t: any) => ({ id: t.id, name: t.function.name, arguments: t.function.arguments })),
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
export type AiTask = 'mail_classify' | 'link' | 'memory_extract' | 'assess' | 'chat' | 'brief' | 'plan' | 'ticket';
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
