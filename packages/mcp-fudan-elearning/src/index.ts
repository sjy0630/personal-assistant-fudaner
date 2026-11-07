import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { ElearningClient } from './client.js';

export * from './client.js';

/**
 * 只读的数据访问接口。宿主（Fudaner 桌面端）用本地库实现它，让工具默认读缓存；
 * 独立运行时可以直接用 ElearningClient 实现。
 */
export interface ElearningData {
  listCourses(): Promise<unknown[]>;
  listAssignments(filter: { courseCode?: string; dueBefore?: string; status?: 'pending' | 'submitted' | 'all' }): Promise<unknown[]>;
  getAssignment(id: string): Promise<unknown | null>;
  listAnnouncements(filter: { courseCode?: string; since?: string }): Promise<unknown[]>;
  /** refresh=true 时由宿主触发一次实时同步 */
  refresh?(): Promise<void>;
  /** 课程文件（课件）列表：实时读取 */
  listFiles?(courseCode: string, query?: string): Promise<unknown>;
  /** 下载课件到本机（宿主决定保存位置，可同时导入资源库） */
  downloadFile?(fileId: string, opts: { courseCode?: string; addToLibrary: boolean }): Promise<unknown>;
}

const json = (data: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] });

/** 创建 fudan-elearning MCP 服务（PRD §7.5）。所有工具只读。 */
export function createElearningServer(data: ElearningData, _client?: ElearningClient): McpServer {
  const server = new McpServer({ name: 'fudan-elearning', version: '0.1.0' });
  const ro = { readOnlyHint: true };

  server.registerTool('list_courses', {
    description: '列出本学期在复旦 eLearning 上的课程（课程名、课程代码、教师）',
    inputSchema: {},
    annotations: ro,
  }, async () => json(await data.listCourses()));

  server.registerTool('list_assignments', {
    description: '列出 eLearning 作业，可按课程代码、截止时间、提交状态筛选',
    inputSchema: {
      course_code: z.string().optional().describe('课程代码，如 COMP130004.01'),
      due_before: z.string().optional().describe('ISO 时间，只返回在此之前截止的作业'),
      status: z.enum(['pending', 'submitted', 'all']).optional().describe('pending=未提交'),
      refresh: z.boolean().optional().describe('为 true 时先实时同步一次 eLearning'),
    },
    annotations: ro,
  }, async (args) => {
    if (args.refresh) await data.refresh?.();
    return json(await data.listAssignments({ courseCode: args.course_code, dueBefore: args.due_before, status: args.status }));
  });

  server.registerTool('get_assignment', {
    description: '获取一份作业的详情（说明、截止时间、提交状态、链接）',
    inputSchema: { id: z.string() },
    annotations: ro,
  }, async ({ id }) => json(await data.getAssignment(id)));

  server.registerTool('list_announcements', {
    description: '列出课程公告',
    inputSchema: { course_code: z.string().optional(), since: z.string().optional() },
    annotations: ro,
  }, async (args) => json(await data.listAnnouncements({ courseCode: args.course_code, since: args.since })));

  if (data.listFiles) {
    const listFiles = data.listFiles.bind(data);
    server.registerTool('list_files', {
      description: '列出某门课在 eLearning 上的文件（课件、讲义、参考资料），按更新时间排序，返回文件 id、名称、大小、所在文件夹。用户要课件、讲义、PPT 时先用它找到文件',
      inputSchema: {
        course_code: z.string().describe('课程代码或课程名，如 COMP130004.01 或「数据结构」'),
        query: z.string().optional().describe('文件名关键词，如「第5讲」「链表」'),
      },
      annotations: ro,
    }, async (args) => json(await listFiles(args.course_code, args.query)));
  }

  if (data.downloadFile) {
    const downloadFile = data.downloadFile.bind(data);
    server.registerTool('download_file', {
      description: '把 eLearning 上的一个文件下载到用户电脑的「下载/Fudaner/课程名」文件夹，并（默认）导入资源库，之后可以用 read_resource 读内容、总结、出题。只读取 eLearning，不会改动任何内容。一次一个文件，多个文件就多次调用',
      inputSchema: {
        file_id: z.string().describe('list_files 返回的文件 id'),
        course_code: z.string().optional().describe('文件所属课程，用来决定保存的文件夹'),
        add_to_library: z.boolean().optional().describe('是否导入资源库（默认是；PDF、Word、PPT、文本可以导入）'),
      },
    }, async (args) => json(await downloadFile(args.file_id, { courseCode: args.course_code, addToLibrary: args.add_to_library ?? true })));
  }

  return server;
}
