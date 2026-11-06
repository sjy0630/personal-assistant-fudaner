import { useEffect, useState } from 'react';
import type { ChatMessage, ChatRun } from '../../../../shared/types';
import { api } from '../../api';

/** 先订阅再读取运行快照；已完成消息和版本号阻止旧响应让回复“复活”。 */
export function useChatRun() {
  const [run, setRun] = useState<ChatRun | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let alive = true;
    let events = 0;
    const finished = new Set<string>();
    const apply = (next: ChatRun) => {
      if (!alive || finished.has(next.id)) return;
      setError('');
      setRun((current) => current?.id === next.id && current.version >= next.version ? current : next);
    };
    const offDelta = api.on('chat:delta', (payload) => { events++; apply(payload as ChatRun); });
    const offMessage = api.on('chat:message', (payload) => {
      const message = payload as ChatMessage;
      if (message.role !== 'assistant') return;
      events++; finished.add(message.id);
      if (finished.size > 32) finished.delete(finished.values().next().value!);
      setRun((current) => current?.id === message.id ? null : current);
    });
    const offThinking = api.on('chat:thinking', (on) => { events++; if (!on) setRun(null); });
    void api.chat.state().then((snapshot) => { if (snapshot) apply(snapshot); else if (alive && events === 0) setRun(null); }).catch(() => {
      if (alive) setError('暂时无法恢复生成状态，请重新进入对话后再发送。');
    });
    return () => { alive = false; offDelta(); offMessage(); offThinking(); };
  }, []);
  return { run, runError: error };
}
