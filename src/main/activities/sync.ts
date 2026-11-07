import { createHash } from 'node:crypto';
import type { FeedSource, Item } from '../../shared/types';
import type { Repo } from '../db/repo';
import type { ModelRouter } from '../ai/llm';
import { fmt } from '../engine/engine';
import { checkPublicUrl, htmlToText, isWechatArticle, isWechatUnavailable, isWechatVerifyPage, parseArticle, parseFeed, type Article } from './article';
import { extractActivities, type ExtractedActivity } from './extract';

/** 读取网页：主进程里用 Electron 的网络栈（跟随系统代理），测试里换成假的 */
export type FetchText = (url: string) => Promise<{ url: string; status: number; text: string }>;

export interface ImportResult {
  article: Pick<Article, 'url' | 'title' | 'sourceName' | 'publishedAt'>;
  activities: Item[];
  /** 已经结束的活动（保存了，但不推荐） */
  past: number;
  model: string;
}

const DAY = 86_400_000;

/** 读取一篇文章：公众号文章或普通网页 */
export async function readArticle(fetchText: FetchText, url: string): Promise<Article> {
  const target = checkPublicUrl(url).href;
  const res = await fetchText(target);
  if (res.status === 404) throw new Error('文章不存在或已被删除。');
  if (res.status >= 400) throw new Error(`打开文章失败（${res.status}），请稍后再试。`);
  if (isWechatVerifyPage(res.text)) throw new Error('微信要求验证后才能查看这篇文章（访问太频繁时会这样）。请稍后再试，或把文章正文复制给我。');
  if (isWechatUnavailable(res.text)) throw new Error('这篇公众号文章已被删除或无法查看。');
  const article = parseArticle(res.text, res.url || target);
  if (article.text.length < 20) throw new Error('没有读到文章正文。可能需要登录才能查看，可以把正文复制给我。');
  return article;
}

/**
 * 导入一篇文章：提取活动并保存。
 * trigger = true 时，新活动进入主动引擎（按兴趣和目标决定要不要推荐给用户）。
 */
export async function importArticle(
  deps: { repo: Repo; router: ModelRouter; fetchText: FetchText },
  input: string | Article,
  opts: { now?: Date; trigger?: boolean; sourceName?: string; publishedAt?: string } = {},
): Promise<ImportResult> {
  const now = opts.now ?? new Date();
  const article = typeof input === 'string' ? await readArticle(deps.fetchText, input) : input;
  if (opts.sourceName && !article.sourceName) article.sourceName = opts.sourceName;
  if (opts.publishedAt && !article.publishedAt) article.publishedAt = opts.publishedAt;
  const { activities, model } = await extractActivities(article, deps.router.for('activity_extract'), now);
  const saved = saveActivities(deps.repo, article, activities, now, opts.trigger ?? true);
  return {
    article: { url: article.url, title: article.title, sourceName: article.sourceName, publishedAt: article.publishedAt },
    activities: saved.items, past: saved.past, model,
  };
}

export function saveActivities(repo: Repo, article: Article, activities: ExtractedActivity[], now: Date, trigger: boolean): { items: Item[]; past: number } {
  const items: Item[] = [];
  let past = 0;
  repo.db.tx(() => {
    for (const a of activities) {
      const over = !!a.startsAt && Date.parse(a.endsAt ?? a.startsAt) < now.getTime() - 2 * 3_600_000;
      const { title, ...activity } = a;
      const { item, created, changedFields } = repo.upsertItem({
        source: 'notice', kind: 'activity', sourceId: activityKey(article.url, a), title,
        body: [activity.summary, article.text.slice(0, 2000)].filter(Boolean).join('\n\n'),
        url: article.url, publishedAt: article.publishedAt ?? now.toISOString(), done: false, activity,
      });
      items.push(item);
      if (over) { past++; continue; }
      if (trigger && (created || changedFields.includes('startsAt'))) {
        repo.addTrigger({
          source: 'notice', kind: 'activity_new', sourceRef: `${item.sourceId}:${activity.startsAt ?? ''}`, threadKey: `activity:${item.id}`,
          payload: {
            itemId: item.id, title, startsAt: activity.startsAt, timeText: activity.startsAt ? fmt(activity.startsAt) : activity.timeText,
            location: activity.location, campus: activity.campus, category: activity.category, organizer: activity.organizer,
            speaker: activity.speaker, summary: activity.summary, sourceName: activity.sourceName, changed: !created,
            // 正文开头，用于按兴趣匹配（研判模型和规则都会看）
            excerpt: article.text.replace(/\s+/g, ' ').slice(0, 300),
          },
        });
      }
    }
  });
  return { items, past };
}

