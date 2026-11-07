import { createServer, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, expect, it } from 'vitest';
import { OpenAiCompatClient, type LlmMessage } from '../src/main/ai/llm';

let server: Server;
afterEach(async () => { server?.closeAllConnections(); if (server) await new Promise<void>((resolve) => server.close(() => resolve())); });
const dataUrl = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==';
async function fixture(handler: (res: ServerResponse, body: Record<string, unknown>) => void) {
  server = createServer((req, res) => { let text = ''; req.on('data', (chunk) => text += chunk); req.on('end', () => handler(res, JSON.parse(text))); });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return new OpenAiCompatClient({ baseURL: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, apiKey: 'fixture', model: 'vision-fixture' }, 'cloud');
}
it('兼容接口把图片作为真实 image_url 发送，同时保留 SSE 流', async () => {
  let request: Record<string, unknown> = {};
  const client = await fixture((res, body) => {
    request = body; res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: ' + JSON.stringify({ choices: [{ index: 0, delta: { content: '红色' }, finish_reason: null }] }) + '\n\n');
    res.end('data: ' + JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }) + '\n\ndata: [DONE]\n\n');
  });
  const message = { role: 'user', content: '图片是什么颜色？', images: [{ dataUrl }] } as LlmMessage;
  const chunks: string[] = [];
  await client.chat([message], { onDelta: (part) => chunks.push(part) });
  expect(request.messages).toEqual([{ role: 'user', content: [
    { type: 'text', text: '图片是什么颜色？' }, { type: 'image_url', image_url: { url: dataUrl } },
  ] }]);
  expect(chunks).toEqual(['红色']);
});
it('服务商明确不支持图片时返回可操作提示并省略服务端敏感正文', async () => {
  const client = await fixture((res) => {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'model does not support image_url secret-fixture', type: 'invalid_request_error' } }));
  });
  const message = { role: 'user', content: '看图', images: [{ dataUrl }] } as LlmMessage;
  await expect(client.chat([message])).rejects.toThrow('支持图片');
  await expect(client.chat([message])).rejects.not.toThrow('secret-fixture');
});
