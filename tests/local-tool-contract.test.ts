import { afterEach, describe, expect, it } from 'vitest';
import { runAgentLoop } from '../src/main/ai/agent';
import { parseJsonLoose } from '../src/main/ai/llm';
import { Db } from '../src/main/db/db';
import { Repo } from '../src/main/db/repo';
import { nullChannels } from '../src/main/engine/channels';
import { createLocalServer } from '../src/main/local-tools/server';
import { McpHub } from '../src/main/mcp/hub';
import type { Goal, Task } from '../src/shared/types';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });

async function setup(scope: 'chat' | 'executor' = 'chat') {
  const db = new Db(':memory:');
  const repo = new Repo(db);
  const hub = new McpHub();
  cleanups.push(async () => { await hub.close(); db.close(); });
  await hub.connect('fudaner-local', createLocalServer(repo, nullChannels, scope));
  return { repo, hub };
}

describe('本地工具的日期和父对象契约（真实 MCP）', () => {
  it.each(['', '  \n\t '])('空白截止时间 %j 在目标和任务中均正规化为未设置', async (dueAt) => {
    const { repo, hub } = await setup();
    const goalResult = await hub.call('fudaner_local__create_goal', { title: '准备 GRE', level: 'long_term', due_at: dueAt });
    const goal = parseJsonLoose<Goal>(goalResult.text)!;
    expect(goalResult.ok).toBe(true);
    expect(goal.dueAt).toBeUndefined();
    expect(repo.getGoal(goal.id)?.dueAt).toBeUndefined();
    const taskResult = await hub.call('fudaner_local__add_task', { goal_id: goal.id, title: '背词汇', due_at: dueAt });
    const task = parseJsonLoose<Task>(taskResult.text)!;
    expect(taskResult.ok).toBe(true);
    expect(task.dueAt).toBeUndefined();
    expect(repo.getTask(task.id)).toMatchObject({ goalId: goal.id, title: '背词汇' });
  });

  it.each(['2026-11-10T23:59:00+08:00', '2026-11-10T15:59:00Z', '2026-11-10T10:59:00-05:00'])('有效带时区日期 %s 统一保存为 UTC ISO', async (dueAt) => {
    const { repo, hub } = await setup();
    const goalResult = await hub.call('fudaner_local__create_goal', { title: '准备 GRE', level: 'long_term', due_at: dueAt });
    const goal = parseJsonLoose<Goal>(goalResult.text)!;
    const taskResult = await hub.call('fudaner_local__add_task', { goal_id: goal.id, title: '背词汇', due_at: dueAt });
    const task = parseJsonLoose<Task>(taskResult.text)!;
    expect(goalResult.ok && taskResult.ok).toBe(true);
    expect(repo.getGoal(goal.id)?.dueAt).toBe('2026-11-10T15:59:00.000Z');
    expect(repo.getTask(task.id)?.dueAt).toBe('2026-11-10T15:59:00.000Z');
  });

  it.each([
    'not-a-date', '2026-11-10', '2026-11-10T23:59:00',
    '2026-02-30T23:59:00+08:00', '2026-13-10T23:59:00+08:00',
    '2026-11-10T24:00:00+08:00', '2026-11-10T23:59:00+24:00',
    '2026-11-10T23:59:00+08:00 trailing',
  ])('非法或缺时区日期 %s 对目标和任务都返回错误且零写入', async (dueAt) => {
    const { repo, hub } = await setup();
    const goalResult = await hub.call('fudaner_local__create_goal', { title: '不应写入', level: 'week', due_at: dueAt });
    const taskResult = await hub.call('fudaner_local__add_task', { title: '不应写入', due_at: dueAt });
    expect(goalResult.ok).toBe(false);
    expect(taskResult.ok).toBe(false);
    expect(goalResult.text).toContain('带时区');
    expect(taskResult.text).toContain('due_at');
    expect(repo.listGoals()).toHaveLength(0);
    expect(repo.listTasks()).toHaveLength(0);
  });

  it.each(['准备 GRE', 'missing-goal-id', ''])('goal_id=%j 不是真实目标 ID 时拒绝写任务并提示正确获取方式', async (goalId) => {
    const { repo, hub } = await setup();
    repo.addGoal({ title: '准备 GRE', level: 'long_term', createdBy: 'assistant' });
    const result = await hub.call('fudaner_local__add_task', { goal_id: goalId, title: '不应成为孤儿任务', due_at: '' });
    expect(result.ok).toBe(false);
    expect(result.text).toContain('create_goal');
    expect(result.text).toContain('list_goals');
    expect(result.text).toContain('真实 id');
    expect(repo.listTasks()).toHaveLength(0);
  });

  it('从 list_goals 得到的真实 ID 可以正确关联，省略 goal_id 仍可创建独立任务', async () => {
    const { repo, hub } = await setup();
    const goal = repo.addGoal({ title: '准备 GRE', level: 'long_term', createdBy: 'assistant' });
    const listed = await hub.call('fudaner_local__list_goals', {});
    const goalId = parseJsonLoose<Goal[]>(listed.text)![0].id;
    const linked = await hub.call('fudaner_local__add_task', { goal_id: goalId, title: '背词汇' });
    const standalone = await hub.call('fudaner_local__add_task', { title: '整理桌面' });
    expect(linked.ok && standalone.ok).toBe(true);
    expect(repo.getTask(parseJsonLoose<Task>(linked.text)!.id)?.goalId).toBe(goal.id);
    expect(repo.getTask(parseJsonLoose<Task>(standalone.text)!.id)?.goalId).toBeUndefined();
  });

  it('目标和任务的空日期不会在真实工具循环结果卡片中产生 NaN', async () => {
    const { hub } = await setup();
    let step = 0;
    const result = await runAgentLoop({
      hub, tools: hub.llmTools(), messages: [],
      llm: { label: 'fixture', chat: async (messages) => {
        step++;
        if (step === 1) return { content: '', toolCalls: [{ id: 'goal', name: 'fudaner_local__create_goal', arguments: '{"title":"GRE","level":"week","due_at":""}' }] };
        if (step === 2) {
          const goal = parseJsonLoose<Goal>(messages.at(-1)!.content!)!;
          return { content: '', toolCalls: [{ id: 'task', name: 'fudaner_local__add_task', arguments: JSON.stringify({ goal_id: goal.id, title: '背词汇', due_at: '  ' }) }] };
        }
        return { content: '已创建。', toolCalls: [] };
      } },
    });
    expect(result.cards).toHaveLength(2);
    expect(result.cards.find((card) => card.type === 'task')?.subtitle).toBe('所属：GRE');
    expect(JSON.stringify(result.cards)).not.toContain('NaN');
  });

  it('不存在的 task_id 不会谎报状态更新成功，也不修改其他任务', async () => {
    const { repo, hub } = await setup();
    const task = repo.addTask({ title: '背词汇', source: 'assistant' });
    const result = await hub.call('fudaner_local__update_progress', { task_id: 'missing-task-id', status: 'done' });
    expect(result.ok).toBe(false);
    expect(result.text).toContain('task_id');
    expect(result.text).toContain('add_task');
    expect(repo.getTask(task.id)?.status).toBe('todo');
    const updated = await hub.call('fudaner_local__update_progress', { task_id: task.id, status: 'done' });
    expect(updated.ok).toBe(true);
    expect(repo.getTask(task.id)?.status).toBe('done');
  });

  it('后台工具集同样拒绝标题充当父目标 ID，且仍不开放 update_progress', async () => {
    const { repo, hub } = await setup('executor');
    repo.addGoal({ title: '准备 GRE', level: 'long_term', createdBy: 'assistant' });
    const invalid = await hub.call('fudaner_local__add_task', { goal_id: '准备 GRE', title: '不应写入' });
    expect(invalid.ok).toBe(false);
    expect(repo.listTasks()).toHaveLength(0);
    expect(hub.list()[0].tools).not.toContain('update_progress');
  });
});
