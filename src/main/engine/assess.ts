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
    // 需要回复的邮件：在对话里说，同时弹系统通知（静默时段并入早安消息）
    if (cat === 'reply') return { value: 0.7, urgency: 0.55, action: 'chat_notify', draft: `${p(t, 'from')} 来信「${p(t, 'subject')}」，需要你回复。`, reason: '需要回复的邮件' };
    if (t.payload.linkedTitle) return { value: 0.7, urgency: 0.55, action: 'chat', draft: `关于「${p(t, 'linkedTitle')}」：${p(t, 'summary') || p(t, 'subject')}`, reason: `${p(t, 'course') ? `「${p(t, 'course')}」` : ''}课程邮件，涉及你还没交的作业` };
    if (cat === 'course' || cat === 'action') return { value: 0.5, urgency: 0.4, action: 'card', draft: `${p(t, 'subject')}：${p(t, 'summary')}`, reason: cat === 'course' ? '课程相关邮件' : '需要处理的邮件' };
    if (cat === 'notice') {
      const text = `${p(t, 'subject')} ${p(t, 'summary')}`;
      const hit = (type: string) => ctx.memories.find((m) => m.type === type && memoryMatches(m.content, text));
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
  // 校园活动：和长期目标有关、符合兴趣的推荐到动态；无关的只记录，用户问起时再查
  activity_new: (t, ctx) => {
    const text = ['title', 'category', 'summary', 'organizer', 'speaker', 'sourceName', 'excerpt'].map((k) => p(t, k)).join(' ');
    const when = [p(t, 'timeText'), p(t, 'location')].filter(Boolean).join(' · ');
    const draft = `${t.payload.changed ? '时间有更新：' : ''}${p(t, 'title')}${when ? `（${when}）` : ''}${t.payload.summary ? `。${p(t, 'summary')}` : ''}`;
    const hit = (type: string) => ctx.memories.find((m) => m.type === type && memoryMatches(m.content, text));
    const goal = hit('goal');
    if (goal) return { value: 0.6, urgency: 0.3, action: 'card', draft, reason: `和你的目标有关：${goal.content}` };
    const interest = hit('interest');
    if (interest) return { value: 0.5, urgency: 0.25, action: 'card', draft, reason: `匹配你的兴趣：${interest.content}` };
    return { value: 0.15, urgency: 0.1, action: 'record', draft, reason: '校园活动，与你的目标和兴趣关系不大' };
  },
  // 学校和院系官网通知：和目标、兴趣相关的推荐；本人院系、教务处里涉及选课考试报名截止的放进动态；其余只记录
  notice_new: (t, ctx) => {
    const text = ['title', 'excerpt', 'sourceName'].map((k) => p(t, k)).join(' ');
    const draft = `${p(t, 'sourceName')}：${p(t, 'title')}`;
    const hit = (type: string) => ctx.memories.find((m) => m.type === type && memoryMatches(m.content, text));
    const goal = hit('goal');
    if (goal) {
      return {
        value: 0.6, urgency: 0.4, action: 'suggest_ticket', draft: `看到${p(t, 'sourceName')}的通知「${p(t, 'title')}」，和你「${goal.content}」有关。要我帮你整理一下要求和截止时间吗？`,
        reason: `匹配你的目标：${goal.content}`, ticket: { title: `整理：${p(t, 'title')}`, request: `根据${p(t, 'sourceName')}的通知「${p(t, 'title')}」整理申请要求、截止时间和材料清单` },
      };
    }
    const interest = hit('interest');
    if (interest) return { value: 0.5, urgency: 0.25, action: 'card', draft, reason: `匹配你的兴趣：${interest.content}` };
    const important = /选课|退课|补选|考试|报名|截止|申请|奖学金|交换|推免|毕业|学籍|缴费|放假|调课|评教|注册/.test(p(t, 'title'));
    if (t.payload.own && important) return { value: 0.5, urgency: 0.35, action: 'card', draft, reason: '你所在院系的通知，涉及报名或截止' };
    if (t.payload.own) return { value: 0.35, urgency: 0.2, action: 'digest', draft, reason: '你所在院系的新通知' };
    if (t.payload.department && important) return { value: 0.45, urgency: 0.3, action: 'card', draft, reason: `${p(t, 'sourceName')}的通知，涉及报名或截止` };
    return { value: 0.15, urgency: 0.1, action: 'record', draft, reason: '学校通知，与你关系不大' };
  },
  exam_soon: (t) => {
    const where = [p(t, 'timeText'), p(t, 'location')].filter(Boolean).join('，');
    if (t.payload.stage === '1d') {
      return { value: 0.9, urgency: 0.9, action: 'chat_notify', draft: `明天有「${p(t, 'course')}」考试（${where}）。记得带学生证，早点休息。`, reason: '考试就在明天' };
    }
    return {
      value: 0.75, urgency: 0.5, action: 'suggest_ticket', draft: `「${p(t, 'course')}」考试还有 ${p(t, 'daysLeft')} 天（${where}）。要我按剩下的时间和你的课表排一份复习计划吗？`,
      reason: '一周内有考试', ticket: { title: `复习计划：${p(t, 'course')}`, request: `根据「${p(t, 'course')}」的考试时间（${where}）、我的课表和空闲时段，排一份到考试前的复习计划` },
    };
  },
  grade_new: (t) => ({ value: 0.65, urgency: 0.4, action: 'chat', draft: `「${p(t, 'course')}」出成绩了：${p(t, 'grade')}。`, reason: '新出的成绩' }),
  power_low: (t) => ({ value: 0.6, urgency: 0.5, action: 'chat', draft: `宿舍（${p(t, 'room')}）电量只剩 ${p(t, 'remaining')} 度了，记得充电费，别半夜断电。`, reason: '宿舍电量低于 10 度' }),
  card_low: (t) => ({ value: 0.5, urgency: 0.3, action: 'card', draft: `校园卡余额只剩 ¥${Number(t.payload.balance).toFixed(2)}，记得充值，别在食堂门口卡住。`, reason: '校园卡余额低于 30 元' }),
  auth_expired: () => ({ value: 0.8, urgency: 0.6, action: 'chat_notify', draft: '复旦账号的登录过期了，eLearning 暂时同步不了。点下面的按钮重新登录一下就好。', reason: 'UIS 登录过期，无法同步' }),
};

