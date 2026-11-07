import { describe, expect, it } from 'vitest';
import type { Item } from '../src/shared/types';
import type { LlmClient, LlmMessage } from '../src/main/ai/llm';
import { classifyMails, ruleClassify } from '../src/main/ai/mail';
import { extractDeadline } from '../src/main/ai/deadline';
import { assessmentOutput, memoryOutput } from '../src/main/ai/validation';

const NOW = new Date('2026-11-06T10:00:00+08:00');
const mail = (body: string, patch: Partial<Item> = {}): Item => ({ id: 'm1', source: 'demo', sourceId: 'm1', kind: 'email', title: '通知', body, publishedAt: '2026-11-06T09:00:00+08:00', done: false, ...patch });
const record = (id = 'm1', extra = {}) => ({ id, category: 'course', summary: '助教补充实验报告要求', deadline: null, ...extra });
const fake = (chat: LlmClient['chat']): LlmClient => ({ label: 'local:fixture', chat });
const response = (content: unknown) => ({ content: JSON.stringify(content), toolCalls: [] });

describe('截止时间必须有原文证据', () => {
  it.each([
    ['请于 11 月 10 日前确认考试安排。', '2026-11-10T23:59:00+08:00'],
    ['截止时间为 2026 年 11 月 15 日 23:59。', '2026-11-15T23:59:00+08:00'],
    ['于 2026-11-09 18:00 前上传。', '2026-11-09T18:00:00+08:00'],
    ['Please upload Essay Draft 2 by November 10, 2026, 23:59 China Standard Time.', '2026-11-10T23:59:00+08:00'],
    ['Deadline: 2026-11-09T10:00:00Z', '2026-11-09T10:00:00.000Z'],
    ['明天下午3点前提交报告。', '2026-11-07T15:00:00+08:00'],
    ['请于下周一18:00前上传。', '2026-11-09T18:00:00+08:00'],
  ])('抽取明确的截止：%s', (body, expected) => expect(extractDeadline(mail(body), NOW)).toBe(expected));
  it.each(['本周五14:00举行讲座。', '请于11月8日14:00参加讲座。', '截至11月6日，已有200人报名。', '截止时间不变。', '生日是2026年11月15日。', '截止2026年2月30日。', '今晚能确认一下吗？'])('不虚构截止：%s', body => expect(extractDeadline(mail(body), NOW)).toBeUndefined());
  it('月日以邮件发送年份为准，不借用模型或活动名称的年份', () => {
    expect(extractDeadline(mail('报名截止11月15日。', { title: '2027春季交换项目' }), NOW)).toBe('2026-11-15T23:59:00+08:00');
  });
});

describe('模型邮件输出校验及可观察回退', () => {
  it('用原文纠正模型虚构的2022年，并传入参考时间与发送时间', async () => {
    let messages: LlmMessage[] = [];
    const result = await classifyMails([mail('报名截止11月15日。')], fake(async m => { messages=m; return response([record('m1',{deadline:'2022-11-15T00:00:00Z'})]); }), {now:NOW});
    expect(result.results.get('m1')?.deadline).toBe('2026-11-15T23:59:00+08:00');
    expect(messages[0].content).toContain('sentAt: 2026-11-06'); expect(messages[0].content).toContain(NOW.toISOString());
  });
  it('模型把活动时间误当截止时清空', async () => {
    const r=await classifyMails([mail('本周五14:00讲座。')],fake(async()=>response([record('m1',{deadline:'2026-11-06T14:00:00+08:00'})])),{now:NOW});
    expect(r.results.get('m1')?.deadline).toBeUndefined();
  });
  it('JSON失败重试一次，仍失败时明确标记rules且不泄漏异常原文',async()=>{
    let calls=0;const r=await classifyMails([mail('请回复。')],fake(async()=>{calls++;throw Error('provider-private-detail');}),{now:NOW});
    expect(calls).toBe(2);expect(r.model).toBe('rules');expect(r.diagnostics.fallbackItems).toBe(1);
    expect(JSON.stringify(r.diagnostics)).not.toContain('provider-private-detail');
  });
  it('坏JSON可以在第二次恢复',async()=>{
    let calls=0;const r=await classifyMails([mail('实验报告')],fake(async()=>++calls===1?{content:'not json',toolCalls:[]}:response([record()])),{now:NOW});
    expect(calls).toBe(2);expect(r.model).toBe('local:fixture');expect(r.diagnostics.retriedBatches).toBe(1);
  });
  it('未知分类、重复和外来ID不能污染其他邮件，漏项逐封回退',async()=>{
    const r=await classifyMails([mail('实验报告'),mail('请回复',{id:'m2'})],fake(async()=>response([record(),record(),record('foreign'),record('m2',{category:'invalid'})])),{now:NOW});
    expect(r.model).toBe('mixed:local:fixture');expect(r.results.size).toBe(2);expect(r.results.get('m2')?.source).toBe('rules');expect(r.diagnostics.invalidItems).toBe(3);
  });
  it('后一批失败不丢掉前一批成功的结果',async()=>{
    const mails=Array.from({length:9},(_,i)=>mail('实验报告',{id:`m${i}`}));let calls=0;
    const r=await classifyMails(mails,fake(async()=>{if(calls++>0)throw Error('failure');return response(mails.slice(0,8).map(m=>record(m.id)));}),{now:NOW});
    expect(r.diagnostics.fallbackItems).toBe(1);expect(r.results.get('m0')?.source).toBe('model');expect(r.results.get('m8')?.source).toBe('rules');
  });
  it('模型不能猜出原文没有的课程名',async()=>{
    const r=await classifyMails([mail('实验报告')],fake(async()=>response([record('m1',{course_hint:'并未出现的课程'})])),{now:NOW});
    expect(r.results.get('m1')?.courseHint).toBeUndefined();
  });
  it('否定回复不误分，英文课程作业可识别',()=>{
    expect(ruleClassify(mail('数分作业请上传，没有要求回复邮件。')).category).toBe('course');
    expect(ruleClassify(mail('Please upload Essay Draft 2.')).category).toBe('course');
  });
});

describe('敏感输出的运行时校验',()=>{
  it('研判拒绝非法动作、非有限分值以及没有具体工单的suggest_ticket',()=>{
    const base={value:0.5,urgency:0.5,action:'record',message_draft:'',reason:'普通通知'};
    expect(assessmentOutput.safeParse({...base,action:'send_email'}).success).toBe(false);
    expect(assessmentOutput.safeParse({...base,value:Infinity}).success).toBe(false);
    expect(assessmentOutput.safeParse({...base,action:'suggest_ticket',ticket:null}).success).toBe(false);
  });
  it('记忆拒绝不支持的操作、敏感内容、无限过期时间和过量记录',()=>{
    const m={op:'add',type:'preference',content:'周二晚上有社团',expires_days:null};
    expect(memoryOutput.safeParse({memories:[m]}).success).toBe(true);
    expect((memoryOutput.parse({memories:[{...m,expires_days:7}]}).memories[0] as { expires_days?: number | null }).expires_days).toBeNull();
    expect(memoryOutput.safeParse({memories:[{...m,op:'delete'}]}).success).toBe(false);
    expect(memoryOutput.safeParse({memories:[{...m,content:'保存password内容'}]}).success).toBe(false);
    expect(memoryOutput.safeParse({memories:[{...m,expires_days:Infinity}]}).success).toBe(false);
    expect(memoryOutput.safeParse({memories:[m,m,m,m]}).success).toBe(false);
  });
});
