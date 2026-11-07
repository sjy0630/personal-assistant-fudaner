import { afterEach, describe, expect, it, vi } from 'vitest';
import { ChatAgent } from '../src/main/ai/agent';
import { goalReceipt, needsGoalReceipt } from '../src/main/ai/goal-receipt';
import type { LlmClient, LlmMessage, LlmOptions, LlmResult, ModelRouter } from '../src/main/ai/llm';
import { Db } from '../src/main/db/db';
import { Repo } from '../src/main/db/repo';
import { nullChannels } from '../src/main/engine/channels';
import { createLocalServer } from '../src/main/local-tools/server';
import { McpHub } from '../src/main/mcp/hub';

const prompt = '我想准备 GRE，帮我建一个长期目标，并在这个目标下添加“完成一套 GRE 模考”的任务。暂时不设置截止日期。';
const answer = (content: string): LlmResult => ({ content, toolCalls: [] });
const call = (name: string, args: Record<string, unknown>): LlmResult => ({ content: '', toolCalls: [{ id: crypto.randomUUID(), name: `fudaner_local__${name}`, arguments: JSON.stringify(args) }] });
const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
type Turn = (messages: LlmMessage[], options?: LlmOptions) => LlmResult | Promise<LlmResult>;

async function setup(label = 'local:fixture') {
  const db = new Db(':memory:'); cleanups.push(() => db.close());
  const repo = new Repo(db); const hub = new McpHub(); cleanups.push(() => hub.close());
  await hub.connect('fudaner-local', createLocalServer(repo, nullChannels));
  const exchange = repo.addGoal({ title: '申请2027春季交换', level: 'long_term', createdBy: 'user' });
  let turns: Turn[] = [], index = 0;
  const llm: LlmClient = { label, chat: vi.fn(async (messages, options) => turns[index++](messages, options)) };
  const snapshots: { id: string; content: string }[] = [];
  const agent = new ChatAgent(repo, { for: task => task === 'chat' ? llm : null } as ModelRouter, hub, { ...nullChannels, delta: view => snapshots.push(structuredClone(view)) });
  const gre = () => repo.listGoals().find(g => g.title === '准备GRE')!;
  return { repo, hub, exchange, agent, llm, snapshots, gre, script: (value: Turn[]) => { turns = value; index = 0; } };
}

