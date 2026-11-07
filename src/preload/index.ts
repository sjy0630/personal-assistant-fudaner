import { contextBridge, ipcRenderer, webUtils } from 'electron';
import type { FudanerApi } from '../shared/ipc';

const call = (ch: string) => (...args: unknown[]) => ipcRenderer.invoke(ch, ...args);

// 通知可能在 React 首次订阅之前抵达。只缓冲最新导航，避免启动时丢失点击。
const navigationListeners = new Set<(payload: unknown) => void>();
let navigationVersion = 0;
let pendingNavigation: { payload: unknown; version: number } | null = null;
ipcRenderer.on('fudaner:event', (_e, channel: string, payload: unknown) => {
  if (channel !== 'navigate') return;
  navigationVersion++;
  if (!navigationListeners.size) { pendingNavigation = { payload, version: navigationVersion }; return; }
  pendingNavigation = null;
  navigationListeners.forEach((cb) => cb(payload));
});

/** 只暴露 FudanerApi 定义的接口，渲染进程拿不到 Node / Electron 能力 */
const api: FudanerApi & { pathForFile(f: File): string } = {
  chat: { history: call('chat.history'), page: call('chat.page'), send: call('chat.send'), state: call('chat.state'), cancel: call('chat.cancel'), undoResult: call('chat.undoResult'), quickAction: call('chat.quickAction') } as FudanerApi['chat'],
  references: { open: call('references.open') } as FudanerApi['references'],
  copyText: call('copyText') as FudanerApi['copyText'],
  today: call('today') as FudanerApi['today'],
  feed: { list: call('feed.list'), dismiss: call('feed.dismiss'), act: call('feed.act'), refresh: call('feed.refresh') } as FudanerApi['feed'],
  goals: { list: call('goals.list'), setTaskStatus: call('goals.setTaskStatus') } as FudanerApi['goals'],
  library: { list: call('library.list'), get: call('library.get'), image: call('library.image'), upload: call('library.upload'), uploadImage: call('library.uploadImage'), remove: call('library.remove') } as FudanerApi['library'],
  search: call('search') as FudanerApi['search'],
  searchDetail: call('search.detail') as FudanerApi['searchDetail'],
  memory: { list: call('memory.list'), add: call('memory.add'), update: call('memory.update'), remove: call('memory.remove') } as FudanerApi['memory'],
  profile: { get: call('profile.get'), set: call('profile.set') } as FudanerApi['profile'],
  settings: { get: call('settings.get'), set: call('settings.set'), setMailPassword: call('settings.setMailPassword'), testModel: call('settings.testModel'), testEmbedding: call('settings.testEmbedding') } as FudanerApi['settings'],
  platforms: { status: call('platforms.status'), login: call('platforms.login'), syncNow: call('platforms.syncNow') } as FudanerApi['platforms'],
  activities: { list: call('activities.list'), import: call('activities.import'), syncFeeds: call('activities.syncFeeds') } as FudanerApi['activities'],
  notices: { sources: call('notices.sources'), list: call('notices.list') } as FudanerApi['notices'],
  external: { presets: call('external.presets'), status: call('external.status'), save: call('external.save') } as FudanerApi['external'],
  reminders: { list: call('reminders.list'), add: call('reminders.add'), setEnabled: call('reminders.setEnabled'), remove: call('reminders.remove') } as FudanerApi['reminders'],
  campus: { status: call('campus.status'), importTimetable: call('campus.importTimetable'), importExams: call('campus.importExams'), library: call('campus.library'), cardBalance: call('campus.cardBalance'), electricity: call('campus.electricity'), grades: call('campus.grades'), program: call('campus.program'), selected: call('campus.selected') } as FudanerApi['campus'],
  treehole: { status: call('treehole.status'), login: call('treehole.login'), logout: call('treehole.logout') } as FudanerApi['treehole'],
  decisions: call('decisions') as FudanerApi['decisions'],
  tickets: call('tickets') as FudanerApi['tickets'],
  dev: {
    setDemoPhase: call('dev.setDemoPhase'), tick: call('dev.tick'), wipe: call('dev.wipe'),
    demoSubmitNext: call('dev.demoSubmitNext'), demoNewMail: call('dev.demoNewMail'), resetDemo: call('dev.resetDemo'),
  } as FudanerApi['dev'],
  on(channel, cb) {
    if (channel === 'navigate') {
      navigationListeners.add(cb);
      queueMicrotask(() => {
        if (!navigationListeners.has(cb) || !pendingNavigation) return;
        const pending = pendingNavigation;
        pendingNavigation = null;
        if (pending.version === navigationVersion) cb(pending.payload);
      });
      return () => { navigationListeners.delete(cb); };
    }
    const listener = (_e: unknown, ch: string, payload: unknown) => { if (ch === channel) cb(payload); };
    ipcRenderer.on('fudaner:event', listener);
    return () => ipcRenderer.removeListener('fudaner:event', listener);
  },
  pathForFile: (f: File) => webUtils.getPathForFile(f),
};

contextBridge.exposeInMainWorld('fudaner', api);
