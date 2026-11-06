import { z } from 'zod';
import type { Item, MailCategory } from '../../shared/types';
import { mailClassifyPrompt } from './prompts';
import { parseJsonLoose, type LlmClient } from './llm';
import { extractDeadline } from './deadline';

export interface MailAi {
  category: MailCategory; summary: string; action?: string; deadline?: string; courseHint?: string;
  source: 'model' | 'rules';
}
export interface MailDiagnostics {
  batches: number; modelBatches: number; failedBatches: number; invalidItems: number;
  fallbackItems: number; retriedBatches: number; errors: string[];
}
const output = z.object({
  id: z.string().min(1), category: z.enum(['reply', 'action', 'course', 'notice', 'other']),
  summary: z.string().trim().min(1).max(500), action: z.string().max(1000).nullable().optional(),
  deadline: z.string().max(100).nullable().optional(), course_hint: z.string().max(100).nullable().optional(),
});
const short = (s: string, n: number) => [...s].slice(0, n).join('');

/** Classify in batches, validate every record, and report rule fallbacks honestly. */
export async function classifyMails(mails: Item[], llm: LlmClient | null, opts: { now?: Date } = {}): Promise<{
  results: Map<string, MailAi>; model: string; diagnostics: MailDiagnostics;
}> {
  const results = new Map<string, MailAi>();
  const diagnostics: MailDiagnostics = { batches: 0, modelBatches: 0, failedBatches: 0, invalidItems: 0, fallbackItems: 0, retriedBatches: 0, errors: [] };
  const now = opts.now ?? new Date();
  for (let i = 0; i < mails.length && llm; i += 8) {
    const chunk = mails.slice(i, i + 8);
    diagnostics.batches++;
    const text = chunk.map((m) => `id: ${m.id}\nsentAt: ${m.publishedAt}\nfrom: ${m.sender ?? ''}\nsubject: ${m.title}\nbody: ${m.body.slice(0, 500)}`).join('\n---\n');
    let accepted = false;
    for (let attempt = 0; attempt < 2 && !accepted; attempt++) {
      if (attempt) diagnostics.retriedBatches++;
      try {
        const r = await llm.chat([{ role: 'user', content: mailClassifyPrompt(text, now.toISOString()) }], { temperature: 0, maxTokens: 2400 });
        if (r.toolCalls.length) { diagnostics.errors.push('unexpected_tool_calls'); continue; }
        const arr = parseJsonLoose<unknown>(r.content);
        if (!Array.isArray(arr)) { diagnostics.errors.push('invalid_response'); continue; }
        const allowed = new Map(chunk.map((m) => [m.id, m]));
        const seen = new Set<string>();
        const parsed: [string, MailAi][] = [];
        for (const raw of arr) {
          const p = output.safeParse(raw);
          if (!p.success || !allowed.has(p.data.id) || seen.has(p.data.id)) { diagnostics.invalidItems++; continue; }
          const x = p.data;
          const mail = allowed.get(x.id)!;
          seen.add(x.id);
          const courseHint = x.course_hint && `${mail.title}\n${mail.body}`.includes(x.course_hint) ? x.course_hint : undefined;
          parsed.push([x.id, {
            category: x.category, summary: short(x.summary, 40), action: x.action || undefined,
            // Dates are grounded in the original mail, not model-generated years or event times.
            deadline: extractDeadline(mail, now), courseHint, source: 'model',
          }]);
        }
        if (!parsed.length) { diagnostics.errors.push('invalid_records'); continue; }
        for (const [id, value] of parsed) results.set(id, value);
        diagnostics.modelBatches++; accepted = true;
      } catch { diagnostics.errors.push('request_failed'); }
    }
    if (!accepted) diagnostics.failedBatches++;
  }
  for (const mail of mails) if (!results.has(mail.id)) {
    results.set(mail.id, ruleClassify(mail, now)); diagnostics.fallbackItems++;
  }
  if (llm && diagnostics.fallbackItems && !diagnostics.failedBatches) diagnostics.errors.push('missing_or_invalid_items');
  const modelCount = mails.length - diagnostics.fallbackItems;
  const model = !llm || !modelCount ? 'rules' : diagnostics.fallbackItems ? `mixed:${llm.label}` : llm.label;
  return { results, model, diagnostics };
}

export function ruleClassify(m: Item, now = new Date()): MailAi {
  const text = `${m.title} ${m.body.slice(0, 1000)}`;
  const has = (...ws: string[]) => ws.some((w) => text.toLowerCase().includes(w.toLowerCase()));
  const replyText = text.replace(/(?:无需|不用|不必|不需要|没有要求|不要求)\s*(?:回信|回复)/g, '');
  let category: MailCategory = 'other';
  if (/请回复|回复|是否方便|能否|确认一下|有空吗|please\s+(?:reply|respond)|rsvp/i.test(replyText)) category = 'reply';
  else if (has('讲座', '报名', '交换', '奖学金', '竞赛', '招募', '项目申请', '宣讲', '培训', '例会', 'lecture', 'scholarship')) category = 'notice';
  else if (has('作业', 'lab', '实验', '习题', '助教', 'homework', 'assignment', 'essay draft', 'reading response')) category = 'course';
  else if (has('请于', '截止', '填写', '提交材料', '确认', '期中', '期末', '打卡', 'please complete', 'please submit')) category = 'action';
  const firstLine = m.body.split('\n').map((s) => s.trim()).find((s) => s.length > 6) ?? m.title;
  return { category, summary: short(firstLine, 40), deadline: extractDeadline(m, now), source: 'rules' };
}
