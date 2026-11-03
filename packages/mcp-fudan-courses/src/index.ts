import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

export * from './match.js';

/** 宿主提供：课程总表及按课程汇总的跨平台数据 */
export interface CourseRegistryData {
  list(): Promise<unknown[]>;
  /** 某门课在各平台的数据汇总：作业、公告、相关邮件、回放 */
  get(code: string): Promise<unknown | null>;
}

const json = (data: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] });

/** 创建 fudan-courses MCP 服务（PRD §7.4、§7.5）。只读。 */
export function createCoursesServer(data: CourseRegistryData): McpServer {
  const server = new McpServer({ name: 'fudan-courses', version: '0.1.0' });
  const ro = { readOnlyHint: true };

  server.registerTool('list_courses', {
    description: '列出课程总表：每门课的课程代码、教学班、教师，以及在 eLearning / iCourse 的对应关系',
    inputSchema: {},
    annotations: ro,
  }, async () => json(await data.list()));

  server.registerTool('get_course', {
    description: '获取一门课在各平台的全部信息：作业（含提交状态）、公告、相关邮件、回放。参数可以是课程代码或课程名',
    inputSchema: { code: z.string().describe('课程代码（如 COMP130004.01）或课程名') },
    annotations: ro,
  }, async ({ code }) => json(await data.get(code)));

  return server;
}
