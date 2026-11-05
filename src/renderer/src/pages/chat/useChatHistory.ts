import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ChatMessage } from '../../../../shared/types';
import { api } from '../../api';

function merge(first: ChatMessage[], latest: ChatMessage[]) {
  const byId = new Map(first.map((message) => [message.id, message]));
  for (const message of latest) byId.set(message.id, message);
  return [...byId.values()];
}

export function useChatHistory(location: { id: string } | null, onIncoming: (message: ChatMessage) => void) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const loadingRef = useRef(true);
  const inbox = useRef<ChatMessage[]>([]);
  const updates = useRef(new Map<string, ChatMessage>());
  const knownIds = useRef(new Set<string>());
  const [error, setError] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const olderBusy = useRef(false);
  const [olderError, setOlderError] = useState(false);
  const [olderRevision, setOlderRevision] = useState(0);
  const [retry, setRetry] = useState(0);
  const epoch = useRef(0);
  const incoming = useRef(onIncoming);
  incoming.current = onIncoming;

  useLayoutEffect(() => {
    const request = ++epoch.current;
    loadingRef.current = true; inbox.current = []; updates.current.clear(); knownIds.current = new Set(); olderBusy.current = false;
    setLoading(true); setLoadingOlder(false); setError(false); setOlderError(false); setMessages([]);
    const load = location
      ? api.chat.history(200, location.id).then((rows) => ({ messages: rows, hasMore: false }))
      : api.chat.page();
    void load.then((page) => {
      if (request !== epoch.current) return;
      const buffered = location ? inbox.current.filter((m) => page.messages.some((row) => row.id === m.id)) : inbox.current;
      const rows = merge(page.messages, buffered).map((message) => updates.current.get(message.id) ?? message);
      knownIds.current = new Set(rows.map((m) => m.id));
      setMessages(rows); setHasMore(page.hasMore);
    }).catch(() => { if (request === epoch.current) setError(true); }).finally(() => {
      if (request === epoch.current) { updates.current.clear(); loadingRef.current = false; setLoading(false); }
    });
    return () => { epoch.current++; };
  }, [location, retry]);

  useEffect(() => {
    const offMessage = api.on('chat:message', (payload) => {
      const message = payload as ChatMessage;
      const exists = knownIds.current.has(message.id);
      knownIds.current.add(message.id);
      if (!exists) incoming.current(message);
      if (loadingRef.current) { inbox.current.push(message); return; }
      setMessages((previous) => {
        if (previous.some((m) => m.id === message.id)) return previous.map((m) => m.id === message.id ? message : m);
        return location ? previous : [...previous, message];
      });
    });
    const offUpdate = api.on('chat:updated', (payload) => {
      const message = payload as ChatMessage;
      if (loadingRef.current || olderBusy.current) updates.current.set(message.id, message);
      if (knownIds.current.has(message.id)) setMessages((rows) => rows.map((row) => row.id === message.id ? message : row));
    });
    const offClear = api.on('chat:cleared', () => setRetry((count) => count + 1));
    return () => { offMessage(); offUpdate(); offClear(); };
  }, [location]);

  const loadOlder = async (): Promise<boolean> => {
    if (olderBusy.current || loadingRef.current || !hasMore || location || !messages.length) return false;
    olderBusy.current = true; setLoadingOlder(true); setOlderError(false);
    const request = epoch.current;
    try {
      const page = await api.chat.page(messages[0].id);
      if (request !== epoch.current) return false;
      const older = page.messages.map((message) => updates.current.get(message.id) ?? message);
      older.forEach((message) => knownIds.current.add(message.id));
      setMessages((previous) => merge(older, previous)); setHasMore(page.hasMore); setOlderRevision((n) => n + 1);
      return true;
    } catch { if (request === epoch.current) setOlderError(true); return false; }
    finally { if (request === epoch.current) { updates.current.clear(); olderBusy.current = false; setLoadingOlder(false); } }
  };
  return { messages, loading, loadingRef, error, hasMore, loadingOlder, olderError, olderRevision, loadOlder, reload: () => setRetry((n) => n + 1) };
}
