import { z } from 'zod';

export const assessmentOutput = z.object({
  value: z.number().finite().min(0).max(1), urgency: z.number().finite().min(0).max(1),
  action: z.enum(['chat_notify', 'chat', 'card', 'digest', 'suggest_ticket', 'record']),
  message_draft: z.string().max(2000), reason: z.string().max(500).transform((s) => [...s].slice(0, 20).join('')),
  ticket: z.object({ title: z.string().min(1).max(200), request: z.string().min(1).max(2000) }).nullable().optional(),
}).refine((v) => v.action !== 'suggest_ticket' || !!v.ticket);

const memoryContent = z.string().trim().min(1).max(300).refine((s) => !/密码|口令|证件号|身份证|api[ _-]?key|access[ _-]?token|secret|password|\bsk-[a-z0-9]{8,}/i.test(s));
const memoryType = z.enum(['preference', 'schedule', 'goal', 'person', 'status', 'interest']);
/**
 * 记忆提取的输出：add 新增；update 改写已有的第 target 条（用户改了主意、信息更新了）。
 * 不允许删除：一段被注入的文字不应该能清空用户的记忆，用户自己可以在「关于我」里删。
 */
export const memoryOutput = z.object({ memories: z.array(z.union([
  z.object({ op: z.literal('add'), type: memoryType, content: memoryContent, expires_days: z.number().int().positive().max(3650).nullable().optional() })
    .transform((m) => ({ ...m, expires_days: m.type === 'status' ? m.expires_days : null })),
  z.object({ op: z.literal('update'), target: z.number().int().positive(), content: memoryContent }),
])).max(3) });
