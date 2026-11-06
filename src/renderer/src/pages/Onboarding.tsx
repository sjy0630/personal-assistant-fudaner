import { useEffect, useRef, useState } from 'react';
import type { ModelConfig, PlatformState, Profile, Settings } from '../../../shared/types';
import { api } from '../api';
import { finishOnboarding, modelProblem, validateModel } from './onboarding-state';
import styles from './Onboarding.module.css';

const STEPS = [
  { title: '连接模型', detail: '选择助理的思考方式' },
  { title: '连接校园', detail: '真实账号，或先体验演示' },
  { title: '认识你', detail: '从一个称呼开始' },
  { title: '认识助理', detail: '名字和说话方式，由你决定' },
];
const CLOUD_DEFAULT: ModelConfig = { baseURL: 'https://api.deepseek.com', model: 'deepseek-chat', apiKey: '' };
const LOCAL_DEFAULT: ModelConfig = { baseURL: 'http://127.0.0.1:11434/v1', model: 'qwen2.5:3b', apiKey: '' };
const STYLES = [
  { value: 'warm', label: '温和体贴', sample: '我们一起看看这周的安排，先把最着急的事理清楚。' },
  { value: 'concise', label: '简洁干练', sample: '先看这周的截止时间，再安排优先级。' },
  { value: 'playful', label: '轻松幽默', sample: '先把这周的 DDL 揪出来，一个一个搞定。' },
] as const;
const PLATFORM = { elearning: 'eLearning', icourse: 'iCourse', mail: '学生邮箱' };
const STATUS = { ok: '已连接', need_login: '需要登录', unavailable: '暂时不可用', not_configured: '未配置', demo: '演示数据' };

