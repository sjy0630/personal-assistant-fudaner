import { createServer, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runAgentLoop } from '../src/main/ai/agent';
import { OpenAiCompatClient } from '../src/main/ai/llm';
import type { McpHub } from '../src/main/mcp/hub';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });

async function fixture(reply: (response: ServerResponse, body: Record<string, unknown>) => void) {
  const server = createServer((request, response) => {
    let body = '';
    request.on('data', (chunk) => { body += chunk; });
    request.on('end', () => reply(response, JSON.parse(body)));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  cleanups.push(() => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  return new OpenAiCompatClient({ baseURL: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, model: 'fixture', apiKey: '' }, 'local');
}
function frame(response: ServerResponse, delta: unknown, finish: string | null = null) {
  response.write(`data: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', created: 0, model: 'fixture', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
}

describe('后台非流式与截断保护（本地 HTTP 假服务）', () => {
  it.each(['length', 'content_filter', null])('非流式 finish_reason=%s 时拒绝正文和工具调用', async (finishReason) => {
    let request: Record<string, unknown> = {};
    const llm = await fixture((response, body) => {
      request = body;
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: '未完成的材料清单', tool_calls: [{ id: 'save', type: 'function', function: { name: 'fudaner_local__save_resource', arguments: '{"title":"未完成"}' } }] }, finish_reason: finishReason }] }));
    });
    const call = vi.fn();
    await expect(runAgentLoop({ llm, hub: { call } as unknown as McpHub, tools: [], messages: [{ role: 'user', content: '整理材料清单' }] })).rejects.toThrow('未完整结束');
    expect(request.stream).not.toBe(true);
    expect(call).not.toHaveBeenCalled();
  });

  it('流式收到 DONE 但缺少正常结束标记时不执行工具', async () => {
    const llm = await fixture((response) => {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      frame(response, { tool_calls: [{ index: 0, id: 'save', type: 'function', function: { name: 'fudaner_local__save_resource', arguments: '{"title":"不能保存"}' } }] });
      response.end('data: [DONE]\n\n');
    });
    const call = vi.fn();
    await expect(runAgentLoop({ llm, hub: { call } as unknown as McpHub, tools: [], messages: [], onDelta() {} })).rejects.toThrow('未完整结束');
    expect(call).not.toHaveBeenCalled();
  });

  it('流式正常结束但参数仍残缺时不执行工具', async () => {
    const llm = await fixture((response) => {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      frame(response, { tool_calls: [{ index: 0, id: 'save', type: 'function', function: { name: 'fudaner_local__save_resource', arguments: '{"title":' } }] });
      frame(response, {}, 'tool_calls');
      response.end('data: [DONE]\n\n');
    });
    const call = vi.fn();
    await expect(runAgentLoop({ llm, hub: { call } as unknown as McpHub, tools: [], messages: [], onDelta() {} })).rejects.toThrow('工具参数不完整');
    expect(call).not.toHaveBeenCalled();
  });

  it('交错的多个流式工具按 index 归并，中文参数完整还原', async () => {
    const llm = await fixture((response) => {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      frame(response, { tool_calls: [{ index: 1, id: 'call-b', type: 'function', function: { name: 'fudaner_local__recall', arguments: '{"query":"周二' } }] });
      frame(response, { content: '先查询。', tool_calls: [{ index: 0, id: 'call-a', type: 'function', function: { name: 'fudaner_local__get_today', arguments: '{}' } }] });
      frame(response, { tool_calls: [{ index: 1, function: { arguments: '晚上社团"}' } }] });
      frame(response, {}, 'tool_calls');
      response.end('data: [DONE]\n\n');
    });
    const chunks: string[] = [];
    const result = await llm.chat([{ role: 'user', content: '规划' }], { onDelta: (chunk) => chunks.push(chunk) });
    expect(chunks.join('')).toBe('先查询。');
    expect(result.toolCalls.map((call) => call.id)).toEqual(['call-a', 'call-b']);
    expect(JSON.parse(result.toolCalls[1].arguments)).toEqual({ query: '周二晚上社团' });
  });
});
