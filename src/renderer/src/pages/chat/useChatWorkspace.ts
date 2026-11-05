import { useState, useSyncExternalStore } from 'react';
import { api } from '../../api';
import { createChatWorkspace } from './composer-state';

/** Mount once in App so changing pages cannot discard pending attachment imports. */
export function useChatWorkspace() {
  const [store] = useState(() => {
    let storage: Storage | undefined;
    try { storage = window.localStorage; } catch { /* Drafts still work without browser storage. */ }
    return createChatWorkspace<File>({
      storage,
      pathForFile: (file) => window.fudaner.pathForFile(file),
      upload: async (path) => {
        const resource = await api.library.upload(path);
        return { type: 'resource', id: resource.id, title: resource.title, subtitle: '刚上传' };
      },
    });
  });
  const { subscribe, getSnapshot, ...actions } = store;
  const state = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  return { ...actions, ...state };
}

export type ChatWorkspace = ReturnType<typeof useChatWorkspace>;
