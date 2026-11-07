import type { Assessment, Decision, Memory, SemesterPhase, Trigger } from '../../shared/types';
import { assessPrompt } from '../ai/prompts';
import { parseJsonLoose, type LlmClient } from '../ai/llm';
import { assessmentOutput } from '../ai/validation';

/**
 * 研判（PRD §5.7 第 2 步，参考 dsh-superagent 的 Assessment）。
 * 有本地模型时让模型判断；没有时用下面的规则表兜底，保证演示和测试不依赖模型。
 */
export async function assess(
  batch: Trigger[],
  ctx: { llm: LlmClient | null; memories: Memory[]; phase: SemesterPhase; now: Date; describe: (t: Trigger) => string },
): Promise<{ assessment: Assessment; model: string }> {
  if (ctx.llm) {
    try {
      const prompt = assessPrompt({
        events: batch.map(ctx.describe).join('\n'),
        memories: ctx.memories.map((m) => `- [${m.type}] ${m.content}`).join('\n'),
        phase: ctx.phase,
        nowIso: ctx.now.toISOString(),
      });
      const r = await ctx.llm.chat([{ role: 'user', content: prompt }], { json: true, temperature: 0.1, maxTokens: 400 });
      const parsed = assessmentOutput.safeParse(parseJsonLoose<unknown>(r.content));
      if (parsed.success && !r.toolCalls.length) {
        const j = parsed.data;
        return {
          assessment: {
            value: clamp(j.value), urgency: clamp(j.urgency ?? 0), action: j.action, messageDraft: j.message_draft ?? '',
            reason: j.reason ?? '', ticket: j.ticket ?? undefined, verify: heuristic(batch, ctx).verify,
          },
          model: ctx.llm.label,
        };
      }
    } catch {
      // 模型失败时退回规则
    }
  }
  return { assessment: heuristic(batch, ctx), model: 'rules' };
}

const clamp = (n: number) => Math.max(0, Math.min(1, Number(n) || 0));

/** 规则兜底：按事件类型给出基础价值和处理方式；多事件取最高值 */
export function heuristic(batch: Trigger[], ctx: { memories: Memory[]; phase: SemesterPhase; now?: Date; describe: (t: Trigger) => string }): Assessment {
  const scored = batch.map((t) => ({ t, ...BASE[t.kind](t, ctx) }));
  scored.sort((a, b) => b.value - a.value);
  const top = scored[0];
  const draft = top.draft;
  return {
    value: top.value, urgency: top.urgency, action: top.action, messageDraft: draft, reason: top.reason,
    verify: top.t.payload.itemId && top.t.kind.startsWith('deadline_') ? { type: 'assignment_submitted', itemId: String(top.t.payload.itemId) } : undefined,
    ticket: top.ticket,
  };
}

type Rule = (t: Trigger, ctx: { memories: Memory[]; phase: SemesterPhase; now?: Date }) => {
  value: number; urgency: number; action: Decision; draft: string; reason: string; ticket?: { title: string; request: string };
};

const p = (t: Trigger, k: string) => String(t.payload[k] ?? '');

