// 把无标签邮件与人工导出的 human-labels.json 合并为评测数据集 tests/fixtures/mails.human.json。
// 用法：node tests/eval/merge-human-labels.mjs <mails-unlabeled.json> <human-labels.json>
import { readFileSync, writeFileSync } from 'node:fs';

const [mailsPath, labelsPath, previousPath] = process.argv.slice(2);
if (!mailsPath || !labelsPath) throw new Error('用法：node tests/eval/merge-human-labels.mjs <mails-unlabeled.json> <human-labels.json>');
const mails = JSON.parse(readFileSync(mailsPath, 'utf8'));
const exported = JSON.parse(readFileSync(labelsPath, 'utf8'));
const labels = new Map(exported.labels.map((entry) => [entry.id, entry]));
const COURSES = {
  '数据结构': ['Lab 4：顺序表', 'Lab 5：链表与栈', 'Lab 6：二叉树'],
  '数学分析 III': ['数分作业 5', '数分作业 6'],
  '大学物理 B': ['大学物理 习题 8', '大学物理 习题 9'],
  '线性代数': ['线代 HW 6', '线代 HW 7'],
  '学术英语写作': ['Essay Draft 2', 'Reading Response 4'],
  '中国近现代史纲要': ['读书报告'],
};
const categories = ['reply', 'action', 'course', 'notice', 'other'];
if (labels.size !== mails.length) throw new Error(`标注数量 ${labels.size} 与邮件数量 ${mails.length} 不一致`);
const notes = [];
const samples = mails.map((mail) => {
  const entry = labels.get(mail.id);
  if (!entry) throw new Error(`缺少标注：${mail.id}`);
  const { category, deadline, course, assignment } = entry.label;
  if (!categories.includes(category)) throw new Error(`分类无效：${mail.id}`);
  if (deadline !== null && !Number.isFinite(Date.parse(deadline))) throw new Error(`截止时间无效：${mail.id}`);
  if (course !== null && !COURSES[course]) throw new Error(`课程无效：${mail.id}`);
  if (assignment !== null && (!course || !COURSES[course].includes(assignment))) throw new Error(`作业与课程不匹配：${mail.id}`);
  if (entry.note?.trim()) notes.push(`${mail.id}：${entry.note.trim()}`);
  return { ...mail, label: { category, deadline, course, assignment } };
});
writeFileSync(new URL('../fixtures/mails.human.json', import.meta.url), `${JSON.stringify(samples, null, 2)}\n`);
// 可选第三个参数：上一轮导出。记录复核改动，便于在材料中如实说明。
const revised = [];
if (previousPath) {
  const previous = new Map(JSON.parse(readFileSync(previousPath, 'utf8')).labels.map((entry) => [entry.id, entry.label]));
  for (const sample of samples) {
    const before = previous.get(sample.id);
    const fields = ['category', 'deadline', 'course', 'assignment'].filter((field) => {
      const a = before?.[field] ?? null, b = sample.label[field];
      return field === 'deadline' ? (a && Date.parse(a)) !== (b && Date.parse(b)) : a !== b;
    });
    if (fields.length) revised.push(`${sample.id}（${fields.join('、')}）`);
  }
}
const meta = {
  datasetId: `human-labeled-${exported.labeledAt.slice(0, 10)}-v1`,
  provenance: `40 封全新虚构邮件：正文由 AI 起草（不取自演示邮件，调提示词时未使用），标签由团队成员在不看任何程序或模型结果的情况下逐封人工标注（${exported.labeledAt}）。`,
  independentHumanLabels: true,
  formalCompetitionDataset: true,
  sampleCount: samples.length,
  referenceNow: '2026-11-08T10:00:00+08:00',
  timeZone: 'Asia/Shanghai',
  labelPolicy: [
    '分类五选一，只选最主要的；定义见 docs/MATERIALS.md 第 4 节。',
    '截止时间只标“在此之前完成某事”的时间点；活动、讲座、考试举行时间不算截止；只给日期按当天 23:59；相对日期按发送时间换算；多个截止取与收件人最直接相关的一个。',
    '课程与作业只能从演示数据的 6 门课及其作业中选择，没有则为 null。',
    ...(notes.length ? [`标注备注：${notes.join('；')}`] : []),
    ...(previousPath ? [`第一轮标注后，标注者对照邮件原文与标注说明复核了 13 封可疑标注（挑选依据仅为原文与说明，未参考模型输出），最终修改 ${revised.length} 封：${revised.join('、') || '无'}。`] : []),
  ],
  limitations: [
    '单人标注，未做双人一致性复核。',
    '邮件为虚构文本，由 AI 起草，分布按材料手册建议设计，不代表真实邮箱的类别分布。',
    '截止与关联两项使用生产代码中的确定性规则，模型只影响分类和课程提示。',
  ],
};
writeFileSync(new URL('../fixtures/mails.human.meta.json', import.meta.url), `${JSON.stringify(meta, null, 2)}\n`);
console.log(`已写入 ${samples.length} 封；备注 ${notes.length} 条。分类分布：${JSON.stringify(Object.fromEntries(categories.map((c) => [c, samples.filter((s) => s.label.category === c).length])))}`);