/** 「还剩约 9 小时」/「还剩约 2 天」 */
function hoursLeft(t: Trigger, now = new Date()): string {
  const due = Date.parse(String(t.payload.dueAt ?? ''));
  if (!due) return '即将';
  const h = Math.max(1, Math.round((due - now.getTime()) / 3_600_000));
  return h < 36 ? `还剩约 ${h} 小时` : `还剩约 ${Math.round(h / 24)} 天`;
}

/** 去掉「讲座」「活动」这类太宽泛的词（只剩宽泛词时保留），避免所有讲座都算匹配兴趣 */
const GENERIC = ['讲座', '活动', '比赛', '课程', '学习', '相关', '方面', '东西'];
function specificKeywords(s: string): string[] {
  // 年份、数字不算关键词（「2027 春季交换」不应匹配「2027 校园招聘」）
  const all = keywords(s).filter((k) => !/^\d+$/.test(k));
  const specific = all.filter((k) => !GENERIC.includes(k));
  return specific.length ? specific : all;
}

/**
 * 记忆（兴趣、目标）和一条通知 / 活动是否相关（没有模型时的规则判断）：
 * - 关键词原样出现即相关；英文按整词匹配；年份数字和「讲座」这类宽泛词不算；
 * - 较长的中文词拆成两字片段，命中两个以上也算（「春季交换」匹配「春季学期……交换项目」）。
 */
export function memoryMatches(memory: string, text: string): boolean {
  return specificKeywords(memory).some((k) => {
    if (mentions(text, k)) return true;
    if (!/^[\u4e00-\u9fff]{4,}$/.test(k)) return false;
    const pieces = new Set(Array.from({ length: k.length - 1 }, (_, i) => k.slice(i, i + 2)));
    return [...pieces].filter((piece) => text.includes(piece)).length >= 2;
  });
}

/** 英文关键词按整词匹配（「AI」不匹配「email」），中文按包含 */
function mentions(text: string, k: string): boolean {
  if (/^[a-z0-9+#.-]+$/i.test(k)) return new RegExp(`(^|[^a-z0-9])${k.replace(/[.+#-]/g, '\\$&')}([^a-z0-9]|$)`, 'i').test(text);
  return text.includes(k);
}

function keywords(s: string): string[] {
  return s.replace(/[想要在准备申请参加对感兴趣的方向。，,]/g, ' ').split(/\s+/).filter((w) => w.length >= 2);
}
