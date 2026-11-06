import { useEffect, useState } from 'react';
import type { Profile, Settings, TriggerKind } from '../../../../shared/types';
import { api } from '../../api';
import { toggleObserveRule, validateQuietHours } from '../settings-state';
import { Feedback, Loading, same, useLoad, useTask, type PanelProps } from './support';
import styles from './Settings.module.css';

const STYLES = [
  ['warm', '温和体贴', '我们一起理一下安排，先从最着急的事开始。'],
  ['concise', '简洁干练', '先确认截止时间，再排优先级。'],
  ['playful', '轻松幽默', '把这周的 DDL 揪出来，一个一个搞定。'],
] as const;
const LEVELS = [
  ['low', '少一些'],
  ['medium', '适中'],
  ['high', '多一些'],
] as const;
const RULES: ReadonlyArray<readonly [TriggerKind, string]> = [
  ['assignment_new', '新作业'],
  ['assignment_changed', '作业截止变更'],
  ['assignment_submitted', '作业提交确认'],
  ['announcement_new', '课程公告'],
  ['mail_new', '新邮件'],
  ['deadline_72h', '截止前 72 小时'],
  ['deadline_24h', '截止前 24 小时'],
  ['deadline_3h', '截止前 3 小时'],
  ['weekly_plan', '每周规划'],
  ['followup_due', '约定事项跟进'],
  ['phase_change', '学期阶段变化'],
  ['user_commitment', '对话中的计划'],
  ['auth_expired', '登录过期提醒'],
];
const assistantFields = (p: Profile) => ({
  assistantName: p.assistantName,
  style: p.style,
  proactivity: p.proactivity,
});
const reminderFields = (s: Settings) => ({
  quietHours: s.quietHours,
  observeRules: s.observeRules ?? [],
});
export function AssistantSettings({ onDirty, onBusy }: PanelProps) {
  const loaded = useLoad(async () => ({
    profile: await api.profile.get(),
    settings: await api.settings.get(),
  }));
  const [profile, setProfile] = useState<ReturnType<typeof assistantFields> | null>(null);
  const [savedProfile, setSavedProfile] = useState<typeof profile>(null);
  const [reminders, setReminders] = useState<ReturnType<typeof reminderFields> | null>(null);
  const [savedReminders, setSavedReminders] = useState<typeof reminders>(null);
  const task = useTask(onBusy);
  useEffect(() => {
    if (loaded.value) {
      const p = assistantFields(loaded.value.profile),
        s = reminderFields(loaded.value.settings);
      setProfile(p);
      setSavedProfile(p);
      setReminders(s);
      setSavedReminders(s);
    }
  }, [loaded.value]);
  useEffect(
    () => onDirty(!same(profile, savedProfile) || !same(reminders, savedReminders)),
    [profile, savedProfile, reminders, savedReminders, onDirty]
  );
  if (!profile || !reminders) return <Loading error={loaded.error} retry={loaded.retry} />;
  return (
    <>
      <fieldset className={styles.form} disabled={!!task.busy}>
        <section className={styles.section}>
          <h2>助理名字与说话方式</h2>
          <label>
            助理名字
            <input
              value={profile.assistantName}
              maxLength={30}
              onChange={(e) => {
                setProfile({ ...profile, assistantName: e.target.value });
                task.clear();
              }}
            />
          </label>
          <h3>说话风格</h3>
          <div className={styles.options} role="radiogroup" aria-label="说话风格">
            {STYLES.map(([value, label]) => (
              <label key={value} className={profile.style === value ? styles.selected : ''}>
                <input
                  type="radio"
                  name="assistant-style"
                  checked={profile.style === value}
                  onChange={() => {
                    setProfile({ ...profile, style: value });
                    task.clear();
                  }}
                />
                {label}
              </label>
            ))}
          </div>
          <div className={styles.preview}>
            <strong>{profile.assistantName.trim() || '助理'}</strong>
            <p>{STYLES.find(([key]) => key === profile.style)?.[2]}</p>
            <p className={styles.hint}>语气示例，非实时生成内容。</p>
          </div>
          <h3>主动程度</h3>
          <p className={styles.hint}>
            决定基础注意力预算，实际预算随学期阶段调整，并非每天固定的消息条数。新的主动程度在下一次预算初始化时使用。
          </p>
          <div className={styles.options} role="radiogroup" aria-label="主动程度">
            {LEVELS.map(([value, label]) => (
              <label key={value} className={profile.proactivity === value ? styles.selected : ''}>
                <input
                  type="radio"
                  name="proactivity"
                  checked={profile.proactivity === value}
                  onChange={() => {
                    setProfile({ ...profile, proactivity: value });
                    task.clear();
                  }}
                />
                {label}
              </label>
            ))}
          </div>
          <button
            type="button"
            className="primary"
            disabled={same(profile, savedProfile)}
            onClick={() =>
              void task.run(
                'profile',
                async () => {
                  const assistantName = profile.assistantName.trim();
                  if (!assistantName) throw new Error('请给助理填写一个名字。');
                  const patch = { ...profile, assistantName };
                  await api.profile.set(patch);
                  setProfile(patch);
                  setSavedProfile(patch);
                },
                '助理设置已保存，返回对话即可看到新名字。'
              )
            }
          >
            保存助理设置
          </button>
        </section>
        <section className={styles.section}>
          <h2>静默时段</h2>
          <p className={styles.hint}>
            支持跨零点。普通主动提醒会尽量合并到早安消息；早安和临近 3
            小时的截止提醒仍可能出现。起止时间相同表示不启用静默。
          </p>
          <div className={styles.grid}>
            <label>
              静默开始
              <input
                type="time"
                value={reminders.quietHours.start}
                onChange={(e) => {
                  setReminders({
                    ...reminders,
                    quietHours: { ...reminders.quietHours, start: e.target.value },
                  });
                  task.clear();
                }}
              />
            </label>
            <label>
              静默结束
              <input
                type="time"
                value={reminders.quietHours.end}
                onChange={(e) => {
                  setReminders({
                    ...reminders,
                    quietHours: { ...reminders.quietHours, end: e.target.value },
                  });
                  task.clear();
                }}
              />
            </label>
          </div>
          <h3>观察模式：只记录，不打扰</h3>
          <p className={styles.hint}>
            勾选的事件仍会被评估并写入主动决策记录，但不执行主动消息或其他写回。早安消息使用独立逻辑，当前不支持观察模式。紧急截止提醒被勾选后也只记录，请按需要选择。
          </p>
          <div className={styles.rules}>
            {RULES.map(([key, label]) => (
              <label className={styles.check} key={key}>
                <input
                  type="checkbox"
                  checked={reminders.observeRules.includes(key)}
                  onChange={(e) => {
                    setReminders({
                      ...reminders,
                      observeRules: toggleObserveRule(
                        reminders.observeRules,
                        key,
                        e.target.checked
                      ),
                    });
                    task.clear();
                  }}
                />
                {label}
              </label>
            ))}
          </div>
          {reminders.observeRules.some((r) => !RULES.some(([key]) => key === r)) && (
            <p className={styles.hint}>还存在分类规则或其他版本添加的观察项，这里会保留它们。</p>
          )}
          <button
            type="button"
            className="primary"
            disabled={same(reminders, savedReminders)}
            onClick={() =>
              void task.run(
                'reminders',
                async () => {
                  const problem = validateQuietHours(reminders.quietHours);
                  if (problem) throw new Error(problem);
                  await api.settings.set(reminders);
                  setSavedReminders({ ...reminders });
                },
                '静默时段与观察模式已保存，后续事件按新设置处理。'
              )
            }
          >
            保存提醒设置
          </button>
        </section>
      </fieldset>
      <Feedback {...task} />
    </>
  );
}
