import type { MailCategory } from '../../src/shared/types';

export interface MailLabel {
  category: MailCategory;
  deadline: string | null;
  course: string | null;
  assignment: string | null;
}
export interface MailSample {
  id: string; fromName: string; from: string; subject: string; body: string; sentAt: string;
  label: MailLabel;
}
export interface Prediction extends MailLabel { id: string; source: string }
export interface Metric { correct: number; total: number; accuracy: number | null }
const categories: MailCategory[] = ['reply', 'action', 'course', 'notice', 'other'];
const invalid = 'INVALID_TIMESTAMP';

/** An ISO timestamp without an offset is interpreted in Shanghai, never the host timezone. */
export function shanghaiMinute(value: string | null | undefined): string | null {
  if (value == null) return null;
  const iso = value.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(?:Z|[+-](\d{2}):(\d{2}))?$/);
  if (!iso) return invalid;
  const [, year, month, day, hour, minute, second = '0', offsetHour = '0', offsetMinute = '0'] = iso;
  const days = new Date(Date.UTC(Number(year), Number(month), 0)).getUTCDate();
  if (Number(month) < 1 || Number(month) > 12 || Number(day) < 1 || Number(day) > days || Number(hour) > 23 || Number(minute) > 59 || Number(second) > 59 || Number(offsetHour) > 23 || Number(offsetMinute) > 59) return invalid;
  const explicit = /(?:Z|[+-]\d{2}:\d{2})$/.test(value) ? value : `${value}+08:00`;
  const date = new Date(explicit);
  if (!Number.isFinite(date.getTime())) return invalid;
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(date);
  const get = (type: string) => parts.find((p) => p.type === type)?.value;
  return `${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}+08:00`;
}

export function validateSamples(value: unknown): asserts value is MailSample[] {
  if (!Array.isArray(value) || !value.length) throw new Error('邮件样本必须是非空数组');
  const ids = new Set<string>();
  for (const row of value) {
    if (!row || typeof row !== 'object') throw new Error('邮件样本格式错误');
    for (const field of ['id', 'fromName', 'from', 'subject', 'body', 'sentAt'] as const) {
      if (typeof row[field] !== 'string' || !row[field].trim()) throw new Error(`样本缺少 ${field}`);
    }
    if (ids.has(row.id)) throw new Error(`样本编号重复：${row.id}`);
    ids.add(row.id);
    if (shanghaiMinute(row.sentAt) === invalid) throw new Error(`样本发送时间无效：${row.id}`);
    const label = row.label;
    if (!label || !categories.includes(label.category)) throw new Error(`样本分类无效：${row.id}`);
    for (const field of ['deadline', 'course', 'assignment'] as const) {
      if (label[field] !== null && (typeof label[field] !== 'string' || !label[field].trim())) throw new Error(`样本标注 ${field} 无效：${row.id}`);
    }
    if (shanghaiMinute(label.deadline) === invalid) throw new Error(`样本截止时间无效：${row.id}`);
    if (label.assignment && !label.course) throw new Error(`作业标注缺少课程：${row.id}`);
  }
}

function metric(correct: number, total: number): Metric { return { correct, total, accuracy: total ? correct / total : null }; }

export function score(samples: MailSample[], predictions: Prediction[]) {
  const byId = new Map(predictions.map((p) => [p.id, p]));
  const rows = samples.map((sample) => {
    const predicted = byId.get(sample.id);
    if (!predicted) throw new Error(`评测遗漏样本：${sample.id}`);
    const expected = { ...sample.label, deadline: shanghaiMinute(sample.label.deadline) };
    const actual = { ...predicted, deadline: shanghaiMinute(predicted.deadline) };
    const correct = {
      category: expected.category === actual.category,
      deadline: actual.deadline !== invalid && expected.deadline === actual.deadline,
      course: expected.course === actual.course,
      assignment: expected.assignment === actual.assignment,
      association: expected.course === actual.course && expected.assignment === actual.assignment,
    };
    return { id: sample.id, subject: sample.subject, expected, actual, correct };
  });
  const stat = (key: keyof typeof rows[number]['correct'], selected = rows) => metric(selected.filter((r) => r.correct[key]).length, selected.length);
  const deadlinePositive = rows.filter((r) => r.expected.deadline !== null);
  const deadlineNegative = rows.filter((r) => r.expected.deadline === null);
  const assignmentPositive = rows.filter((r) => r.expected.assignment !== null);
  const assignmentNegative = rows.filter((r) => r.expected.assignment === null);
  const predictedAssignments = rows.filter((r) => r.actual.assignment !== null);
  return {
    category: stat('category'), deadline: stat('deadline'), course: stat('course'), assignment: stat('assignment'),
    association: {
      ...stat('association'), method: 'linkMail rules; model rows may supply courseHint, not a model assignment linker',
      positive: stat('association', assignmentPositive), negative: stat('association', assignmentNegative),
      precision: metric(predictedAssignments.filter((r) => r.correct.association).length, predictedAssignments.length),
    },
    deadlinePositive: stat('deadline', deadlinePositive), deadlineNegative: stat('deadline', deadlineNegative),
    categoryByLabel: Object.fromEntries(categories.map((category) => [category, stat('category', rows.filter((r) => r.expected.category === category))])),
    sourceCounts: Object.fromEntries([...new Set(predictions.map((p) => p.source))].map((source) => [source, predictions.filter((p) => p.source === source).length])),
    errors: rows.filter((row) => Object.values(row.correct).some((correct) => !correct)),
  };
}
