import type { CardRef, Item, ReferenceDetail, ReferenceOpenResult, TicketStatus } from '../../shared/types';
import type { Repo } from '../db/repo';

/** Only explicit web URLs without credentials may leave the app. */
export function safeExternalUrl(value?: string): string | null {
  if (typeof value !== 'string' || /[\u0000-\u001f\u007f]/.test(value)) return null;
  const candidate = value.trim();
  if (!/^https?:\/\//i.test(candidate)) return null;
  try {
    const url = new URL(candidate);
    if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password) return null;
    return url.href;
  } catch {
    return null;
  }
}

const itemLabels: Record<Item['kind'], string> = {
  assignment: '作业', announcement: '课程公告', email: '邮件', replay: '课程回放', notice: '通知', activity: '校园活动',
};
const goalStatuses = { active: '进行中', done: '已完成', archived: '已归档' };
const taskStatuses = { todo: '待完成', done: '已完成', skipped: '已跳过' };
const ticketStatuses: Record<TicketStatus, string> = {
  suggested: '待确认', queued: '排队中', working: '处理中', waiting_user: '等待你补充',
  done: '已完成', failed: '失败', dropped: '已取消',
};

function fields(values: [label: string, value: string | undefined][]): NonNullable<ReferenceDetail['fields']> {
  return values.flatMap(([label, value]) => value ? [{ label, value }] : []);
}

/** Resolve against current stored objects; caller-provided titles are never used. */
export function resolveChatReference(repo: Repo, ref: Pick<CardRef, 'type' | 'id'>): ReferenceOpenResult {
  if (!ref || typeof ref !== 'object' || typeof ref.id !== 'string' || !ref.id.trim()) {
    throw new Error('引用无效，请重新选择。');
  }

  switch (ref.type) {
    case 'item': {
      const item = repo.getItem(ref.id);
      if (!item) break;
      const url = safeExternalUrl(item.url);
      if (url) return { kind: 'external', url };
      const course = item.courseId ? repo.getCourse(item.courseId) : undefined;
      return { kind: 'detail', detail: {
        title: item.title, label: itemLabels[item.kind], body: item.body,
        fields: fields([
          ['发件人', item.sender], ['课程', course?.name], ['截止时间', item.dueAt],
          ['发布时间', item.publishedAt], ['状态', item.done ? '已完成' : '待处理'],
        ]),
      } };
    }
    case 'resource': {
      const resource = repo.getResource(ref.id);
      if (!resource) break;
      return { kind: 'page', page: 'library', id: resource.id };
    }
    case 'goal': {
      const goal = repo.getGoal(ref.id);
      if (!goal) break;
      if (goal.status !== 'archived') return { kind: 'page', page: 'goals', id: goal.id };
      return { kind: 'detail', detail: {
        title: goal.title, label: '目标', body: goal.description ?? '',
        fields: fields([['状态', goalStatuses[goal.status]], ['截止时间', goal.dueAt]]),
      } };
    }
    case 'task': {
      const task = repo.getTask(ref.id);
      if (!task) break;
      const goal = task.goalId ? repo.getGoal(task.goalId) : undefined;
      if (goal && goal.status !== 'archived') return { kind: 'page', page: 'goals', id: task.id };
      const item = task.itemId ? repo.getItem(task.itemId) : undefined;
      return { kind: 'detail', detail: {
        title: task.title, label: '任务', body: item?.body ?? '',
        fields: fields([['状态', taskStatuses[task.status]], ['截止时间', task.dueAt], ['所属目标', goal?.title]]),
        related: item ? [{ type: 'item', id: item.id, title: item.title }] : [],
      } };
    }
    case 'feed': {
      const feed = repo.getFeedCard(ref.id);
      if (!feed) break;
      if (feed.status !== 'dismissed') return { kind: 'page', page: 'feed', id: feed.id };
      return { kind: 'detail', detail: {
        title: feed.title, label: '动态', body: feed.body,
        fields: fields([['状态', '已忽略'], ['推荐原因', feed.reason], ['忽略原因', feed.dismissReason], ['发布时间', feed.createdAt]]),
      } };
    }
    case 'ticket': {
      const ticket = repo.getTicket(ref.id);
      if (!ticket) break;
      const resource = ticket.resultResourceId ? repo.getResource(ticket.resultResourceId) : undefined;
      const goal = ticket.goalId ? repo.getGoal(ticket.goalId) : undefined;
      const related: CardRef[] = [];
      if (resource) related.push({ type: 'resource', id: resource.id, title: resource.title });
      if (goal) related.push({ type: 'goal', id: goal.id, title: goal.title });
      return { kind: 'detail', detail: {
        title: ticket.title, label: '工单', body: ticket.request,
        fields: fields([['状态', ticketStatuses[ticket.status]], ['创建时间', ticket.createdAt], ['结束时间', ticket.endedAt]]),
        related,
      } };
    }
    default:
      throw new Error('引用类型无效，请重新选择。');
  }

  throw new Error('这条引用的内容已不存在，可能已被删除。');
}