/** 同一篇文章里的同一场活动，重复导入时更新而不是新增 */
function activityKey(url: string, a: ExtractedActivity): string {
  const u = new URL(url);
  // 公众号链接带有很多跟踪参数，只保留能确定文章的部分
  const keep = isWechatArticle(url) ? ['__biz', 'mid', 'idx', 'sn'] : [];
  const params = keep.map((k) => `${k}=${u.searchParams.get(k) ?? ''}`).join('&');
  const base = `${u.hostname}${u.pathname}${params ? `?${params}` : ''}`;
  return createHash('sha1').update(`${base}#${a.title.replace(/\s+/g, '')}`).digest('hex').slice(0, 20);
}

/**
 * 同步订阅源：读取每个 RSS / Atom 源的新条目，提取活动。
 * 首次同步一个源时只看最近 7 天的条目；每个源每次最多处理 10 条新条目。
 */
export async function syncFeeds(
  deps: { repo: Repo; router: ModelRouter; fetchText: FetchText },
  feeds: FeedSource[],
  now = new Date(),
): Promise<{ entries: number; activities: number; errors: string[] }> {
  let entries = 0;
  let activities = 0;
  const errors: string[] = [];
  for (const feed of feeds) {
    const name = feed.name || hostOf(feed.url);
    try {
      const res = await deps.fetchText(checkPublicUrl(feed.url).href);
      if (res.status >= 400) throw new Error(`返回 ${res.status}`);
      const parsed = parseFeed(res.text);
      if (!parsed.entries.length && !/<(rss|feed|rdf)[\s>]/i.test(res.text)) throw new Error('不是 RSS / Atom 订阅地址');
      const seenKey = `feed_seen:${feed.url}`;
      const seen = new Set(deps.repo.getKv<string[]>(seenKey, []));
      const firstSync = seen.size === 0;
      const fresh = parsed.entries
        .filter((e) => !seen.has(e.id))
        .filter((e) => !firstSync || !e.publishedAt || Date.parse(e.publishedAt) > now.getTime() - 7 * DAY)
        .slice(0, 10);
      for (const e of fresh) {
        try {
          const inline = e.html ? htmlToText(e.html) : '';
          const article: Article | undefined = inline.length >= 120 || !e.link
            ? { url: e.link ?? feed.url, title: e.title, sourceName: parsed.title || name, publishedAt: e.publishedAt, text: inline }
            : undefined;
          const result = await importArticle(deps, article ?? e.link!, { now, sourceName: parsed.title || name, publishedAt: e.publishedAt });
          activities += result.activities.length - result.past;
          entries++;
          seen.add(e.id);
        } catch (error) {
          // 单篇失败（被删、要验证）不影响其他条目；记为已读，避免每次重试
          seen.add(e.id);
          errors.push(`${name}「${e.title}」：${(error as Error).message}`);
        }
      }
      for (const e of parsed.entries) if (firstSync) seen.add(e.id);
      deps.repo.setKv(seenKey, [...seen].slice(-500));
    } catch (error) {
      errors.push(`${name}：${(error as Error).message}`);
    }
  }
  return { entries, activities, errors };
}

function hostOf(url: string): string {
  try { return new URL(url).hostname; } catch { return url; }
}
