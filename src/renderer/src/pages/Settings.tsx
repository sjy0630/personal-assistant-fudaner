import { useEffect, useState } from 'react';
import type { Memory, ModelConfig, PlatformState, Profile, Settings } from '../../../shared/types';
import { DecisionsTab } from './Decisions';
import { api } from '../api';

type Tab = 'model' | 'accounts' | 'me' | 'assistant' | 'decisions' | 'dev';
const TABS: { key: Tab; label: string }[] = [
  { key: 'model', label: '模型' },
  { key: 'accounts', label: '复旦账号' },
  { key: 'me', label: '关于我' },
  { key: 'assistant', label: '助理' },
  { key: 'decisions', label: '主动决策' },
  { key: 'dev', label: '开发者' },
];

export function SettingsPage() {
  const [tab, setTab] = useState<Tab>('model');
  return (
    <div className="page">
      <header className="page-header"><h1>设置</h1></header>
      <div className="filters">{TABS.map((t) => <button key={t.key} className={tab === t.key ? 'chip active' : 'chip'} onClick={() => setTab(t.key)}>{t.label}</button>)}</div>
      <div className="settings-body">
        {tab === 'model' && <ModelTab />}
        {tab === 'accounts' && <AccountsTab />}
        {tab === 'me' && <MeTab />}
        {tab === 'assistant' && <AssistantTab />}
        {tab === 'decisions' && <DecisionsTab />}
        {tab === 'dev' && <DevTab />}
      </div>
    </div>
  );
}

