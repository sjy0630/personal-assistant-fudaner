import { useEffect, useState } from 'react';
import type { Memory, Profile } from '../../../../shared/types';
import { api } from '../../api';
import { cleanMemory } from '../settings-state';
import { Feedback, Loading, same, useLoad, useTask, type PanelProps } from './support';
import styles from './Settings.module.css';

const TYPES: Record<Memory['type'], string> = {
  preference: '偏好',
  schedule: '固定安排',
  goal: '目标',
  person: '人物',
  status: '近况',
  interest: '兴趣',
};
function profileFields(p: Profile) {
  return {
    nickname: p.nickname ?? '',
    school: p.school ?? '',
    major: p.major ?? '',
    grade: p.grade ?? '',
    degree: p.degree,
    freeText: p.freeText ?? '',
  };
}
type Personal = ReturnType<typeof profileFields>;
export function PersonalSettings({ onDirty, onBusy }: PanelProps) {
  const loaded = useLoad(async () => ({
    profile: await api.profile.get(),
    memories: await api.memory.list(),
  }));
  const [original, setOriginal] = useState<Personal | null>(null);
  const [draft, setDraft] = useState<Personal | null>(null);
  const [memories, setMemories] = useState<Memory[]>([]);
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [newMemory, setNewMemory] = useState('');
  const [newType, setNewType] = useState<Memory['type']>('preference');
  const task = useTask(onBusy);
  useEffect(() => {
    if (loaded.value) {
      const p = profileFields(loaded.value.profile);
      setDraft(p);
      setOriginal(p);
      setMemories(loaded.value.memories);
    }
  }, [loaded.value]);
  useEffect(
    () =>
      onDirty(
        !same(draft, original) ||
          !!newMemory ||
          memories.some((m) => edits[m.id] !== undefined && edits[m.id] !== m.content)
      ),
    [draft, original, newMemory, memories, edits, onDirty]
  );
  if (!draft || !original) return <Loading error={loaded.error} retry={loaded.retry} />;
  const field = (key: 'nickname' | 'school' | 'major' | 'grade', label: string) => (
    <label>
      {label}
      <input
        value={draft[key]}
        maxLength={100}
        onChange={(e) => {
          setDraft({ ...draft, [key]: e.target.value });
          task.clear();
        }}
      />
    </label>
  );
  return (
    <>
      <fieldset className={styles.form} disabled={!!task.busy}>
        <section className={styles.section}>
          <h2>个人画像</h2>
          <p className={styles.hint}>
            填写后助理会据此理解你的背景。画像保存在本机；使用云端对话时，相关内容可能作为上下文发送给你选择的模型服务。
          </p>
          <div className={styles.grid}>
            {field('nickname', '昵称')}
            {field('school', '院系')}
            {field('major', '专业')}
            {field('grade', '年级')}
            <label>
              学历
              <select
                aria-label="学历"
                value={draft.degree ?? ''}
                onChange={(e) => {
                  setDraft({
                    ...draft,
                    degree: (e.target.value || undefined) as Profile['degree'],
                  });
                  task.clear();
                }}
              >
                <option value="">暂不填写</option>
                <option>本科</option>
                <option>硕士</option>
                <option>博士</option>
              </select>
            </label>
          </div>
          <label>
            一句话介绍自己
            <textarea
              value={draft.freeText}
              rows={3}
              onChange={(e) => {
                setDraft({ ...draft, freeText: e.target.value });
                task.clear();
              }}
            />
          </label>
          <div className={styles.actions}>
            <button
              type="button"
              className="primary"
              disabled={same(draft, original)}
              onClick={() =>
                void task.run(
                  'profile',
                  async () => {
                    await api.profile.set(draft);
                    setOriginal({ ...draft });
                  },
                  '个人画像已保存。'
                )
              }
            >
              保存个人画像
            </button>
          </div>
        </section>
        <section className={styles.section}>
          <h2>
            {loaded.value?.profile.assistantName || '助理'}记住的事（{memories.length}）
          </h2>
          <p className={styles.hint}>你可以查看、修改或删除记忆。修改后需单独保存该条记忆。</p>
          {memories.length === 0 && (
            <p className={styles.hint}>还没有记忆。可以在下面添加一条，或在对话中说“记住……”。</p>
          )}
          {memories.map((m) => (
            <div className={styles.memory} key={m.id}>
              <div className={styles.memoryTop}>
                <span>
                  {TYPES[m.type]}
                  {m.pinned ? ' · 已置顶' : ''}
                </span>
                <span>
                  {m.source === 'chat'
                    ? '来自对话'
                    : m.source === 'feedback'
                      ? '来自反馈'
                      : '手动添加'}
                </span>
              </div>
              <label>
                记忆内容
                <textarea
                  aria-label={`记忆：${m.content}`}
                  value={edits[m.id] ?? m.content}
                  rows={2}
                  onChange={(e) => {
                    setEdits({ ...edits, [m.id]: e.target.value });
                    task.clear();
                  }}
                />
              </label>
              <div className={styles.actions}>
                <button
                  type="button"
                  disabled={edits[m.id] === undefined || edits[m.id] === m.content}
                  onClick={() =>
                    void task.run(
                      `memory-${m.id}`,
                      async () => {
                        const content = cleanMemory(edits[m.id] ?? m.content);
                        await api.memory.update(m.id, content);
                        setMemories((list) =>
                          list.map((x) => (x.id === m.id ? { ...x, content } : x))
                        );
                        setEdits((old) => {
                          const next = { ...old };
                          delete next[m.id];
                          return next;
                        });
                      },
                      '这条记忆已保存。'
                    )
                  }
                >
                  保存这条记忆
                </button>
                <button
                  type="button"
                  className="danger"
                  onClick={() => {
                    if (
                      window.confirm(
                        '删除这条记忆？这不会删除原始对话，但助理之后将不再使用这条记忆。'
                      )
                    )
                      void task.run(
                        `delete-${m.id}`,
                        async () => {
                          await api.memory.remove(m.id);
                          setMemories((list) => list.filter((x) => x.id !== m.id));
                          setEdits((old) => {
                            const next = { ...old };
                            delete next[m.id];
                            return next;
                          });
                        },
                        '记忆已删除。'
                      );
                  }}
                >
                  删除这条记忆
                </button>
              </div>
            </div>
          ))}
          <h3>手动添加</h3>
          <label>
            记忆类型
            <select value={newType} onChange={(e) => setNewType(e.target.value as Memory['type'])}>
              {Object.entries(TYPES).map(([k, v]) => (
                <option value={k} key={k}>
                  {v}
                </option>
              ))}
            </select>
          </label>
          <label>
            新记忆
            <textarea
              value={newMemory}
              rows={2}
              onChange={(e) => {
                setNewMemory(e.target.value);
                task.clear();
              }}
              placeholder="例如：周二晚上有社团活动。"
            />
          </label>
          <button
            type="button"
            onClick={() =>
              void task.run(
                'add',
                async () => {
                  const content = cleanMemory(newMemory);
                  await api.memory.add(content, newType);
                  setNewMemory('');
                  setMemories(await api.memory.list());
                },
                '记忆已添加。'
              )
            }
          >
            添加记忆
          </button>
        </section>
      </fieldset>
      <Feedback {...task} />
    </>
  );
}
