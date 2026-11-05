import { z } from 'zod';

export const assessmentOutput = z.object({
  value: z.number().finite().min(0).max(1), urgency: z.number().finite().min(0).max(1),
  action: z.enum(['chat_notify', 'chat', 'card', 'digest', 'suggest_ticket', 'record']),
  message_draft: z.string().max(2000), reason: z.string().max(500).transform((s) => [...s].slice(0, 20).join('')),
  ticket: z.object({ title: z.string().min(1).max(200), request: z.string().min(1).max(2000) }).nullable().optional(),
}).refine((v) => v.action !== 'suggest_ticket' || !!v.ticket);

export const memoryOutput = z.object({ memories: z.array(z.object({
  op: z.literal('add'), type: z.enum(['preference', 'schedule', 'goal', 'person', 'status', 'interest']),
  content: z.string().trim().min(1).max(300).refine((s) => !/密码|口令|证件号|身份证|api[ _-]?key|access[ _-]?token|secret|password|\bsk-[a-z0-9]{8,}/i.test(s)),
  expires_days: z.number().int().positive().max(3650).nullable().optional(),
}).transform((m) => ({ ...m, expires_days: m.type === 'status' ? m.expires_days : null }))).max(3) });
