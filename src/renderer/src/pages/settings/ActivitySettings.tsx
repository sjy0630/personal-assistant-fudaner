import { useEffect, useState } from 'react';
import type { FeedSource, Item, Settings } from '../../../../shared/types';
import { api } from '../../api';
import { Feedback, Loading, same, useLoad, useTask, type PanelProps } from './support';
import styles from './Settings.module.css';

/** 校园活动：导入公众号文章链接、管理 RSS 订阅源、查看接下来的活动 */
export function ActivitySettings({ onDirty, onBusy }: PanelProps) {
  const loaded = useLoad(async () => ({ settings: await api.settings.get(), upcoming: await api.activities.list(14) }));
  const [saved, setSaved] = useState<Settings | null>(null);
  const [feeds, setFeeds] = useState<FeedSource[]>([]);
  const [draft, setDraft] = useState({ url: '', name: '' });
  const [link, setLink] = useState('');
  const [upcoming, setUpcoming] = useState<Item[]>([]);
  const task = useTask(onBusy);
  useEffect(() => {
    if (loaded.value) {
      setSaved(loaded.value.settings);
      setFeeds(loaded.value.settings.feeds ?? []);
      setUpcoming(loaded.value.upcoming);
    }
  }, [loaded.value]);
  useEffect(() => onDirty(saved !== null && (!same(feeds, saved.feeds ?? []) || !!draft.url)), [feeds, saved, draft.url, onDirty]);
  if (!saved) return <Loading error={loaded.error} retry={loaded.retry} />;
  const reload = async () => setUpcoming(await api.activities.list(14));

  const addFeed = () => {
    const url = draft.url.trim();
    if (!/^https?:\/\//i.test(url)) return;
    if (!feeds.some((f) => f.url === url)) setFeeds([...feeds, { url, name: draft.name.trim() || undefined }]);
    setDraft({ url: '', name: '' });
  };

  return (
    <fieldset className={styles.form} disabled={!!task.busy}>
      <section className={styles.section}>
        <h2>导入文章</h2>
        <p className={styles.hint}>
          粘贴一篇公众号文章或学校网页的链接，旦旦会读出里面的活动时间、地点和报名方式，按你的兴趣决定要不要推荐。也可以直接把链接发到对话里。
        </p>
        <label>
          文章链接
          <input value={link} placeholder="https://mp.weixin.qq.com/s/……" onChange={(e) => setLink(e.target.value)} />
        </label>
        <div className={styles.actions}>
          <button
            type="button"
            className="primary"
            disabled={!/^https?:\/\//i.test(link.trim())}
            onClick={() => void task.run('import', async () => {
              const r = await api.activities.import(link.trim());
              setLink('');
              await reload();
              if (!r.activities.length) throw new Error(`请注意：「${r.title}」里没有找到还会举办的活动（可能是活动回顾或新闻）。`);
            }, '已导入，相关活动会出现在下方列表和「动态」里。', '导入失败，请检查链接和网络后重试。')}
          >
            {task.busy === 'import' ? '正在读取…' : '导入'}
          </button>
        </div>
      </section>

      <section className={styles.section}>
        <h2>订阅源</h2>
        <p className={styles.hint}>
          添加 RSS / Atom 订阅地址，旦旦每 30 分钟检查一次新文章。公众号可以用 WeWe RSS 等工具转成 RSS（需要自己部署，使用微信读书账号，请留意账号风险）；部分学校和院系网站也提供订阅地址。应用本身不登录微信。
        </p>
        {feeds.length > 0 && (
          <div className={styles.statusRows}>
            {feeds.map((f) => (
              <div className={styles.statusRow} key={f.url}>
                <div>
                  <strong>{f.name || new URL(f.url).hostname}</strong>
                  <p className={styles.hint}>{f.url}</p>
                </div>
                <button type="button" onClick={() => setFeeds(feeds.filter((x) => x.url !== f.url))}>移除</button>
              </div>
            ))}
          </div>
        )}
        <div className={styles.grid}>
          <label>
            订阅地址
            <input value={draft.url} placeholder="https://……/feed.xml" onChange={(e) => setDraft({ ...draft, url: e.target.value })} />
          </label>
          <label>
            名称（可选）
            <input value={draft.name} placeholder="例如：某学院公众号" onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
          </label>
        </div>
        <div className={styles.actions}>
          <button type="button" disabled={!/^https?:\/\//i.test(draft.url.trim())} onClick={addFeed}>添加到列表</button>
          <button
            type="button"
            className="primary"
            disabled={same(feeds, saved.feeds ?? []) && !draft.url}
            onClick={() => void task.run('save', async () => {
              const url = draft.url.trim();
              const next = url && /^https?:\/\//i.test(url) && !feeds.some((f) => f.url === url) ? [...feeds, { url, name: draft.name.trim() || undefined }] : feeds;
              await api.settings.set({ feeds: next });
              setFeeds(next);
              setDraft({ url: '', name: '' });
              setSaved({ ...saved, feeds: next });
            })}
          >
            保存订阅源
          </button>
          <button
            type="button"
            onClick={() => void task.run('sync', async () => {
              const r = await api.activities.syncFeeds();
              await reload();
              if (r.errors.length) throw new Error(`请检查订阅地址：${r.errors.slice(0, 3).join('；')}`);
            }, '已检查所有订阅源。', '同步失败，请检查网络后重试。')}
          >
            {task.busy === 'sync' ? '正在检查…' : '立即检查'}
          </button>
        </div>
        {saved.demoMode && <p className={styles.hint}>演示模式下使用内置的虚构活动，不读取上面的订阅源。</p>}
      </section>

      <section className={styles.section}>
        <h2>接下来两周的活动（{upcoming.length}）</h2>
        {upcoming.length === 0 && <p className={styles.hint}>还没有活动。导入一篇文章或添加订阅源试试。</p>}
        <div className={styles.statusRows}>
          {upcoming.map((i) => (
            <div className={styles.statusRow} key={i.id}>
              <div>
                <strong>{i.title}</strong>
                <p className={styles.hint}>
                  {[i.activity?.startsAt ? new Date(i.activity.startsAt).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', weekday: 'short', hour: '2-digit', minute: '2-digit' }) : i.activity?.timeText,
                    i.activity?.location, i.activity?.sourceName].filter(Boolean).join(' · ')}
                </p>
              </div>
              {i.activity?.category && <span className={styles.badge}>{i.activity.category}</span>}
            </div>
          ))}
        </div>
      </section>
      <Feedback notice={task.notice} error={task.error} clear={task.clear} />
    </fieldset>
  );
}
