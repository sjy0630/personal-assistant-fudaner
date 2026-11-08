import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { LlmTool } from '../ai/llm';

interface Connected {
  name: string;
  client: Client;
  /** readOnly 来自服务声明的 readOnlyHint，只供本地循环判断，不发给模型 */
  tools: { name: string; description?: string; inputSchema: Record<string, unknown>; readOnly: boolean }[];
  /** 外部服务（独立进程）：调用超时更长 */
  external?: boolean;
}

export interface StdioLaunch { command: string; args: string[]; cwd?: string; env?: Record<string, string> }

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

  /**
   * 连接一个外部 MCP 服务（子进程，stdio）。只登记 allow 允许的工具，其余工具模型看不到、也调不到。
   * 返回开放和屏蔽的工具名；启动失败时抛出带 stderr 末尾内容的错误。
   */
  async connectStdio(
    name: string, launch: StdioLaunch,
    allow: (tool: { name: string; annotations?: { readOnlyHint?: boolean } }) => boolean,
    opts: { timeoutMs?: number } = {},
  ): Promise<{ tools: string[]; blocked: string[] }> {
    await this.disconnect(name);
    const transport = new StdioClientTransport({ command: launch.command, args: launch.args, cwd: launch.cwd, env: launch.env, stderr: 'pipe' });
    let stderr = '';
    transport.stderr?.on('data', (chunk: Buffer) => { stderr = (stderr + chunk.toString('utf8')).slice(-2000); });
    const client = new Client({ name: `fudaner-agent→${name}`, version: '0.1.0' });
    // Windows 的命令查找失败发生在 spawn 之后；connect 最终只抛“连接关闭”。
    // 保留 SDK 上报的原始 ENOENT，避免依赖本地化的 cmd.exe 错误输出。
    let commandMissing = false;
    client.onerror = (error) => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') commandMissing = true; };
    try {
      await client.connect(transport, { timeout: opts.timeoutMs ?? 120_000 });
      const { tools } = await client.listTools(undefined, { timeout: opts.timeoutMs ?? 120_000 });
      const open = tools.filter((t) => allow({ name: t.name, annotations: t.annotations as { readOnlyHint?: boolean } | undefined }));
      this.servers.push({
        name, client, external: true,
        tools: open.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema as Record<string, unknown>, readOnly: t.annotations?.readOnlyHint === true })),
      });
      return { tools: open.map((t) => t.name), blocked: tools.filter((t) => !open.includes(t)).map((t) => t.name) };
    } catch (e) {
      await client.close().catch(() => undefined);
      const code = (e as NodeJS.ErrnoException).code;
      const reason = commandMissing || code === 'ENOENT' ? `找不到命令「${launch.command}」，请确认已经安装，或填写完整路径` : (e as Error).message;
      if (commandMissing || code === 'ENOENT') throw new Error(reason);
      const tail = stderr.trim().split('\n').slice(-3).join(' / ');
      throw new Error(tail ? `${reason}（服务输出：${tail.slice(0, 300)}）` : reason);
    }
  }

  async disconnect(name: string): Promise<void> {
    const s = this.servers.find((x) => x.name === name);
    if (!s) return;
    this.servers = this.servers.filter((x) => x !== s);
    await s.client.close().catch(() => undefined);
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
    // 外部服务只能调用登记过（允许）的工具
    if (s.external && !s.tools.some((t) => t.name === tool)) return { server: s.name, tool, ok: false, text: `工具 ${tool} 没有开放（可能会修改数据）。` };
    try {
      const res = await s.client.callTool({ name: tool, arguments: args }, undefined, s.external ? { timeout: 180_000 } : undefined);
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
