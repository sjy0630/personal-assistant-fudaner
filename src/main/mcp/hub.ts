import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { LlmTool } from '../ai/llm';

interface Connected { name: string; client: Client; tools: { name: string; description?: string; inputSchema: Record<string, unknown>; readOnly: boolean }[] }

/**
 * MCP 客户端集线器（PRD §7.5）。
 * 初赛：所有 MCP 服务在主进程内运行，用 InMemoryTransport 连接；
 * 之后拆成独立服务时，只需把这里的传输换成 stdio，智能体代码不用改。
 */
export class McpHub {
  private servers: Connected[] = [];

  async connect(name: string, server: McpServer): Promise<void> {
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    await server.connect(serverT);
    const client = new Client({ name: `fudaner-agent→${name}`, version: '0.1.0' });
    await client.connect(clientT);
    const { tools } = await client.listTools();
    this.servers.push({ name, client, tools: tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema as Record<string, unknown>, readOnly: t.annotations?.readOnlyHint === true })) });
  }

  /** 转换成模型的 function calling 定义。工具名格式：<服务名>__<工具名> */
  llmTools(filter?: (server: string, tool: string) => boolean): LlmTool[] {
    return this.servers.flatMap((s) =>
      s.tools
        .filter((t) => !filter || filter(s.name, t.name))
        .map((t) => ({
          type: 'function' as const,
          function: { name: `${s.name.replace(/-/g, '_')}__${t.name}`, description: `[${s.name}] ${t.description ?? ''}`, parameters: t.inputSchema },
        })),
    );
  }

  /** 只信任服务注册的只读标记；未知工具和写工具都不能复用执行结果。 */
  isReadOnly(qualified: string): boolean {
    const [srv, tool] = qualified.split('__');
    return this.servers.find(s => s.name.replace(/-/g, '_') === srv)?.tools.find(t => t.name === tool)?.readOnly === true;
  }

  /** 调用工具，返回文本结果 */
  async call(qualified: string, args: Record<string, unknown>): Promise<{ server: string; tool: string; ok: boolean; text: string }> {
    const [srv, tool] = qualified.split('__');
    const s = this.servers.find((x) => x.name.replace(/-/g, '_') === srv);
    if (!s) return { server: srv, tool, ok: false, text: `未知的工具服务：${srv}` };
    try {
      const res = await s.client.callTool({ name: tool, arguments: args });
      const text = (res.content as { type: string; text?: string }[]).map((c) => c.text ?? '').join('\n');
      return { server: s.name, tool, ok: !res.isError, text };
    } catch (e) {
      return { server: s.name, tool, ok: false, text: `工具调用失败：${(e as Error).message}` };
    }
  }

  list(): { server: string; tools: string[] }[] {
    return this.servers.map((s) => ({ server: s.name, tools: s.tools.map((t) => t.name) }));
  }

  async close(): Promise<void> {
    await Promise.all(this.servers.map((s) => s.client.close().catch(() => undefined)));
    this.servers = [];
  }
}
