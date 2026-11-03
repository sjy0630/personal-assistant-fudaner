import type { Item, MailCategory } from '../../shared/types';
import { mailClassifyPrompt } from './prompts';
import { parseJsonLoose, type LlmClient } from './llm';

export interface MailAi { category: MailCategory; summary: string; action?: string; deadline?: string; courseHint?: string }

/**
 * 邮件分类与摘要（PRD §5.2）。默认由本地模型完成，正文不出本机；
 * 没有可用模型时用关键词规则兜底。
 */
export async function classifyMails(mails: Item[], llm: LlmClient | null): Promise<{ results: Map<string, MailAi>; model: string }> {
  const results = new Map<string, MailAi>();
  if (llm && mails.length) {
    try {
      // 分批，每批 8 封，每封截取正文前 500 字
      for (let i = 0; i < mails.length; i += 8) {
        const chunk = mails.slice(i, i + 8);
        const text = chunk.map((m) => `id: ${m.id}\nfrom: ${m.sender}\nsubject: ${m.title}\nbody: ${m.body.slice(0, 500)}`).join('\n---\n');
        const r = await llm.chat([{ role: 'user', content: mailClassifyPrompt(text) }], { temperature: 0, maxTokens: 1200 });
        const arr = parseJsonLoose<{ id: string; category: MailCategory; summary: string; action?: string | null; deadline?: string | null; course_hint?: string | null }[]>(r.content);
        for (const x of Array.isArray(arr) ? arr : []) {
          if (!x?.id) continue;
          results.set(x.id, { category: x.category, summary: x.summary, action: x.action ?? undefined, deadline: x.deadline ?? undefined, courseHint: x.course_hint ?? undefined });
        }
      }
      for (const m of mails) if (!results.has(m.id)) results.set(m.id, ruleClassify(m));
      return { results, model: llm.label };
    } catch {
      results.clear();
    }
  }
  for (const m of mails) results.set(m.id, ruleClassify(m));
  return { results, model: 'rules' };
}

export function ruleClassify(m: Item): MailAi {
  const text = `${m.title} ${m.body.slice(0, 300)}`;
  const has = (...ws: string[]) => ws.some((w) => text.toLowerCase().includes(w.toLowerCase()));
  let category: MailCategory = 'other';
  if (has('请回复', '回复', '是否方便', '能否', '确认一下', '有空吗')) category = 'reply';
  else if (has('讲座', '报名', '交换', '奖学金', '竞赛', '招募', '项目申请', '宣讲')) category = 'notice';
  else if (has('作业', 'lab', '实验', '习题', '助教')) category = 'course';
  else if (has('请于', '截止', '填写', '提交材料', '确认', '期中', '期末')) category = 'action';
  const firstLine = m.body.split('\n').map((s) => s.trim()).find((s) => s.length > 6) ?? m.title;
  return { category, summary: firstLine.slice(0, 40) };
}
