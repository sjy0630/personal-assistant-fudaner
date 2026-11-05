import type { Repo } from '../db/repo';
import type { LlmClient } from './llm';

/** 工具可见性与执行前检查共用策略；隐藏工具也必须防止模型直接请求。 */
export function createToolPolicy(repo: Repo, llm: Pick<LlmClient, 'label'>): {
  filter(server: string, tool: string): boolean;
  authorize(name: string, args: Record<string, unknown>): string | undefined;
} {
  const mailBodyAllowed = () => llm.label.startsWith('local:') || repo.getSettings().allowSensitiveToCloud === true;
  const protectedTool = (server: string, tool: string) =>
    (server === 'fudan-mail' && tool === 'get_mail') || (server === 'fudaner-local' && tool === 'search_all');
  return {
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
