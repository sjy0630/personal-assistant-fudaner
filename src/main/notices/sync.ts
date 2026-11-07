import type { Item } from '../../shared/types';
import type { Repo } from '../db/repo';
import type { ModelRouter } from '../ai/llm';
import { isWechatArticle, parseArticle, shanghai } from '../activities/article';
import { extractActivities } from '../activities/extract';
import { saveActivities, type FetchText } from '../activities/sync';
import { defaultNoticeSources, findNoticeSource, NOTICE_SOURCES, ownSchoolSources, suggestNoticeSources, type NoticeSource } from './sources';
import { parseNoticeDetail, parseNoticeList, type NoticeLink } from './parse';

const DAY = 86_400_000;
/** 讲座、宣讲会这类通知同时当作活动提取（时间、地点、报名） */
const ACTIVITY_TITLE = /讲座|报告会|学术报告|宣讲会|论坛|沙龙|工作坊|workshop|seminar|lecture|比赛|大赛|竞赛|音乐会|演出|展览|招聘会|分享会|开放日/i;

export function enabledNoticeSources(repo: Repo): NoticeSource[] {
  const ids = repo.getSettings().noticeSources ?? defaultNoticeSources(repo.getProfile(), repo.listMemories());
  return NOTICE_SOURCES.filter((s) => ids.includes(s.id));
}

export interface NoticeSyncResult { notices: number; activities: number; errors: string[] }

/**
 * 同步学校和院系官网通知：读列表页 → 新通知读详情 → 保存 → 交给主动引擎。
 * - 第一次同步一个来源时，只为最近 3 天的通知生成事件，避免冒出几个月前的旧通知；
 * - 每个来源每次最多读 8 篇详情，请求之间间隔一会儿，不给学校网站添负担；
 * - 详情页读不到（只限校内访问等）时只保留标题。
 */
export async function syncNotices(
  deps: { repo: Repo; router: ModelRouter; fetchText: FetchText; pause?: (ms: number) => Promise<void> },
  sources: NoticeSource[],
  now = new Date(),
): Promise<NoticeSyncResult> {
  const { repo } = deps;
  const pause = deps.pause ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const own = new Set(ownSchoolSources(repo.getProfile().school).map((s) => s.id));
  let notices = 0;
  let activities = 0;
  const errors: string[] = [];
  for (const source of sources) {
    try {
      const page = await deps.fetchText(source.url);
      if (page.status >= 400) throw new Error(page.status === 403 ? '只允许校园网访问，校外请先连学校 VPN' : `返回 ${page.status}`);
      if (/访问策略禁止|wengine-auth/.test(page.text)) throw new Error('只允许校园网访问，校外请先连学校 VPN');
      const links = parseNoticeList(page.text, page.url || source.url);
      if (!links.length) throw new Error('没有读到通知列表，网站可能改版了');
      const seenKey = `notice_seen:${source.id}`;
      const firstSync = !repo.getKv<string | null>(seenKey, null);
      const fresh = links.filter((l) => !repo.findSourceItem('notice', 'notice', l.url)).slice(0, 8);
      for (const link of fresh) {
        const recent = !link.date || Date.parse(`${link.date}T23:59:59+08:00`) > now.getTime() - (firstSync ? 3 : 14) * DAY;
        // 第一次同步时旧通知只存标题，不读详情
        const detail = recent ? await readDetail(deps.fetchText, link).catch(() => undefined) : undefined;
        if (recent && fresh.indexOf(link) < fresh.length - 1) await pause(300);
        const publishedAt = link.date ? shanghai(...(link.date.split('-').map(Number) as [number, number, number])) : now.toISOString();
        const { item, created } = repo.upsertItem({
          source: 'notice', kind: 'notice', sourceId: link.url, title: detail?.title && detail.title.length > link.title.length && detail.title.startsWith(link.title.slice(0, 8)) ? detail.title : link.title,
          body: detail?.text.slice(0, 8000) ?? '', url: detail?.url ?? link.url, publishedAt, done: false,
          notice: { source: source.id, sourceName: source.name, attachments: detail?.attachments.length ? detail.attachments : undefined, titleOnly: !detail?.text },
        });
        if (!created) continue;
        notices++;
        if (!recent) continue;
        // 讲座、宣讲会：按活动处理（时间、地点、报名），推荐逻辑见活动
        if (ACTIVITY_TITLE.test(item.title) && detail?.text) {
          const article = { url: item.url!, title: item.title, sourceName: source.name, publishedAt, text: detail.text };
          const extracted = await extractActivities(article, deps.router.for('activity_extract'), now);
          if (extracted.activities.length) {
            const saved = saveActivities(repo, article, extracted.activities, now, true);
            activities += saved.items.length - saved.past;
            continue;
          }
        }
        repo.addTrigger({
          source: 'notice', kind: 'notice_new', sourceRef: link.url, threadKey: `notice:${source.id}`,
          payload: {
            itemId: item.id, title: item.title, sourceName: source.name, source: source.id, date: link.date,
            own: own.has(source.id), department: source.group === '学校部门',
            excerpt: (detail?.text ?? '').replace(/\s+/g, ' ').slice(0, 300),
            attachments: detail?.attachments.map((f) => f.name).slice(0, 3),
          },
        });
      }
      repo.setKv(seenKey, now.toISOString());
    } catch (error) {
      errors.push(`${source.name}：${(error as Error).message}`);
    }
  }
  return { notices, activities, errors };
}