const PRESETS = [
  { name: 'DeepSeek', baseURL: 'https://api.deepseek.com', model: 'deepseek-chat' },
  { name: '通义千问', baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus' },
  { name: 'Kimi', baseURL: 'https://api.moonshot.cn/v1', model: 'kimi-latest' },
  { name: '智谱 GLM', baseURL: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4-plus' },
];

/** 模型（PRD §6）：云端 BYOK + 本地模型 */
function ModelTab() {
  const [s, setS] = useState<Settings | null>(null);
  const [msg, setMsg] = useState<Record<string, string>>({});
  useEffect(() => void api.settings.get().then(setS), []);
  if (!s) return null;
  const edit = (k: 'cloud' | 'local', patch: Partial<ModelConfig>) => setS({ ...s, [k]: { baseURL: '', apiKey: '', model: '', ...s[k], ...patch } });
  const save = async (k: 'cloud' | 'local') => {
    await api.settings.set({ [k]: s[k] });
    const r = await api.settings.testModel(k);
    setMsg({ ...msg, [k]: (r.ok ? '✅ ' : '❌ ') + r.message });
  };
  return (
    <>
      <section className="card-box">
        <h3>云端模型（你自己的 API Key）</h3>
        <p className="muted">用于对话、规划、后台工单。Key 只保存在本机。</p>
        <div className="filters">{PRESETS.map((p) => <button key={p.name} className="chip" onClick={() => edit('cloud', { baseURL: p.baseURL, model: p.model })}>{p.name}</button>)}</div>
        <label>Base URL<input value={s.cloud?.baseURL ?? ''} onChange={(e) => edit('cloud', { baseURL: e.target.value })} /></label>
        <label>模型名<input value={s.cloud?.model ?? ''} onChange={(e) => edit('cloud', { model: e.target.value })} /></label>
        <label>API Key<input type="password" value={s.cloud?.apiKey ?? ''} onChange={(e) => edit('cloud', { apiKey: e.target.value })} /></label>
        <button className="primary" onClick={() => void save('cloud')}>保存并测试</button> <span>{msg.cloud}</span>
      </section>
      <section className="card-box">
        <h3>本地模型（可选，Ollama）</h3>
        <p className="muted">用于邮件分类、记忆提取、主动研判等隐私任务，内容不出本机。</p>
        <div className="filters"><button className="chip" onClick={() => edit('local', { baseURL: 'http://127.0.0.1:11434/v1', model: 'qwen2.5:7b' })}>Ollama 默认</button></div>
        <label>Base URL<input value={s.local?.baseURL ?? ''} onChange={(e) => edit('local', { baseURL: e.target.value })} /></label>
        <label>模型名<input value={s.local?.model ?? ''} onChange={(e) => edit('local', { model: e.target.value })} /></label>
        <button className="primary" onClick={() => void save('local')}>保存并测试</button> <span>{msg.local}</span>
        <label className="check"><input type="checkbox" checked={!!s.allowSensitiveToCloud} onChange={async (e) => { await api.settings.set({ allowSensitiveToCloud: e.target.checked }); setS({ ...s, allowSensitiveToCloud: e.target.checked }); }} />
          本地模型不可用时，允许把邮件等隐私任务交给云端模型</label>
      </section>
    </>
  );
}

const STATUS: Record<PlatformState['status'], string> = { ok: '✅ 已连接', need_login: '⚠️ 需要登录', unavailable: '❌ 不可用', not_configured: '未配置', demo: '🧪 演示模式' };

/** 复旦账号（PRD §7.3）：一次 UIS 登录，各平台共用 */
function AccountsTab() {
  const [states, setStates] = useState<PlatformState[]>([]);
  const [s, setS] = useState<Settings | null>(null);
  const [pw, setPw] = useState('');
  const load = () => { void api.platforms.status().then(setStates); void api.settings.get().then(setS); };
  useEffect(() => { load(); return api.on('platforms:changed', load); }, []);
  return (
    <>
      <section className="card-box">
        <h3>复旦统一身份认证（UIS）</h3>
        <p className="muted">在弹出的窗口里自己登录一次，eLearning、iCourse 都会共用这个登录状态。Fudaner 不读取、不保存你的密码。</p>
        {states.map((p) => <div key={p.platform} className="row"><strong>{p.platform}</strong> {STATUS[p.status]}</div>)}
        <button className="primary" onClick={() => void api.platforms.login().then(load)}>登录复旦账号</button>{' '}
        <button onClick={() => void api.platforms.syncNow().then(load)}>立即同步</button>
      </section>
      <section className="card-box">
        <h3>学生邮箱（IMAP，只读）</h3>
        <p className="muted">需要在网页邮箱设置里开启 IMAP，并生成「客户端专用密码」。密码加密保存在本机。</p>
        <label>邮箱地址<input value={s?.mail?.user ?? ''} placeholder="学号@m.fudan.edu.cn" onChange={(e) => s && setS({ ...s, mail: { host: 'imap.exmail.qq.com', port: 993, ...s.mail, user: e.target.value } })} /></label>
        <label>客户端专用密码<input type="password" value={pw} onChange={(e) => setPw(e.target.value)} /></label>
        <button className="primary" onClick={async () => { if (s?.mail) await api.settings.set({ mail: s.mail }); if (pw) await api.settings.setMailPassword(pw); setPw(''); load(); }}>保存</button>
      </section>
    </>
  );
}

const MEM_TYPE: Record<Memory['type'], string> = { preference: '偏好', schedule: '固定安排', goal: '目标', person: '人物', status: '近况', interest: '兴趣' };

/** 关于我（PRD §5.6）：画像 + 记忆，全部可见可改 */
function MeTab() {
  const [p, setP] = useState<Profile | null>(null);
  const [mems, setMems] = useState<Memory[]>([]);
  const [newMem, setNewMem] = useState('');
  const [newType, setNewType] = useState<Memory['type']>('preference');
  const load = () => { void api.profile.get().then(setP); void api.memory.list().then(setMems); };
  useEffect(load, []);
  if (!p) return null;
  const field = (k: keyof Profile, label: string) => (
    <label>{label}<input value={(p[k] as string) ?? ''} onChange={(e) => setP({ ...p, [k]: e.target.value })} onBlur={() => void api.profile.set({ [k]: p[k] })} /></label>
  );
  return (
    <>
      <section className="card-box">
        <h3>画像</h3>
        {field('nickname', '昵称')}{field('school', '院系')}{field('grade', '年级')}{field('freeText', '一句话介绍自己')}
      </section>
      <section className="card-box">
        <h3>旦旦记住的事（{mems.length}）</h3>
        <p className="muted">只存在本机。你可以随时修改或删除。</p>
        {mems.map((m) => (
          <div key={m.id} className="row mem">
            <span className="tag">{MEM_TYPE[m.type]}</span>
            <input defaultValue={m.content} onBlur={(e) => e.target.value !== m.content && void api.memory.update(m.id, e.target.value)} />
            <span className="muted">{m.source === 'chat' ? '对话中' : m.source === 'feedback' ? '反馈' : '手动'}</span>
            <button className="ghost" onClick={() => void api.memory.remove(m.id).then(load)}>删除</button>
          </div>
        ))}
        <div className="row">
          <select value={newType} onChange={(e) => setNewType(e.target.value as Memory['type'])}>{Object.entries(MEM_TYPE).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
          <input value={newMem} placeholder="手动添加一条记忆" onChange={(e) => setNewMem(e.target.value)} />
          <button onClick={() => newMem && void api.memory.add(newMem, newType).then(() => { setNewMem(''); load(); })}>添加</button>
        </div>
      </section>
    </>
  );
}

function AssistantTab() {
  const [p, setP] = useState<Profile | null>(null);
  useEffect(() => void api.profile.get().then(setP), []);
  if (!p) return null;
  const set = (patch: Partial<Profile>) => { setP({ ...p, ...patch }); void api.profile.set(patch); };
  return (
    <section className="card-box">
      <label>助理名字<input value={p.assistantName} onChange={(e) => set({ assistantName: e.target.value })} /></label>
      <h3>说话风格</h3>
      <div className="filters">{([['warm', '温和体贴'], ['concise', '简洁干练'], ['playful', '轻松幽默']] as const).map(([k, v]) => <button key={k} className={p.style === k ? 'chip active' : 'chip'} onClick={() => set({ style: k })}>{v}</button>)}</div>
      <h3>主动程度（每日注意力预算）</h3>
      <div className="filters">{([['low', '少'], ['medium', '中'], ['high', '多']] as const).map(([k, v]) => <button key={k} className={p.proactivity === k ? 'chip active' : 'chip'} onClick={() => set({ proactivity: k })}>{v}</button>)}</div>
    </section>
  );
}

/** 开发者 / 演示工具 */
function DevTab() {
  const [s, setS] = useState<Settings | null>(null);
  const [busy, setBusy] = useState('');
  useEffect(() => void api.settings.get().then(setS), []);
  const run = async (label: string, fn: () => Promise<void>) => { setBusy(label); try { await fn(); } finally { setBusy(''); } };
  return (
    <section className="card-box">
      <label className="check"><input type="checkbox" checked={!!s?.demoMode} onChange={async (e) => { await api.settings.set({ demoMode: e.target.checked }); setS(await api.settings.get()); }} />
        演示模式（使用内置的虚构数据，不需要复旦账号；切换后重启应用生效最佳）</label>
      <div className="dev-buttons">
        <button onClick={() => void run('tick', api.dev.tick)}>同步 + 运行一次主动引擎</button>
        <button onClick={() => void run('mail', api.dev.demoNewMail)}>演示：助教发来 Lab 5 补充邮件</button>
        <button onClick={() => void run('submit', api.dev.demoSubmitNext)}>演示：在 eLearning 上交掉最近的作业</button>
        <button onClick={() => void run('pre', () => api.dev.setDemoPhase('pre_exam'))}>演示：切换到「考试周前」</button>
        <button onClick={() => void run('reset', () => api.dev.setDemoPhase(''))}>恢复真实校历</button>
        <button className="danger" onClick={() => window.confirm('清除所有本地数据？此操作不可撤销') && void run('wipe', api.dev.wipe)}>清除所有数据</button>
      </div>
      {busy && <div className="muted">执行中…</div>}
    </section>
  );
}
