import type { Repo } from '../db/repo';
import type { CardRef } from '../../shared/types';
import { shanghaiTime } from './query-context';

const positiveRequest = (text: string) => text.replace(/(?:不要|不必|不用|先别|禁止|无需|不(?=添加|新增|创建|建立|加入|拆解|设置))[^，。；\n]*/gu, '').replace(/\s/gu, '');

/** 只对本地明确的目标创建操作收敛回执，普通问答与现有目标操作保持原流程。 */
export function needsGoalReceipt(label: string, text: string): boolean {
  const request = positiveRequest(text);
  return label.startsWith('local:') && /(?:^|帮我|给我|为我|替我|请(?:先)?|我(?:想|要|需要)(?:先)?|直接)(?:创建|新建|建立|设立|建).{0,20}目标/u.test(request);
}

/** 仅依据实际保存的对象及父ID说明结果，不采用模型对写入成功的自然语言断言。 */
export function goalReceipt(repo: Repo, cards: CardRef[], text: string, finished: boolean): string {
  const lines: string[] = [];
  const seen = new Set<string>();
  let goals = 0, tasks = 0;
  for (const card of cards) {
    const key = `${card.type}:${card.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (card.type === 'goal') {
      const goal = repo.getGoal(card.id);
      if (goal) { goals++; lines.push(`已创建${goal.level === 'long_term' ? '长期' : ''}目标「${goal.title}」。`); }
      else lines.push('本轮目标当前已不存在，请核对保存结果。');
    }
    if (card.type === 'task') {
      const task = repo.getTask(card.id);
      if (!task) { lines.push('本轮任务当前已不存在，请核对保存结果。'); continue; }
      tasks++;
      const parent = task.goalId ? repo.getGoal(task.goalId) : undefined;
      const location = parent ? `，所属目标「${parent.title}」` : task.goalId ? '，所属目标当前已不存在，需要核对' : '，作为独立任务';
      const due = !task.dueAt ? '，暂未设置截止日期' : Number.isFinite(Date.parse(task.dueAt)) ? `，截止 ${shanghaiTime(task.dueAt)}（上海时间）` : '，截止时间待核对';
      lines.push(`已保存任务「${task.title}」${location}${due}。`);
    }
    if (card.type === 'resource') {
      const resource = repo.getResource(card.id);
      if (resource) lines.push(`已保存资源「${resource.title}」。`);
    }
  }
  if (!goals) lines.unshift('本轮尚未成功创建目标。');
  const request = positiveRequest(text).replace(/“[^”]*”|「[^」]*」|'[^']*'|"[^"]*"/gu, '');
  if (!tasks && /(?:添加|新增|加入|加|拆解|拆成|创建|建立).{0,20}任务|任务.{0,12}(?:添加|新增|加入|拆解)/u.test(request)) lines.push('任务尚未添加成功。');
  if (!finished) lines.push('本轮尚未完整完成，以上仅列出已保存的结果。');
  return lines.join('\n\n');
}