async function readDetail(fetchText: FetchText, link: NoticeLink): Promise<{ url: string; title?: string; text: string; attachments: { name: string; url: string }[] } | undefined> {
  const res = await fetchText(link.url);
  if (res.status >= 400) return undefined;
  const finalUrl = res.url || link.url;
  // 有些院系的通知直接跳转到公众号文章
  if (isWechatArticle(finalUrl)) {
    const a = parseArticle(res.text, finalUrl);
    return a.text ? { url: finalUrl, title: a.title, text: a.text, attachments: [] } : undefined;
  }
  const d = parseNoticeDetail(res.text, finalUrl);
  if (d.text.length < 20 && !d.attachments.length) return undefined;
  return { url: finalUrl, title: d.title, text: d.text, attachments: d.attachments };
}

/** 对话工具用：通知的精简视图 */
export function noticeView(i: Item) {
  return { item_id: i.id, title: i.title, source: i.notice?.sourceName, date: new Date(Date.parse(i.publishedAt) + 8 * 3_600_000).toISOString().slice(0, 10), url: i.url, attachments: i.notice?.attachments?.map((f) => f.name), title_only: i.notice?.titleOnly || undefined };
}

/** 当前关注的来源，以及是自动选的还是用户 / 助理手动定的 */
export function noticeFollowState(repo: Repo): { mode: 'auto' | 'manual'; following: { id: string; name: string; why?: string }[] } {
  const manual = repo.getSettings().noticeSources;
  if (manual) {
    return { mode: 'manual', following: NOTICE_SOURCES.filter((s) => manual.includes(s.id)).map((s) => ({ id: s.id, name: s.name })) };
  }
  const auto = suggestNoticeSources(repo.getProfile(), repo.listMemories());
  return { mode: 'auto', following: auto.flatMap((a) => { const s = NOTICE_SOURCES.find((x) => x.id === a.id); return s ? [{ id: s.id, name: s.name, why: a.why }] : []; }) };
}

/** 关注 / 取消关注（按 id 或名称）。之后变成手动列表，不再自动调整 */
export function changeNoticeFollows(repo: Repo, follow: string[] = [], unfollow: string[] = []): { following: string[]; added: string[]; removed: string[]; unknown: string[] } {
  const ids = new Set(noticeFollowState(repo).following.map((s) => s.id));
  const added: string[] = [];
  const removed: string[] = [];
  const unknown: string[] = [];
  for (const q of follow) {
    const s = findNoticeSource(q);
    if (!s) unknown.push(q);
    else if (!ids.has(s.id)) { ids.add(s.id); added.push(s.name); }
  }
  for (const q of unfollow) {
    const s = findNoticeSource(q);
    if (!s) unknown.push(q);
    else if (ids.delete(s.id)) removed.push(s.name);
  }
  repo.setSettings({ noticeSources: [...ids] });
  return { following: NOTICE_SOURCES.filter((s) => ids.has(s.id)).map((s) => s.name), added, removed, unknown };
}
