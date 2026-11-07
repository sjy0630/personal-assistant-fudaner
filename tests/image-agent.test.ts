import { afterEach, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { Db } from '../src/main/db/db';
import { Repo } from '../src/main/db/repo';
import { ChatAgent } from '../src/main/ai/agent';
import { ImageModelError, type LlmClient, type LlmMessage, type ModelRouter } from '../src/main/ai/llm';
import type { McpHub } from '../src/main/mcp/hub';
import { ResourceImages } from '../src/main/library/resource-images';
import { normalizeImage } from '../src/main/library/images';
import { nullChannels } from '../src/main/engine/channels';

const opened: Db[] = [];
const dirs: string[] = [];
afterEach(async () => { opened.splice(0).forEach((db) => db.close()); await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });

async function setup(chat: LlmClient['chat']) {
  const directory = await mkdtemp(join(tmpdir(), 'fudaner-image-agent-')); dirs.push(directory);
  const db = new Db(':memory:'); opened.push(db);
  const repo = new Repo(db);
  const images = new ResourceImages(repo, directory);
  const input = await sharp({ create: { width: 12, height: 8, channels: 3, background: 'red' } }).png().toBuffer();
  const normalized = await normalizeImage(input, '.png');
  const path = await images.save(normalized);
  const resource = repo.addResource({ title: '颜色测试图', kind: 'upload', mime: 'image/png', text: '12×8 图片', path });
  const client: LlmClient = { label: 'cloud:fixture', chat };
  const router = { for: (task: string) => task === 'chat' ? client : null } as ModelRouter;
  const hub = { llmTools: () => [], call: async () => ({ ok: true, server: 'fudaner-local', tool: 'read_resource', text: JSON.stringify({ id: resource.id, text: resource.text }) }) } as unknown as McpHub;
  const agent = new ChatAgent(repo, router, hub, nullChannels, undefined, (id) => images.read(id));
  return { repo, resource, agent };
}
async function imageColor(messages: LlmMessage[]) {
  const image = messages.flatMap((message) => message.images ?? []).at(-1);
  expect(image?.dataUrl).toMatch(/^data:image\/png;base64,/);
  const pixels = await sharp(Buffer.from(image!.dataUrl.split(',')[1], 'base64')).raw().toBuffer();
  expect(pixels[0]).toBe(255);
  expect(pixels[1]).toBe(0);
}
it('图片引用发送真实像素，下一轮不重新附图也能继续问这张图', async () => {
  const snapshots: LlmMessage[][] = [];
  const { agent, resource } = await setup(async (messages) => {
    await imageColor(messages); snapshots.push(structuredClone(messages));
    return { content: '看到了红色图片。', toolCalls: [] };
  });
  const first = await agent.handleUserMessage('什么颜色', [{ type: 'resource', id: resource.id, title: resource.title }]);
  expect(first.content).toBe('看到了红色图片。');
  const second = await agent.handleUserMessage('图片里有蓝色吗');
  expect(second.content).toBe('看到了红色图片。');
  expect(snapshots[1].at(-1)?.images).toBeUndefined();
  expect(snapshots[1].some((message) => message.role === 'user' && message.images?.length)).toBe(true);
});
it('读取图片资源的工具调用后，模型可以在下一步收到图像', async () => {
  let calls = 0;
  const { agent } = await setup(async (messages) => {
    if (++calls === 1) return { content: '', toolCalls: [{ id: 'read-image', name: 'fudaner_local__read_resource', arguments: '{}' }] };
    await imageColor(messages);
    if (calls === 2) expect(messages.find((message) => message.role === 'tool')?.tool_call_id).toBe('read-image');
    return { content: '资源里是红色图片。', toolCalls: [] };
  });
  expect((await agent.handleUserMessage('查看资源库里的图')).content).toBe('资源里是红色图片。');
  expect((await agent.handleUserMessage('这张图片还有别的颜色吗')).content).toBe('资源里是红色图片。');
});
it('不支持图片的错误有明确说明，之后的普通文本对话仍可继续', async () => {
  let calls = 0;
  const { agent, resource } = await setup(async (messages) => {
    if (++calls === 1) throw new ImageModelError();
    expect(messages.flatMap((message) => message.images ?? [])).toEqual([]);
    return { content: '普通对话正常。', toolCalls: [] };
  });
  const first = await agent.handleUserMessage('看图', [{ type: 'resource', id: resource.id, title: resource.title }]);
  expect(first.content).toContain('选择支持图片的模型');
  expect((await agent.handleUserMessage('你好')).content).toBe('普通对话正常。');
});

it('未配置模型时说明附件尚未分析，避免用无关作业规则回答图片内容', async () => {
  const { repo, resource } = await setup(async () => { throw new Error('不应调用'); });
  const agent = new ChatAgent(repo, { for: () => null } as unknown as ModelRouter, {} as McpHub, nullChannels);
  const response = await agent.handleUserMessage('看图里的作业', [{ type: 'resource', id: resource.id, title: resource.title }]);
  expect(response.content).toContain('分析附件需要先');
  expect(response.content).not.toContain('接下来 7 天');
});

it('长历史缩短并自动重试时，仍为正确的历史消息附上图片', async () => {
  const snapshots: LlmMessage[][] = [];
  const { repo, agent, resource } = await setup(async (messages) => {
    snapshots.push(structuredClone(messages));
    await imageColor(messages);
    if (snapshots.length === 1) throw Object.assign(new Error('maximum context length exceeded'), { status: 400 });
    return { content: '图片仍是红色。', toolCalls: [] };
  });
  for (let i = 0; i < 10; i++) {
    repo.addMessage({ role: 'user', content: `旧问题 ${i}` });
    repo.addMessage({ role: 'assistant', content: '旧回复'.repeat(800) });
  }
  repo.addMessage({ role: 'user', content: '先看看这张图', refs: [{ type: 'resource', id: resource.id, title: resource.title }] });
  repo.addMessage({ role: 'assistant', content: '是红色。' });
  expect((await agent.handleUserMessage('继续说说颜色')).content).toBe('图片仍是红色。');
  expect(snapshots).toHaveLength(2);
  expect(snapshots[1].length).toBeLessThan(snapshots[0].length);
  for (const messages of snapshots) {
    expect(messages.find((message) => message.images?.length)?.content).toBe('先看看这张图');
    expect(messages.at(-1)?.images).toBeUndefined();
    expect(messages.every((message) => !message.content || message.role === 'system' || message.content.length <= 2020)).toBe(true);
  }
});

it('长回复之后工具读图失败，历史截短不会让下一次普通对话再次带上失败图片', async () => {
  let calls = 0;
  const { agent } = await setup(async (messages) => {
    if (++calls === 1) return { content: '正在检查资源。'.repeat(400), toolCalls: [{ id: 'read-image', name: 'fudaner_local__read_resource', arguments: '{}' }] };
    if (calls === 2) throw new ImageModelError();
    expect(messages.flatMap((message) => message.images ?? [])).toEqual([]);
    return { content: '普通对话正常。', toolCalls: [] };
  });
  expect((await agent.handleUserMessage('查看资源库里的图')).content).toContain('选择支持图片的模型');
  expect((await agent.handleUserMessage('你好')).content).toBe('普通对话正常。');
});

it('已执行工具后上下文超长时不重新开始整轮，避免重复下载或导入', async () => {
  let calls = 0;
  const { agent } = await setup(async () => {
    if (++calls === 1) return { content: '', toolCalls: [{ id: 'read-image', name: 'fudaner_local__read_resource', arguments: '{}' }] };
    throw Object.assign(new Error('maximum context length exceeded'), { status: 400 });
  });
  expect((await agent.handleUserMessage('读取资源')).content).toContain('超出了模型一次能读的长度');
  expect(calls).toBe(2);
});
