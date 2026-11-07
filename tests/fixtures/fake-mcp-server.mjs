// 测试用的假外部 MCP 服务（stdio）：一个只读工具、一个会修改数据的工具
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const server = new McpServer({ name: 'fake-campus', version: '0.0.1' });
server.registerTool('search_holes', {
  description: '搜索（只读）', inputSchema: { keyword: z.string() }, annotations: { readOnlyHint: true },
}, async ({ keyword }) => ({ content: [{ type: 'text', text: `找到关于「${keyword}」的 2 条结果` }] }));
server.registerTool('sports_book', {
  description: '预约场馆（写操作）', inputSchema: { venue: z.string() },
}, async () => ({ content: [{ type: 'text', text: 'BOOKED' }] }));
if (process.env.FAKE_MCP_CRASH) { console.error('missing credentials: please run setup'); process.exit(1); }
await server.connect(new StdioServerTransport());
