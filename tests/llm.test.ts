import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ModelRouter, OpenAiCompatClient, parseJsonLoose } from '../src/main/ai/llm';
import type { Settings } from '../src/shared/types';

/**
 * 模型客户端与路由（PRD §6）。用本地假服务器模拟 OpenAI 兼容接口，
 * 确认请求格式（模型名、工具定义、JSON 模式）和返回解析（文本、工具调用）都正确。
 */
let server: Server;
let baseURL = '';
const requests: Record<string, unknown>[] = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const j = JSON.parse(body);
      requests.push(j);
      const message = j.tools
        ? { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'fudaner_local__list_deadlines', arguments: '{"to":"2026-11-12T00:00:00Z"}' } }] }
        : { role: 'assistant', content: '```json\n{"value":0.7}\n```' };
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ id: 'x', object: 'chat.completion', created: 0, model: j.model, choices: [{ index: 0, message, finish_reason: 'stop' }] }));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

describe('OpenAI 兼容客户端', () => {
  it('发送工具定义，并解析模型返回的工具调用', async () => {
    const llm = new OpenAiCompatClient({ baseURL, apiKey: 'test', model: 'deepseek-chat' }, 'cloud');
    const r = await llm.chat([{ role: 'user', content: '这周有什么 DDL？' }], {
      tools: [{ type: 'function', function: { name: 'fudaner_local__list_deadlines', parameters: { type: 'object', properties: { to: { type: 'string' } } } } }],
    });
    expect(llm.label).toBe('cloud:deepseek-chat');
    expect(requests.at(-1)).toMatchObject({ model: 'deepseek-chat', messages: [{ role: 'user', content: '这周有什么 DDL？' }] });
    expect(r.toolCalls).toEqual([{ id: 'call_1', name: 'fudaner_local__list_deadlines', arguments: '{"to":"2026-11-12T00:00:00Z"}' }]);
  });

  it('JSON 模式：请求带 response_format，宽松解析能剥掉 ```json 包裹', async () => {
    const llm = new OpenAiCompatClient({ baseURL, apiKey: '', model: 'qwen2.5:3b' }, 'local');
    const r = await llm.chat([{ role: 'user', content: '研判' }], { json: true });
    expect(requests.at(-1)).toMatchObject({ response_format: { type: 'json_object' } });
    expect(parseJsonLoose<{ value: number }>(r.content)).toEqual({ value: 0.7 });
  });
});

describe('模型路由（隐私任务优先本地）', () => {
  const cloud = { baseURL: 'https://cloud.example/v1', apiKey: 'k', model: 'cloud-model' };
  const local = { baseURL: 'http://127.0.0.1:11434/v1', apiKey: '', model: 'local-model' };
  const router = (s: Partial<Settings>) => new ModelRouter(() => ({ demoMode: false, quietHours: { start: '23:30', end: '07:30' }, ...s }));

  it('两种都配置时：隐私任务走本地，对话走云端', () => {
    const r = router({ cloud, local });
    expect(r.for('mail_classify')?.label).toBe('local:local-model');
    expect(r.for('memory_extract')?.label).toBe('local:local-model');
    expect(r.for('chat')?.label).toBe('cloud:cloud-model');
  });

  it('只有云端时：隐私任务默认不发给云端（退回规则），用户允许后才发', () => {
    expect(router({ cloud }).for('mail_classify')).toBeNull();
    expect(router({ cloud, allowSensitiveToCloud: true }).for('mail_classify')?.label).toBe('cloud:cloud-model');
  });

  it('只有本地时：所有任务都用本地', () => {
    expect(router({ local }).for('chat')?.label).toBe('local:local-model');
  });
});
