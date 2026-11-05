import { contextBridge, ipcRenderer, webUtils } from 'electron';
import type { FudanerApi } from '../shared/ipc';

const call = (ch: string) => (...args: unknown[]) => ipcRenderer.invoke(ch, ...args);

/** 只暴露 FudanerApi 定义的接口，渲染进程拿不到 Node / Electron 能力 */
const api: FudanerApi & { pathForFile(f: File): string } = {
  chat: { history: call('chat.history'), send: call('chat.send'), quickAction: call('chat.quickAction') } as FudanerApi['chat'],
  today: call('today') as FudanerApi['today'],
  feed: { list: call('feed.list'), dismiss: call('feed.dismiss'), act: call('feed.act') } as FudanerApi['feed'],
  goals: { list: call('goals.list'), setTaskStatus: call('goals.setTaskStatus') } as FudanerApi['goals'],
  library: { list: call('library.list'), get: call('library.get'), upload: call('library.upload'), remove: call('library.remove') } as FudanerApi['library'],
  search: call('search') as FudanerApi['search'],
  searchDetail: call('search.detail') as FudanerApi['searchDetail'],
  memory: { list: call('memory.list'), add: call('memory.add'), update: call('memory.update'), remove: call('memory.remove') } as FudanerApi['memory'],
  profile: { get: call('profile.get'), set: call('profile.set') } as FudanerApi['profile'],
  settings: { get: call('settings.get'), set: call('settings.set'), setMailPassword: call('settings.setMailPassword'), testModel: call('settings.testModel') } as FudanerApi['settings'],
  platforms: { status: call('platforms.status'), login: call('platforms.login'), syncNow: call('platforms.syncNow') } as FudanerApi['platforms'],
  decisions: call('decisions') as FudanerApi['decisions'],
  tickets: call('tickets') as FudanerApi['tickets'],
  dev: {
    setDemoPhase: call('dev.setDemoPhase'), tick: call('dev.tick'), wipe: call('dev.wipe'),
    demoSubmitNext: call('dev.demoSubmitNext'), demoNewMail: call('dev.demoNewMail'), resetDemo: call('dev.resetDemo'),
  } as FudanerApi['dev'],
  on(channel, cb) {
    const listener = (_e: unknown, ch: string, payload: unknown) => { if (ch === channel) cb(payload); };
    ipcRenderer.on('fudaner:event', listener);
    return () => ipcRenderer.removeListener('fudaner:event', listener);
  },
  pathForFile: (f: File) => webUtils.getPathForFile(f),
};

contextBridge.exposeInMainWorld('fudaner', api);
