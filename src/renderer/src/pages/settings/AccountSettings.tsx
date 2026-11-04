import { useEffect, useState } from 'react';
import type { PlatformState, Settings } from '../../../../shared/types';
import { api } from '../../api';
import { needsMailPassword, prepareMail } from '../settings-state';
import { Feedback, Loading, same, useLoad, useTask, type PanelProps } from './support';
import styles from './Settings.module.css';

const EMPTY_MAIL = { user: '', host: 'imap.exmail.qq.com', port: 993 };
const PLATFORM = { elearning: 'eLearning', icourse: 'iCourse', mail: '学生邮箱' };
const LABEL = {
  ok: '已连接',
  need_login: '需要重新登录',
  unavailable: '暂时不可用',
  not_configured: '未配置',
  demo: '演示数据',
};

export function AccountSettings({ onDirty, onBusy }: PanelProps) {
  const loaded = useLoad(async () => ({
    settings: await api.settings.get(),
    states: await api.platforms.status(),
  }));
  const [saved, setSaved] = useState<Settings | null>(null);
  const [mail, setMail] = useState(EMPTY_MAIL);
  const [password, setPassword] = useState('');
  const [states, setStates] = useState<PlatformState[]>([]);
  const [lastSync, setLastSync] = useState('');
  const task = useTask(onBusy);
  useEffect(() => {
    if (loaded.value) {
      setSaved(loaded.value.settings);
      setMail(loaded.value.settings.mail ?? EMPTY_MAIL);
      setStates(loaded.value.states);
    }
  }, [loaded.value]);
  useEffect(
    () => onDirty(!!password || (saved !== null && !same(mail, saved.mail ?? EMPTY_MAIL))),
    [password, mail, saved, onDirty]
  );
  useEffect(() => {
    let live = true;
    const off = api.on('platforms:changed', () => {
      void api.platforms
        .status()
        .then((s) => {
          if (live) setStates(s);
        })
        .catch(() => undefined);
    });
    return () => {
      live = false;
      off();
    };
  }, []);
  if (!saved) return <Loading error={loaded.error} retry={loaded.retry} />;
  const refresh = async () => setStates(await api.platforms.status());
  return (
    <>
      <fieldset className={styles.form} disabled={!!task.busy}>
        <section className={styles.section}>
          <h2>校园连接</h2>
          <p className={styles.hint}>
            {saved.demoMode
              ? '当前使用虚构演示数据，以下状态不代表真实校园连接。数据模式可在「开发者」中调整。'
              : '通过复旦统一身份认证登录，eLearning 等校内平台共用登录会话。密码由你在官方登录窗口输入，应用不读取或保存。'}
          </p>
          <div className={styles.statusRows}>
            {states.map((p) => (
              <div className={styles.statusRow} key={p.platform}>
                <div>
                  <strong>{PLATFORM[p.platform]}</strong>
                  <p className={styles.hint}>
                    {p.platform === 'mail' && p.status === 'ok'
                      ? '已有邮箱配置，收信是否可用需通过同步验证。'
                      : p.status === 'need_login'
                        ? '登录会话不可用，请重新登录后同步。'
                        : p.status === 'unavailable'
                          ? '请检查网络后重试，或稍后使用演示数据。'
                          : p.status === 'not_configured'
                            ? '完成配置后再同步。'
                            : p.status === 'demo'
                              ? '使用内置虚构内容。'
                              : '可尝试同步最新数据。'}
                  </p>
                </div>
                <span className={styles.badge}>
                  {p.platform === 'mail' && p.status === 'ok' ? '已配置，待验证' : LABEL[p.status]}
                </span>
              </div>
            ))}
          </div>
          <div className={styles.actions}>
            <button
              type="button"
              className="primary"
              disabled={saved.demoMode}
              onClick={() =>
                void task.run(
                  'login',
                  async () => {
                    await api.platforms.login();
                    await refresh();
                  },
                  '登录窗口已结束，请以上方实际连接状态为准。',
                  '登录未完成，请重新打开登录窗口，或检查网络后重试。'
                )
              }
            >
              {task.busy === 'login' ? '等待完成登录…' : '登录 / 重新登录复旦账号'}
            </button>
            <button
              type="button"
              onClick={() =>
                void task.run(
                  'sync',
                  async () => {
                    await api.platforms.syncNow();
                    await refresh();
                    setLastSync(
                      new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
                    );
                  },
                  saved.demoMode ? '演示数据已同步。' : '本次同步已完成；未配置的数据源不会同步。',
                  '同步未完成，请检查登录状态、邮箱配置和网络后重试。'
                )
              }
            >
              {task.busy === 'sync' ? '正在同步…' : '立即同步'}
            </button>
          </div>
          {lastSync && <p className={styles.hint}>本页最近一次成功同步：{lastSync}</p>}
        </section>
        <section className={styles.section}>
          <h2>学生邮箱</h2>
          <p className={styles.hint}>
            在网页邮箱中开启 IMAP，并获取客户端专用密码。保存配置后，仍需通过「立即同步」验证收信。
          </p>
          <label>
            邮箱地址
            <input
              type="email"
              value={mail.user}
              onChange={(e) => {
                setMail({ ...mail, user: e.target.value });
                task.clear();
              }}
              placeholder="学号@m.fudan.edu.cn"
              autoComplete="off"
            />
          </label>
          <label>
            客户端专用密码
            <input
              type="password"
              value={password}
              onChange={(e) => {
                setPassword(e.target.value);
                task.clear();
              }}
              placeholder={
                states.some((p) => p.platform === 'mail' && p.status === 'ok')
                  ? '同一邮箱和服务器可留空保留密码'
                  : '请填写客户端专用密码'
              }
              autoComplete="off"
            />
          </label>
          <details>
            <summary>服务器与端口</summary>
            <div className={styles.grid}>
              <label>
                IMAP 服务器
                <input
                  value={mail.host}
                  onChange={(e) => setMail({ ...mail, host: e.target.value })}
                />
              </label>
              <label>
                IMAP 端口
                <input
                  type="number"
                  min={1}
                  max={65535}
                  value={Number.isNaN(mail.port) ? '' : mail.port}
                  onChange={(e) => setMail({ ...mail, port: e.target.valueAsNumber })}
                />
              </label>
            </div>
            <p className={styles.hint}>
              连接使用 TLS。默认服务器来自项目现有配置，可按学校邮箱实际要求修改。
            </p>
          </details>
          <div className={styles.actions}>
            <button
              type="button"
              className="primary"
              onClick={() =>
                void task.run(
                  'mail',
                  async () => {
                    const cfg = prepareMail(mail);
                    if (
                      !password.trim() &&
                      (needsMailPassword(saved.mail, cfg) ||
                        !states.some((p) => p.platform === 'mail' && p.status === 'ok'))
                    )
                      throw new Error(
                        '请重新填写客户端专用密码。更换邮箱、服务器、端口或密码状态未知时，不能沿用旧密码。'
                      );
                    await api.settings.set({ mail: cfg });
                    // 配置先保存；密码失败时保留输入供重试，不宣称保存完成。
                    if (password)
                      try {
                        await api.settings.setMailPassword(password);
                      } catch (error) {
                        await api.settings.set({ mail: saved.mail });
                        throw error;
                      }
                    const currentStates = await api.platforms.status();
                    setSaved({ ...saved, mail: cfg });
                    setMail(cfg);
                    setPassword('');
                    setStates(currentStates);
                  },
                  '邮箱配置已保存，尚未验证收信。'
                )
              }
            >
              {task.busy === 'mail' ? '正在保存…' : '保存邮箱配置'}
            </button>
          </div>
        </section>
      </fieldset>
      <Feedback {...task} />
    </>
  );
}
