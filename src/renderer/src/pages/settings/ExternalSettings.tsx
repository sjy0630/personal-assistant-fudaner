import { useEffect, useState } from 'react';
import type { ExternalMcpConfig, ExternalMcpStatus } from '../../../../shared/types';
import { api } from '../../api';
import { Feedback, Loading, same, useLoad, useTask, type PanelProps } from './support';
import styles from './Settings.module.css';

type Preset = Awaited<ReturnType<typeof api.external.presets>>[number];

const STATE: Record<ExternalMcpStatus['state'], string> = { off: '未启用', connecting: '正在连接…', ok: '已连接', error: '连接失败' };

/** 设置 → 扩展服务：接入同学们做好的复旦 MCP 服务 */
export function ExternalSettings({ onDirty, onBusy }: PanelProps) {
  const loaded = useLoad(async () => ({ presets: await api.external.presets(), settings: await api.settings.get(), status: await api.external.status() }));
  const [presets, setPresets] = useState<Preset[]>([]);
  const [configs, setConfigs] = useState<ExternalMcpConfig[]>([]);
  const [saved, setSaved] = useState<ExternalMcpConfig[] | null>(null);
  const [status, setStatus] = useState<ExternalMcpStatus[]>([]);
  const [custom, setCustom] = useState({ name: '', command: '', args: '', cwd: '', allowAll: false });
  const task = useTask(onBusy);

  useEffect(() => {
    if (!loaded.value) return;
    setPresets(loaded.value.presets);
    // 每个预设都有一行配置（没保存过的默认关闭）
    const existing = loaded.value.settings.externalMcp ?? [];
    const rows = [
      ...loaded.value.presets.map((p) => existing.find((c) => c.preset === p.preset) ?? { id: p.preset, preset: p.preset as ExternalMcpConfig['preset'], name: p.name, enabled: false }),
      ...existing.filter((c) => c.preset === 'custom'),
    ];
    setConfigs(rows);
    setSaved(rows);
    setStatus(loaded.value.status);
  }, [loaded.value]);
  useEffect(() => onDirty(saved !== null && !same(configs, saved)), [configs, saved, onDirty]);
  useEffect(() => {
    const off = api.on('platforms:changed', () => { void api.external.status().then(setStatus).catch(() => undefined); });
    return off;
  }, []);
  if (!saved) return <Loading error={loaded.error} retry={loaded.retry} />;

  const update = (id: string, patch: Partial<ExternalMcpConfig>) => setConfigs(configs.map((c) => (c.id === id ? { ...c, ...patch } : c)));
  const statusOf = (id: string) => status.find((s) => s.id === id);
  const save = (next = configs) => task.run('save', async () => {
    const result = await api.external.save(next);
    setStatus(result);
    setConfigs(next);
    setSaved(next);
    const failed = result.filter((s) => s.state === 'error');
    if (failed.length) throw new Error(`请检查：${failed.map((s) => `${s.name}（${s.error}）`).join('；')}`);
  }, '已保存。已连接的服务可以直接在对话里使用。', '保存失败，请重试。');

  const statusLine = (c: ExternalMcpConfig) => {
    const s = statusOf(c.id);
    if (!s || !c.enabled) return null;
    return (
      <p className={styles.hint}>
        状态：{STATE[s.state]}{s.state === 'ok' ? ` · 开放 ${s.tools.length} 个工具：${s.tools.join('、')}` : ''}
        {s.blocked.length > 0 ? ` · 未开放（可能修改数据）：${s.blocked.join('、')}` : ''}
        {s.error ? ` · ${s.error}` : ''}
      </p>
    );
  };

  return (
    <fieldset className={styles.form} disabled={!!task.busy}>
      <section className={styles.section}>
        <h2>扩展服务</h2>
        <p className={styles.hint}>
          接入复旦同学在 GitHub 上做好的其他 MCP 服务，旦旦就能在对话里直接用。树洞与旦克、图书馆文献检索、宿舍电量已经内置，不用在这里安装。这些服务在你的电脑上单独运行，账号由它们自己保存，Fudaner 不经手；只开放查询类工具，预约、发帖这类会修改数据的工具不会开放。它们是社区项目，不是 Fudaner 或学校官方的服务。
        </p>
      </section>

      {presets.map((p) => {
        const c = configs.find((x) => x.preset === p.preset)!;
        return (
          <section className={styles.section} key={p.preset}>
            <h2>{p.name}</h2>
            <p className={styles.hint}>{p.summary}</p>
            <p className={styles.hint}>来源：<a href={p.repo} target="_blank" rel="noreferrer">{p.repo.replace('https://github.com/', '')}</a> · 协议：{p.license}</p>
            <details>
              <summary>使用前的准备</summary>
              <ol className={styles.hint}>{p.setup.map((s) => <li key={s}>{s}</li>)}</ol>
            </details>
            {p.needsDir && (
              <label>
                文件夹路径
                <input value={c.dir ?? ''} placeholder={p.dirHint} onChange={(e) => update(c.id, { dir: e.target.value })} />
              </label>
            )}
            <label className={styles.check}>
              <input type="checkbox" checked={c.enabled} onChange={(e) => update(c.id, { enabled: e.target.checked })} />
              启用
            </label>
            {statusLine(c)}
          </section>
        );
      })}

      <section className={styles.section}>
        <h2>自定义服务</h2>
        <p className={styles.hint}>其他 stdio 方式的 MCP 服务。默认只开放服务自己标为只读的工具。只添加你信任的程序：它会以你的身份在本机运行。</p>
        {configs.filter((c) => c.preset === 'custom').map((c) => (
          <div className={styles.statusRow} key={c.id}>
            <div>
              <strong>{c.name}</strong>
              <p className={styles.hint}>{[c.command, ...(c.args ?? [])].join(' ')}{c.allowAllTools ? ' · 开放全部工具' : ''}</p>
              {statusLine(c)}
            </div>
            <div className={styles.actions}>
              <label className={styles.check}><input type="checkbox" checked={c.enabled} onChange={(e) => update(c.id, { enabled: e.target.checked })} />启用</label>
              <button type="button" onClick={() => setConfigs(configs.filter((x) => x.id !== c.id))}>移除</button>
            </div>
          </div>
        ))}
        <div className={styles.grid}>
          <label>名称<input value={custom.name} placeholder="例如：我的课表服务" onChange={(e) => setCustom({ ...custom, name: e.target.value })} /></label>
          <label>启动命令<input value={custom.command} placeholder="例如：uvx 或 /usr/local/bin/node" onChange={(e) => setCustom({ ...custom, command: e.target.value })} /></label>
          <label>参数（空格分隔）<input value={custom.args} placeholder="例如：my-mcp-server --stdio" onChange={(e) => setCustom({ ...custom, args: e.target.value })} /></label>
          <label>工作目录（可选）<input value={custom.cwd} onChange={(e) => setCustom({ ...custom, cwd: e.target.value })} /></label>
        </div>
        <label className={styles.check}>
          <input type="checkbox" checked={custom.allowAll} onChange={(e) => setCustom({ ...custom, allowAll: e.target.checked })} />
          开放全部工具（包括可能修改数据的工具，确认这个服务可信时才勾选）
        </label>
        <div className={styles.actions}>
          <button type="button" disabled={!custom.name.trim() || !custom.command.trim()} onClick={() => {
            const id = `custom-${Date.now().toString(36)}`;
            setConfigs([...configs, { id, preset: 'custom', name: custom.name.trim(), enabled: true, command: custom.command.trim(), args: custom.args.trim() ? custom.args.trim().split(/\s+/) : [], cwd: custom.cwd.trim() || undefined, allowAllTools: custom.allowAll }]);
            setCustom({ name: '', command: '', args: '', cwd: '', allowAll: false });
          }}>添加到列表</button>
        </div>
      </section>

      <section className={styles.section}>
        <div className={styles.actions}>
          <button type="button" className="primary" onClick={() => void save()}>{task.busy === 'save' ? '正在连接…（第一次可能要一两分钟）' : '保存并连接'}</button>
          <button type="button" onClick={() => void save(saved)}>重新连接</button>
        </div>
        <Feedback notice={task.notice} error={task.error} clear={task.clear} />
      </section>
    </fieldset>
  );
}