describe('目标回执与数据库实际保存结果一致', () => {
  it('添加先失败后成功，错误模型归属不出现在流、快照或历史中', async () => {
    const s = await setup();
    const wrong = '任务添加成功，已经加入到申请2027春季交换的目标下。';
    s.script([
      (_m, options) => { options?.onDelta?.('先创建一个交换目标。'); return call('create_goal', { title: '准备GRE', level: 'long_term' }); },
      () => call('add_task', { goal_id: s.gre().id, title: '完成一套 GRE 模考', due_at: '下周' }),
      () => call('add_task', { goal_id: s.gre().id, title: '完成一套 GRE 模考' }),
      (_m, options) => { expect(options?.onDelta).toBeTypeOf('function'); options?.onDelta?.(wrong); return answer(wrong); },
    ]);
    const reply = await s.agent.handleUserMessage(prompt);
    const task = s.repo.getTask(reply.cards.find(c => c.type === 'task')!.id)!;
    expect(task.goalId).toBe(s.gre().id); expect(task.dueAt).toBeUndefined();
    expect(reply.toolCalls.filter(t => t.name === 'add_task').map(t => t.ok)).toEqual([false, true]);
    expect(reply.content).toContain('所属目标「准备GRE」'); expect(reply.content).toContain('暂未设置截止日期');
    expect(reply.content).not.toContain('交换'); expect(s.snapshots.every(v => !v.content.includes('交换'))).toBe(true);
    expect(s.snapshots.at(-1)).toMatchObject({ id: reply.id, content: reply.content });
    expect(s.repo.getMessage(reply.id)?.content).toBe(reply.content);
    expect(reply.cards.find(c => c.type === 'task')?.subtitle).toContain('所属：准备GRE');
    expect(reply.cards.every(c => c.undoToken)).toBe(true);
  });

  it('任务未成功时不宣称已完成，即使模型声称目标和任务都成功', async () => {
    const s = await setup(); s.script([
      () => call('create_goal', { title: '准备GRE', level: 'long_term' }),
      () => call('add_task', { goal_id: s.gre().id, title: '模考', due_at: '下周' }),
      (_m, o) => { o?.onDelta?.('全部完成。'); return answer('全部完成。'); },
    ]);
    const reply = await s.agent.handleUserMessage(prompt);
    expect(reply.content).toContain('已创建长期目标「准备GRE」'); expect(reply.content).toContain('任务尚未添加成功');
    expect(reply.content).not.toContain('全部完成'); expect(s.repo.listTasks()).toEqual([]);
  });

  it('目标根本未创建时不采信模型成功声明', async () => {
    const s = await setup(); s.script([(_m, o) => { o?.onDelta?.('已创建GRE。'); return answer('已创建GRE。'); }]);
    const reply = await s.agent.handleUserMessage(prompt);
    expect(reply.content).toContain('尚未成功创建目标'); expect(reply.content).toContain('任务尚未添加成功');
    expect(s.repo.listGoals().map(g => g.id)).toEqual([s.exchange.id]);
  });

  it('多目标回执分别使用各任务真实父目标，不以最近目标替代', async () => {
    const s = await setup(); s.script([
      () => call('create_goal', { title: '准备GRE', level: 'long_term' }),
      () => call('create_goal', { title: '准备托福', level: 'long_term' }),
      () => call('add_task', { goal_id: s.gre().id, title: 'GRE模考' }),
      () => call('add_task', { goal_id: s.repo.listGoals().find(g => g.title === '准备托福')!.id, title: '托福模考' }),
      () => answer('都放到交换目标了。'),
    ]);
    const reply = await s.agent.handleUserMessage('请创建GRE和托福两个长期目标，并分别添加模考任务');
    expect(reply.content).toContain('「GRE模考」，所属目标「准备GRE」'); expect(reply.content).toContain('「托福模考」，所属目标「准备托福」');
    expect(reply.content).not.toContain('交换');
  });

  it('实际任务若属于旧目标，则如实报告旧目标，不把它包装成GRE关联成功', async () => {
    const s = await setup(); s.script([
      () => call('create_goal', { title: '准备GRE', level: 'long_term' }),
      () => call('add_task', { goal_id: s.exchange.id, title: '模考' }), () => answer('已加到GRE。'),
    ]);
    const reply = await s.agent.handleUserMessage(prompt);
    expect(reply.content).toContain('所属目标「申请2027春季交换」');
    expect(s.repo.getTask(reply.cards.find(c => c.type === 'task')!.id)?.goalId).toBe(s.exchange.id);
  });

  it('断流保留实际目标卡片及撤销权限，不发布未核实正文', async () => {
    const s = await setup(); s.script([
      () => call('create_goal', { title: '准备GRE', level: 'long_term' }),
      (_m, o) => { o?.onDelta?.('已添加到交换。'); throw new Error('provider-private-message'); },
    ]);
    const reply = await s.agent.handleUserMessage(prompt);
    expect(reply.content).toContain('回复未完成'); expect(reply.content).not.toContain('交换'); expect(reply.content).not.toContain('provider-private');
    expect(reply.cards[0].undoToken).toBeTruthy(); expect(s.repo.getGoal(reply.cards[0].id)?.title).toBe('准备GRE');
  });

  it('取消保留已完成工具卡片，错误模型文本不会留在快照中', async () => {
    const s = await setup(); s.script([
      () => call('create_goal', { title: '准备GRE', level: 'long_term' }),
      (_m, o) => { o?.onDelta?.('放进交换目标。'); s.agent.cancel(s.agent.state()!.id); return answer('放进交换目标。'); },
    ]);
    const reply = await s.agent.handleUserMessage(prompt);
    expect(reply.content).toContain('已停止生成'); expect(reply.content).not.toContain('交换'); expect(reply.cards[0].undoToken).toBeTruthy();
  });

  it('云端正常创建目标仍保留原有分片展示', async () => {
    const s = await setup('cloud:fixture'); s.script([
      (_m, o) => { o?.onDelta?.('先创建目标。'); return call('create_goal', { title: '准备GRE', level: 'long_term' }); },
      (_m, o) => { o?.onDelta?.('目标已创建。'); return answer('目标已创建。'); },
    ]);
    const reply = await s.agent.handleUserMessage(prompt);
    expect(s.snapshots.some(v => v.content === '先创建目标。')).toBe(true); expect(reply.content).toContain('目标已创建。');
  });

  it('向现有目标加任务不误报新建目标，卡片同时保留真实父目标与截止时间', async () => {
    const s = await setup(); s.script([
      () => call('add_task', { goal_id: s.exchange.id, title: '看交换要求', due_at: '2026-11-10T23:59:00+08:00' }),
      (_m, o) => { o?.onDelta?.('已加入已有交换目标。'); return answer('已加入已有交换目标。'); },
    ]);
    const reply = await s.agent.handleUserMessage('给已有的申请2027春季交换目标添加一项看交换要求的任务');
    expect(reply.content).not.toContain('已创建'); expect(reply.content).toContain('已加入已有交换目标');
    expect(reply.cards[0].subtitle).toContain('所属：申请2027春季交换'); expect(reply.cards[0].subtitle).toContain('截止');
  });

  it('对象已删除、独立任务及未完整结束的回执不虚构归属或整体成功', async () => {
    const s = await setup();
    const task = s.repo.addTask({ title: '独立任务', source: 'assistant' });
    const receipt = goalReceipt(s.repo, [{ type: 'goal', id: 'deleted', title: '已删除目标' }, { type: 'task', id: task.id, title: task.title }], prompt, false);
    expect(receipt).toContain('目标当前已不存在'); expect(receipt).toContain('作为独立任务'); expect(receipt).toContain('尚未完整完成');
    expect(receipt).not.toContain('所属目标「');
  });

  it.each(['帮我创建一个长期目标准备GRE，不要添加任务。', '帮我创建一个长期目标“加入学生会”。'])('没有要求添加任务时不误报任务失败：%s', async text => {
    const s = await setup(); s.script([() => call('create_goal', { title: '准备GRE', level: 'long_term' }), () => answer('已创建。')]);
    const reply = await s.agent.handleUserMessage(text);
    expect(reply.content).toContain('已创建长期目标'); expect(reply.content).not.toContain('任务尚未添加成功');
  });

  describe('本轮父目标 ID 程序兜底', () => {
    const named = '帮我创建一个名为“回执验收临时目标”的长期目标，并在这个目标下添加“检查回执”任务。暂时不设置截止日期。';
    const created = (s: Awaited<ReturnType<typeof setup>>) => s.repo.listGoals().find(g => g.title === '回执验收临时目标')!;

    it.each(['回执验收临时目标', '「回执验收临时目标」', '目标 id'])('把标题或占位符形式的 goal_id 纠正为本轮新建目标：%s', async goalId => {
      const s = await setup(); s.script([
        () => call('create_goal', { title: '回执验收临时目标', level: 'long_term' }),
        () => call('add_task', { goal_id: goalId, title: '检查回执' }),
        () => answer('完成。'),
      ]);
      const reply = await s.agent.handleUserMessage(named);
      const tasks = s.repo.listTasks({ goalId: created(s).id });
      expect(tasks.map(t => t.title)).toEqual(['检查回执']);
      expect(reply.toolCalls.find(t => t.name === 'add_task')).toMatchObject({ ok: true, args: { goal_id: created(s).id } });
      expect(reply.content).toContain('所属目标「回执验收临时目标」');
      expect(s.repo.listTasks({ goalId: s.exchange.id })).toEqual([]);
    });

    it('省略 goal_id 但用户要求放在这个目标下时挂到本轮唯一新建目标', async () => {
      const s = await setup(); s.script([
        () => call('create_goal', { title: '回执验收临时目标', level: 'long_term' }),
        () => call('add_task', { title: '检查回执' }),
        () => answer('完成。'),
      ]);
      await s.agent.handleUserMessage(named);
      expect(s.repo.listTasks({ goalId: created(s).id }).map(t => t.title)).toEqual(['检查回执']);
    });

    it('同名目标本轮不重复创建，并把真实 id 告诉模型', async () => {
      const s = await setup(); s.script([
        () => call('create_goal', { title: '回执验收临时目标', level: 'long_term' }),
        () => call('create_goal', { title: '回执验收临时目标', level: 'long_term' }),
        messages => { expect(String(messages.at(-1)?.content)).toContain(created(s).id); return call('add_task', { goal_id: created(s).id, title: '检查回执' }); },
        () => answer('完成。'),
      ]);
      const reply = await s.agent.handleUserMessage(named);
      expect(s.repo.listGoals().filter(g => g.title === '回执验收临时目标')).toHaveLength(1);
      expect(reply.toolCalls.filter(t => t.name === 'create_goal').map(t => t.ok)).toEqual([true, false]);
      expect(reply.content.match(/已创建长期目标/gu)).toHaveLength(1);
    });

    it('涉及已有目标时不把未知 ID 猜到新目标上，只按唯一标题匹配已有目标', async () => {
      const text = '帮我创建一个长期目标“准备GRE”，再给已有的“申请2027春季交换”目标添加“写个人陈述”任务。';
      const s = await setup(); s.script([
        () => call('create_goal', { title: '准备GRE', level: 'long_term' }),
        () => call('add_task', { goal_id: 'missing', title: '写个人陈述' }),
        () => call('add_task', { goal_id: '申请2027春季交换', title: '写个人陈述' }),
        () => answer('完成。'),
      ]);
      const reply = await s.agent.handleUserMessage(text);
      expect(reply.toolCalls.filter(t => t.name === 'add_task').map(t => t.ok)).toEqual([false, true]);
      expect(s.repo.listTasks({ goalId: s.exchange.id }).map(t => t.title)).toEqual(['写个人陈述']);
      expect(s.repo.listTasks({ goalId: s.gre().id })).toEqual([]);
    });
  });

  it.each(['请解释如何创建目标和添加任务', '不要创建目标，只添加任务', '给已有目标添加任务'])('不把非创建操作套进新建回执：%s', text => expect(needsGoalReceipt('local:fixture', text)).toBe(false));
});
