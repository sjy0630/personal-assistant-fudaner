import type { Repo } from '../db/repo';
import type { LlmClient } from './llm';

/** 工具可见性与执行前检查共用策略；隐藏工具也必须防止模型直接请求。 */
export function createToolPolicy(repo: Repo, llm: Pick<LlmClient, 'label'>): {
  mailInstructions(): string;
  filter(server: string, tool: string): boolean;
  authorize(name: string, args: Record<string, unknown>): string | undefined;
} {
  const mailBodyAllowed = () => llm.label.startsWith('local:') || repo.getSettings().allowSensitiveToCloud === true;
  const protectedTool = (server: string, tool: string) =>
    (server === 'fudan-mail' && tool === 'get_mail') || (server === 'fudaner-local' && ['search_all', 'get_grades', 'get_gpa'].includes(tool));
  return {
    mailInstructions: () => mailBodyAllowed()
      ? '邮件正文和成绩读取已获允许（成绩用 get_grades、绩点和排名用 get_gpa）。search_mail 和 list_action_required 只返回列表摘要；用户询问邮件具体内容、细节或原文时，先搜索定位邮件，再用返回的真实 id 调用 get_mail 读取 body。不能把搜索列表缺少正文说成邮箱接口不支持正文。'
      : '当前邮件隐私设置：本轮使用云端模型，用户尚未允许向云端发送邮件正文，因此 get_mail 和全文搜索工具被隐私策略隐藏。搜索列表仅提供摘要。需要正文时，应解释是应用的隐私设置限制，指导用户到「设置 → 模型 → 隐私任务的云端授权」勾选授权并保存，或使用本地模型对话。不要声称邮箱接口不支持正文，也不要声称授权已开启。配置了本地模型但对话仍使用云端时，云端正文读取仍需要授权。成绩和绩点（get_grades、get_gpa）同样属于敏感内容，受同一个授权控制：用户问成绩时，说明需要在「设置 → 模型」勾选允许把敏感内容发给云端模型，或使用本地模型；不要说读不到教务系统。',
    filter: (server, tool) => !protectedTool(server, tool) || mailBodyAllowed(),
    authorize: (name, args) => {
      // 与 McpHub.call 的拆分语义保持一致，不能通过追加 __ 后缀绕过检查。
      const [qualifiedServer, tool] = name.split('__');
      const server = qualifiedServer.replace(/_/g, '-');
      if (protectedTool(server, tool) && !mailBodyAllowed()) {
        return '此工具可能读取邮件正文或全文片段；当前未允许向云端发送敏感内容。请使用邮件摘要查询工具。';
      }
      // app-context 的 getAssignment 未区分事项类型；在进入共享数据实现之前阻止邮件 ID 别名。
      if (server === 'fudan-elearning' && tool === 'get_assignment' &&
        (typeof args.id !== 'string' || repo.getItem(args.id)?.kind !== 'assignment')) {
        return '只能读取有效的作业事项，不能把其他类型的事项当成作业读取。';
      }
      return undefined;
    },
  };
}