export function OnboardingPage({ onComplete, onClose }: { onComplete: () => void; onClose?: () => void }) {
  const [step, setStep] = useState(0);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [cloud, setCloud] = useState<ModelConfig>(CLOUD_DEFAULT);
  const [local, setLocal] = useState<ModelConfig>(LOCAL_DEFAULT);
  const [useLocal, setUseLocal] = useState(false);
  const [mode, setMode] = useState<'demo' | 'real'>('demo');
  const [platforms, setPlatforms] = useState<PlatformState[]>([]);
  const [mailUser, setMailUser] = useState('');
  const [mailPassword, setMailPassword] = useState('');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [test, setTest] = useState<Partial<Record<'cloud' | 'local', { ok: boolean; message: string }>>>({});
  const heading = useRef<HTMLHeadingElement>(null);
  const inFlight = useRef(false);

  const load = async () => {
    setError('');
    try {
      const [s, p] = await Promise.all([api.settings.get(), api.profile.get()]);
      setSettings(s); setProfile(p);
      setCloud(s.cloud ?? CLOUD_DEFAULT); setLocal(s.local ?? LOCAL_DEFAULT);
      setUseLocal(Boolean(s.local)); setMode(s.demoMode ? 'demo' : 'real'); setMailUser(s.mail?.user ?? '');
    } catch { setError('无法读取本机配置，请重试。已有配置不会被覆盖。'); }
  };
  useEffect(() => { void load(); }, []);
  useEffect(() => { heading.current?.focus(); }, [step, profile !== null]);
  useEffect(() => {
    let alive = true;
    const refresh = () => void api.platforms.status().then((s) => { if (alive) setPlatforms(s); }).catch(() => undefined);
    refresh();
    const off = api.on('platforms:changed', refresh);
    return () => { alive = false; off(); };
  }, []);

  const run = async (name: string, action: () => Promise<void>) => {
    if (inFlight.current) return;
    inFlight.current = true; setBusy(name); setError(''); setNotice('');
    try { await action(); }
    catch (err) { setError(err instanceof Error && err.message.startsWith('请') ? err.message : '操作未完成，请检查连接后重试。你的填写内容仍保留在这里。'); }
    finally { inFlight.current = false; setBusy(''); }
  };
  const editModel = (kind: 'cloud' | 'local', patch: Partial<ModelConfig>) => {
    (kind === 'cloud' ? setCloud : setLocal)((old) => ({ ...old, ...patch }));
    setTest((old) => ({ ...old, [kind]: undefined }));
    setError('');
  };
  const saveModel = async (kind: 'cloud' | 'local') => {
    const cfg = kind === 'cloud' ? cloud : local;
    const problem = validateModel(cfg);
    if (problem) throw new Error(problem);
    if (kind === 'cloud' && !cfg.apiKey.trim()) throw new Error('请填写 API Key，或选择稍后配置模型。');
    await api.settings.set({ [kind]: { ...cfg, baseURL: cfg.baseURL.trim().replace(/\/+$/, ''), model: cfg.model.trim(), apiKey: cfg.apiKey.trim() } });
  };
  const testModel = (kind: 'cloud' | 'local') => run(kind, async () => {
    await saveModel(kind);
    const result = await api.settings.testModel(kind);
    setTest((old) => ({ ...old, [kind]: { ok: result.ok, message: result.ok ? '连接成功，配置已保存。' : modelProblem(result.message) } }));
    // 取回遮罩值，避免在后续步骤中一直保留用户输入的明文密钥。
    const saved = await api.settings.get();
    if (kind === 'cloud' && saved.cloud) setCloud(saved.cloud);
    if (kind === 'local' && saved.local) setLocal(saved.local);
  });
  const go = (next: number) => { setError(''); setNotice(''); setStep(next); };
  const next = () => run('next', async () => {
    if (step === 0) {
      if (cloud.apiKey.trim() || !useLocal) await saveModel('cloud');
      if (useLocal) await saveModel('local');
    }
    if (step === 1) {
      await api.settings.set({ demoMode: mode === 'demo' });
      if (mode === 'demo') await api.platforms.syncNow();
    }
    if (step === 3 && profile) { await finishOnboarding(api, profile); onComplete(); }
    else go(step + 1);
  });

  const modelFields = (kind: 'cloud' | 'local', cfg: ModelConfig) => (
    <div className={styles.fields}>
      <label>服务地址（Base URL）<input type="url" value={cfg.baseURL} onChange={(e) => editModel(kind, { baseURL: e.target.value })} spellCheck={false} autoComplete="off" /></label>
      <label>模型名<input value={cfg.model} onChange={(e) => editModel(kind, { model: e.target.value })} spellCheck={false} autoComplete="off" /></label>
      <label>{kind === 'cloud' ? 'API Key' : 'API Key（本地服务通常不需要）'}<input type="password" value={cfg.apiKey} onChange={(e) => editModel(kind, { apiKey: e.target.value })} autoComplete="off" spellCheck={false} /></label>
      <div className={styles.inline}><button type="button" onClick={() => void testModel(kind)}>{busy === kind ? '正在测试…' : '保存并测试连接'}</button><span className={styles.hint}>{test[kind] ? '' : '尚未测试当前配置'}</span></div>
      {test[kind] && <p role="status" className={test[kind]?.ok ? styles.success : styles.error}>{test[kind]?.message}</p>}
    </div>
  );

  if (!settings || !profile) return <main className={styles.loading} aria-busy={!error}><h1>准备认识你的助理</h1>{error ? <><p role="alert">{error}</p><button onClick={() => void load()}>重新读取配置</button></> : <p>正在读取本机配置…</p>}</main>;

  return (
    <main className={styles.root}>
      <aside className={styles.sidebar}>
        <div className={styles.brand}>Fudaner</div>
        <p className={styles.tagline}>懂复旦，也慢慢懂你。</p>
        <nav aria-label="首次使用进度"><ol className={styles.steps}>{STEPS.map((s, index) => (
          <li key={s.title} aria-current={index === step ? 'step' : undefined} className={index === step ? styles.current : index < step ? styles.done : ''}>
            <span className={styles.number} aria-hidden="true">{index < step ? '✓' : index + 1}</span><div><strong>{s.title}</strong><span>{s.detail}</span></div>
          </li>
        ))}</ol></nav>
        <p className={styles.footnote}>学生自制，非官方产品。<br />账号、模型与偏好，之后都可以在设置中调整。</p>
      </aside>
      <div className={styles.main}>
        <div className={styles.topline}><span>首次使用 · 第 {step + 1} 步，共 4 步</span>{onClose && <button className="ghost" disabled={!!busy} onClick={onClose}>返回设置</button>}</div>
        <form className={styles.form} noValidate onSubmit={(e) => { e.preventDefault(); void next(); }}>
          <header className={styles.header}>
            <h1 ref={heading} tabIndex={-1}>{['让助理开始思考', '把校园里的事接进来', '先认识一下你', '最后，认识你的助理'][step]}</h1>
            <p>{['使用自己的模型服务，或先体验无需模型的演示。', '连接复旦账号，也可以用虚构数据体验整个流程。', '这些信息能帮助助理理解你。现在不填也没关系。', '选一个顺口的名字，和一种聊起来舒服的方式。'][step]}</p>
          </header>
          <fieldset className={styles.body} disabled={!!busy}>
            {step === 0 && <>
              <div className={styles.sectionHead}><h2>云端模型</h2>{settings.cloud && <span className={styles.hint}>已带入本机配置</span>}</div>
              <p className={styles.description}>支持 OpenAI 兼容服务。通过第三方网关接入时，请使用网关提供的地址和模型名。</p>
              {modelFields('cloud', cloud)}
              <details className={styles.local} open={useLocal} onToggle={(e) => setUseLocal(e.currentTarget.open)}>
                <summary>本地模型（可选）</summary><p className={styles.description}>已安装 Ollama 时可以配置；无需为体验引导专门安装。隐私任务的云端授权沿用你在设置里的选择。</p>
                {modelFields('local', local)}
              </details>
              <p className={styles.note}>密钥保存在本机配置中，不会上传到项目仓库。测试连接会向你填写的服务发送一条简短问候。</p>
            </>}
            {step === 1 && <>
              <div className={styles.choices} role="radiogroup" aria-label="校园数据来源">
                <label className={mode === 'demo' ? styles.selected : ''}><input type="radio" name="mode" checked={mode === 'demo'} onChange={() => { setMode('demo'); setNotice(''); }} /><strong>先体验演示</strong><span>使用虚构课程、作业和邮件，不需要校园账号。已配置的模型仍可使用。</span></label>
                <label className={mode === 'real' ? styles.selected : ''}><input type="radio" name="mode" checked={mode === 'real'} onChange={() => { setMode('real'); setNotice(''); }} /><strong>连接我的校园账号</strong><span>通过复旦统一身份认证登录，邮箱单独配置，也可以稍后再连接。</span></label>
              </div>
              {mode === 'demo' ? <p className={styles.note}>接下来会同步内置演示数据。选择演示不会删除已有数据；真实接入前可在设置中管理数据。</p> : <>
                <h2>复旦统一身份认证</h2><p className={styles.description}>在弹出的官方登录页面中自行输入账号密码。应用不读取或保存 UIS 密码。</p>
                <div className={styles.platforms}>{platforms.filter((p) => p.platform !== 'mail').map((p) => <div key={p.platform}><strong>{PLATFORM[p.platform]}</strong><span>{p.status === 'demo' ? '当前使用演示数据，尚未验证真实连接' : STATUS[p.status]}</span></div>)}</div>
                <button type="button" onClick={() => void run('login', async () => { await api.settings.set({ demoMode: false }); await api.platforms.login(); setPlatforms(await api.platforms.status()); setNotice('登录窗口已结束，请查看上方连接状态；未完成时可以重新登录。'); })}>{busy === 'login' ? '等待你完成登录…' : '登录复旦账号'}</button>
                <details className={styles.local}><summary>配置学生邮箱（可稍后完成）</summary>
                  <p className={styles.description}>需先在网页邮箱开启 IMAP，并获取客户端专用密码。</p>
                  <label>邮箱地址<input type="email" value={mailUser} onChange={(e) => setMailUser(e.target.value)} placeholder="学号@m.fudan.edu.cn" autoComplete="off" /></label>
                  <label>客户端专用密码<input type="password" value={mailPassword} onChange={(e) => setMailPassword(e.target.value)} autoComplete="off" /></label>
                  <button type="button" onClick={() => void run('mail', async () => {
                    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(mailUser.trim())) throw new Error('请填写有效的邮箱地址。');
                    if (!mailPassword.trim()) throw new Error('请填写邮箱的客户端专用密码。');
                    await api.settings.set({ mail: { host: settings.mail?.host || 'imap.exmail.qq.com', port: settings.mail?.port || 993, user: mailUser.trim() } });
                    await api.settings.setMailPassword(mailPassword); setMailPassword(''); setNotice('邮箱配置已保存，尚未验证收信。之后可在设置中同步检查。');
                  })}>{busy === 'mail' ? '正在保存…' : '保存邮箱配置'}</button>
                </details>
              </>}
            </>}
            {step === 2 && <>
              <div className={styles.profileGrid}>
                <label>怎么称呼你<input value={profile.nickname ?? ''} onChange={(e) => setProfile({ ...profile, nickname: e.target.value })} placeholder="你的昵称" maxLength={40} /></label>
                <label>院系<input value={profile.school ?? ''} onChange={(e) => setProfile({ ...profile, school: e.target.value })} placeholder="例如：计算与智能创新学院" /></label>
                <label>年级<input value={profile.grade ?? ''} onChange={(e) => setProfile({ ...profile, grade: e.target.value })} placeholder="例如：2024 级" /></label>
                <label>学历<select value={profile.degree ?? ''} onChange={(e) => setProfile({ ...profile, degree: e.target.value as Profile['degree'] || undefined })}><option value="">暂不填写</option><option>本科</option><option>硕士</option><option>博士</option></select></label>
              </div>
              <label>一句话介绍自己<textarea rows={3} value={profile.freeText ?? ''} onChange={(e) => setProfile({ ...profile, freeText: e.target.value })} placeholder="比如最近在准备什么，或希望助理帮你留意什么。" /></label>
              <p className={styles.note}>画像保存在本机。你可以随时在「设置 → 关于我」修改；使用云端对话时，相关画像可能作为上下文发送给你选择的模型服务。</p>
            </>}
            {step === 3 && <>
              <label>助理的名字<input value={profile.assistantName} onChange={(e) => setProfile({ ...profile, assistantName: e.target.value })} maxLength={30} placeholder="旦旦" required /></label>
              <h2>喜欢怎样聊天</h2>
              <div className={styles.styleChoices} role="radiogroup" aria-label="助理说话风格">{STYLES.map((s) => <label key={s.value} className={profile.style === s.value ? styles.selected : ''}><input type="radio" name="style" checked={profile.style === s.value} onChange={() => setProfile({ ...profile, style: s.value })} />{s.label}</label>)}</div>
              <div className={styles.preview} aria-live="polite"><strong>{profile.assistantName.trim() || '旦旦'}</strong><p>{STYLES.find((s) => s.value === profile.style)?.sample}</p><span>语气示例，不是模型生成结果</span></div>
              <p className={styles.note}>准备好后，可以问「这周有什么 DDL？」或「有哪些邮件要回？」。{mode === 'demo' ? '校园内容将使用演示数据。' : '校园内容需在账号连接成功后同步。'}</p>
            </>}
          </fieldset>
          {error && <p className={styles.error} role="alert">{error}</p>}
          {notice && <p className={styles.success} role="status">{notice}</p>}
          <footer className={styles.footer}>
            <div>{step > 0 && <button type="button" disabled={!!busy} onClick={() => go(step - 1)}>上一步</button>}</div>
            <div className={styles.inline}>
              {step === 0 && <button className="ghost" type="button" disabled={!!busy} onClick={() => go(1)}>稍后配置模型</button>}
              <button className="primary" type="submit" disabled={!!busy || (step === 3 && !profile.assistantName.trim())}>{busy === 'next' ? '正在保存…' : step === 3 ? '开始和助理聊聊' : '保存并继续'}</button>
            </div>
          </footer>
        </form>
      </div>
    </main>
  );
}
