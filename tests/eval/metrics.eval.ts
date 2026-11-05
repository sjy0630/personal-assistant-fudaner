import { describe, expect, it } from 'vitest';
import { score, shanghaiMinute, validateSamples, type MailSample, type Prediction } from './metrics';

describe('评测口径', () => {
  it('按上海时区比较到分钟，空值相等，无时区按上海时间，非法时间不算空值', () => {
    expect(shanghaiMinute('2026-11-06T02:10:59Z')).toBe(shanghaiMinute('2026-11-06T10:10:00+08:00'));
    expect(shanghaiMinute('2026-11-06T10:10')).toBe('2026-11-06T10:10+08:00');
    expect(shanghaiMinute(null)).toBeNull();
    expect(shanghaiMinute('not a date')).toBe('INVALID_TIMESTAMP');
    expect(shanghaiMinute('2026-02-30T10:00:00+08:00')).toBe('INVALID_TIMESTAMP');
  });
  it('分开报告关联正负例，防止全猜空值获得虚高准确率', () => {
    const base = { fromName: '虚构', from: 'demo@example.com', subject: '测试', body: '虚构内容', sentAt: '2026-11-06T10:00:00+08:00' };
    const samples: MailSample[] = [
      { ...base, id: '1', label: { category: 'course', deadline: null, course: '数据结构', assignment: 'Lab 5：链表与栈' } },
      { ...base, id: '2', label: { category: 'other', deadline: null, course: null, assignment: null } },
    ];
    const predictions: Prediction[] = samples.map((s) => ({ ...s.label, id: s.id, course: null, assignment: null, source: 'rules' }));
    const result = score(samples, predictions);
    expect(result.association.accuracy).toBe(0.5);
    expect(result.association.positive.accuracy).toBe(0);
    expect(result.association.negative.accuracy).toBe(1);
    expect(result.association.precision.accuracy).toBeNull();
    expect(result.deadline.accuracy).toBe(1);
    expect(result.errors.map((r) => r.id)).toEqual(['1']);
  });
  it('拒绝重复编号及不完整标注', () => {
    const sample = { id: '1', fromName: '虚构', from: 'demo@example.com', subject: '测试', body: '虚构内容', sentAt: '2026-11-06T10:00:00+08:00', label: { category: 'other', deadline: null, course: null, assignment: null } };
    expect(() => validateSamples([sample, sample])).toThrow('重复');
    expect(() => validateSamples([{ ...sample, label: { category: 'other' } }])).toThrow('无效');
    expect(() => score([sample as MailSample], [])).toThrow('遗漏');
  });
});
