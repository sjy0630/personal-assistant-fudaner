import { useEffect, useState } from 'react';
import type { Settings } from '../../../../shared/types';
import { api } from '../../api';
import { Feedback, Loading, useLoad, useTask, type PanelProps } from './support';
import styles from './Settings.module.css';

export function DeveloperSettings({ onDirty, onBusy }: PanelProps) {
  const loaded = useLoad(() => api.settings.get());
  const [settings, setSettings] = useState<Settings | null>(null);
  const [demo, setDemo] = useState(false);
  const task = useTask(onBusy);
  useEffect(() => {
    if (loaded.value) {
      setSettings(loaded.value);
      setDemo(loaded.value.demoMode);
    }
  }, [loaded.value]);
  useEffect(() => onDirty(!!settings && demo !== settings.demoMode), [settings, demo, onDirty]);
  if (!settings) return <Loading error={loaded.error} retry={loaded.retry} />;
  const tool = (
    name: string,
    title: string,
    description: string,
    action: () => Promise<void>,
    success: string
  ) => (
    <div className={styles.tool} key={name}>
      <div>
        <strong>{title}</strong>
        <p className={styles.hint}>{description}</p>
      </div>
      <button
        type="button"
        disabled={!settings.demoMode}
        onClick={() => void task.run(name, action, success)}
      >
        {task.busy === name ? '执行中…' : '触发演示'}
      </button>
    </div>
  );
  return (
    <>
      <fieldset className={styles.form} disabled={!!task.busy}>
        <section className={styles.section}>
          <h2>数据模式</h2>
          <p className={styles.hint}>
            演示数据均为虚构内容。切换来源不会清除已有数据；开始真实使用前，请确认现有数据是否需要保留。
          </p>
          <label className={styles.check}>
            <input
              type="checkbox"
              checked={demo}
              onChange={(e) => {
                setDemo(e.target.checked);
                task.clear();
              }}
            />
            使用演示数据
          </label>
          <button
            type="button"
            disabled={demo === settings.demoMode}
            onClick={() =>
              void task.run(
                'mode',
                async () => {
                  await api.settings.set({ demoMode: demo });
                  setSettings({ ...settings, demoMode: demo });
                },
                demo
                  ? '演示模式已保存，下一次同步将使用虚构数据。'
                  : '真实数据模式已保存，请在账号页检查连接后同步。'
              )
            }
          >
            保存数据模式
          </button>
        </section>
        <section className={styles.section}>
          <h2>演示场景</h2>
          <p className={styles.hint}>
            用于彩排和录屏。切回对话或相关页面查看结果；真实数据模式下禁用这些演示操作。
          </p>
          {tool(
            'mail',
            '助教补充邮件',
            '为 Lab 5 注入补充邮件，展示邮件与作业关联。',
            api.dev.demoNewMail,
            '补充邮件场景已执行，可到对话和动态查看。'
          )}
          {tool(
            'submit',
            '作业提交闭环',
            '模拟交掉最近一份作业，检查目标进度和提醒是否收尾。',
            api.dev.demoSubmitNext,
            '作业提交场景已执行，请查看对话和目标。'
          )}
          {tool(
            'exam',
            '考试周前',
            '将演示校历切到考试周前，展示主动规划。',
            () => api.dev.setDemoPhase('pre_exam'),
            '演示阶段已切换到考试周前。'
          )}
          <div className={styles.actions}>
            <button
              type="button"
              onClick={() =>
                void task.run('calendar', () => api.dev.setDemoPhase(''), '已恢复真实校历。')
              }
            >
              恢复真实校历
            </button>
            <button
              type="button"
              onClick={() =>
                void task.run(
                  'tick',
                  api.dev.tick,
                  '同步与主动引擎已执行。',
                  '执行未完成，请检查账号连接与模型设置后重试。'
                )
              }
            >
              同步并运行主动引擎
            </button>
          </div>
        </section>
        <section className={styles.section}>
          <h2>重新准备演示</h2>
          <p className={styles.hint}>
            重置会清空当前对话、画像、记忆、课程和资源，再加载演示数据。模型与应用设置保留。请勿用它处理需要保留的真实数据。
          </p>
          <button
            type="button"
            disabled={!settings.demoMode}
            onClick={() => {
              if (
                window.confirm(
                  '重置演示将清空当前对话、画像、记忆、课程和资源，并重新加载虚构数据。模型与应用设置保留。确认重置？'
                )
              )
                void task.run('reset', api.dev.resetDemo, '演示数据已重置。');
            }}
          >
            重置演示数据
          </button>
        </section>
        <section className={styles.section}>
          <h2 className={styles.danger}>清除本地内容</h2>
          <p className={styles.hint}>
            清除对话、画像、记忆、课程、资源和邮箱专用密码。模型及应用设置会保留，不会删除校内平台的原始内容。此操作不可撤销。
          </p>
          <button
            type="button"
            className="danger"
            onClick={() => {
              if (
                window.confirm(
                  '确认清除本地内容？对话、画像、记忆、课程、资源和邮箱专用密码将被清除；模型及应用设置保留，校内原始内容不受影响。此操作不可撤销。'
                )
              )
                void task.run(
                  'wipe',
                  api.dev.wipe,
                  '本地内容已清除。后台同步仍启用时，课程和邮件可能会重新同步。'
                );
            }}
          >
            清除本地内容
          </button>
        </section>
      </fieldset>
      <Feedback {...task} />
    </>
  );
}