const BASE: Record<Trigger['kind'], Rule> = {
  assignment_new: (t) => ({ value: 0.55, urgency: 0.4, action: 'card', draft: `${p(t, 'course')} 发布了新作业「${p(t, 'title')}」，${p(t, 'dueText')}截止。`, reason: '新作业，已加入课程目标' }),
  assignment_changed: (t) => ({ value: 0.7, urgency: 0.6, action: 'chat', draft: `注意：「${p(t, 'title')}」的截止时间改成了 ${p(t, 'dueText')}。`, reason: '截止时间变更' }),
  // 之前提醒过（或约好跟进）的作业交了：马上在对话里确认一句，形成闭环；没提醒过的就攒到早安里
  // doneBy：submitted = 本人有提交记录；marked = 在 eLearning 上标记完成（组作业由组长提交等）或教师免交
  assignment_submitted: (t) => {
    const how = t.payload.doneBy === 'marked' ? '在 eLearning 上标记为完成了' : '已经交了';
    return t.payload.wasReminded
      ? { value: 0.5, urgency: 0.2, action: 'chat', draft: `看到「${p(t, 'title')}」${how} 👍 相关提醒都取消了。`, reason: '之前提醒过的作业已完成，闭环确认' }
      : { value: 0.3, urgency: 0.1, action: 'digest', draft: `看到「${p(t, 'title')}」${how} 👍`, reason: '已完成，提醒自动结束' };
  },
  announcement_new: (t) => ({ value: 0.45, urgency: 0.3, action: 'card', draft: `${p(t, 'course')} 有新公告：「${p(t, 'title')}」。`, reason: '你选的课发了公告' }),
  mail_new: (t, ctx) => {
    const cat = p(t, 'category');
    if (cat === 'reply') return { value: 0.65, urgency: 0.5, action: 'chat', draft: `${p(t, 'from')} 来信「${p(t, 'subject')}」，需要你回复。`, reason: '需要回复的邮件' };
    if (t.payload.linkedTitle) return { value: 0.7, urgency: 0.55, action: 'chat', draft: `关于「${p(t, 'linkedTitle')}」：${p(t, 'summary') || p(t, 'subject')}`, reason: `${p(t, 'course') ? `「${p(t, 'course')}」` : ''}课程邮件，涉及你还没交的作业` };
    if (cat === 'course' || cat === 'action') return { value: 0.5, urgency: 0.4, action: 'card', draft: `${p(t, 'subject')}：${p(t, 'summary')}`, reason: cat === 'course' ? '课程相关邮件' : '需要处理的邮件' };
    if (cat === 'notice') {
      const text = `${p(t, 'subject')} ${p(t, 'summary')}`;
      const hit = (type: string) => ctx.memories.find((m) => m.type === type && keywords(m.content).some((k) => text.includes(k)));
      // 匹配长期目标：助理可以主动帮忙 → 建议工单
      const goal = hit('goal');
      if (goal) {
        return {
          value: 0.6, urgency: 0.4, action: 'suggest_ticket', draft: `看到「${p(t, 'subject')}」，和你「${goal.content}」有关。要我帮你整理一下申请要求和材料清单吗？`,
          reason: `匹配你的目标：${goal.content}`, ticket: { title: `整理：${p(t, 'subject')}`, request: `根据邮件「${p(t, 'subject')}」整理申请要求、截止时间和材料清单` },
        };
      }
      // 匹配兴趣：值得知道 → 动态卡片
      const interest = hit('interest');
      if (interest) return { value: 0.45, urgency: 0.2, action: 'card', draft: `${p(t, 'subject')}：${p(t, 'summary')}`, reason: `匹配你的兴趣：${interest.content}` };
      return { value: 0.15, urgency: 0.1, action: 'record', draft: '', reason: '校园通知，与你的目标和兴趣无关' };
    }
    return { value: 0.05, urgency: 0, action: 'record', draft: '', reason: '一般邮件' };
  },
  deadline_72h: (t, ctx) => ({ value: 0.45, urgency: 0.4, action: 'card', draft: `「${p(t, 'title')}」${hoursLeft(t, ctx.now)}截止。`, reason: '距截止不到 72 小时' }),
  deadline_24h: (t, ctx) => ({ value: 0.75, urgency: 0.75, action: 'chat', draft: `「${p(t, 'title')}」${hoursLeft(t, ctx.now)}截止，还没交。`, reason: '距截止不到 24 小时且未提交' }),
  deadline_3h: (t) => ({ value: 0.95, urgency: 0.95, action: 'chat_notify', draft: `⏰「${p(t, 'title')}」3 小时后截止，还没交！`, reason: '距截止 3 小时且未提交' }),
  morning: () => ({ value: 1, urgency: 0.6, action: 'chat_notify', draft: '', reason: '每日早安' }),
  weekly_plan: () => ({ value: 0.8, urgency: 0.4, action: 'chat', draft: '新的一周开始了，要我帮你排一下本周安排吗？', reason: '每周一的本周安排' }),
  followup_due: (t) => ({ value: 0.7, urgency: 0.5, action: 'chat', draft: `${p(t, 'topic')}，进展怎么样？`, reason: '你之前约定的跟进' }),
  phase_change: (t, ctx) => ({
    value: ctx.phase === 'pre_exam' ? 0.85 : 0.5, urgency: 0.5, action: ctx.phase === 'pre_exam' ? 'suggest_ticket' : 'card',
    draft: ctx.phase === 'pre_exam' ? '考试周快到了。要我按各门课的考试时间帮你排一份复习计划吗？' : `进入${p(t, 'label')}。`,
    reason: `学期阶段：${p(t, 'label')}`,
    ticket: ctx.phase === 'pre_exam' ? { title: '考试周复习计划', request: '根据各门课的考试安排和作业情况，制定考试周前两周的复习计划' } : undefined,
  }),
  user_commitment: (t) => ({ value: 0.4, urgency: 0.2, action: 'record', draft: '', reason: `用户计划：${p(t, 'text')}` }),
  auth_expired: () => ({ value: 0.8, urgency: 0.6, action: 'chat_notify', draft: '复旦账号的登录过期了，eLearning 暂时同步不了。点下面的按钮重新登录一下就好。', reason: 'UIS 登录过期，无法同步' }),
};

/** 「还剩约 9 小时」/「还剩约 2 天」 */
function hoursLeft(t: Trigger, now = new Date()): string {
  const due = Date.parse(String(t.payload.dueAt ?? ''));
  if (!due) return '即将';
  const h = Math.max(1, Math.round((due - now.getTime()) / 3_600_000));
  return h < 36 ? `还剩约 ${h} 小时` : `还剩约 ${Math.round(h / 24)} 天`;
}

function keywords(s: string): string[] {
  return s.replace(/[想要在准备申请参加对感兴趣的方向。，,]/g, ' ').split(/\s+/).filter((w) => w.length >= 2);
}
