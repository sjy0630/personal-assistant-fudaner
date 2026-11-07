import { useCallback, useEffect, useRef, useState } from 'react';
import styles from './Settings.module.css';
import { settingsErrorMessage } from '../settings-state';

export type PanelProps = { onDirty: (dirty: boolean) => void; onBusy: (busy: boolean) => void };
export const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

export function useLoad<T>(loader: () => Promise<T>) {
  const [value, setValue] = useState<T | null>(null);
  const [error, setError] = useState(false);
  const [version, setVersion] = useState(0);
  const fetcher = useRef(loader);
  fetcher.current = loader;
  useEffect(() => {
    let active = true;
    setError(false);
    void fetcher
      .current()
      .then((result) => {
        if (active) setValue(result);
      })
      .catch(() => {
        if (active) setError(true);
      });
    return () => {
      active = false;
    };
  }, [version]);
  return { value, error, retry: () => setVersion((v) => v + 1) };
}

export function useTask(onBusy: PanelProps['onBusy']) {
  const [busy, setBusy] = useState('');
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const active = useRef(false);
  useEffect(() => {
    onBusy(!!busy);
    return () => onBusy(false);
  }, [busy, onBusy]);
  const run = async (
    key: string,
    action: () => Promise<void>,
    success = '已保存。',
    failure = '操作未完成，请检查连接后重试。填写内容已保留。'
  ) => {
    if (active.current) return;
    active.current = true;
    setBusy(key);
    setNotice('');
    setError('');
    try {
      await action();
      setNotice(success);
    } catch (err) {
      setError(settingsErrorMessage(err, failure));
    } finally {
      active.current = false;
      setBusy('');
    }
  };
  // 保持同一个函数，提示的自动消失计时不会因为重新渲染被重置
  const clear = useCallback(() => {
    setNotice('');
    setError('');
  }, []);
  return { busy, notice, error, run, clear };
}

export function Feedback({
  notice,
  error,
  clear,
}: {
  notice: string;
  error: string;
  clear?: () => void;
}) {
  // 提示几秒后自动消失：成功 4 秒，失败 10 秒；也可以手动关闭
  useEffect(() => {
    if (!clear || (!notice && !error)) return;
    const timer = setTimeout(clear, error ? 10_000 : 4_000);
    return () => clearTimeout(timer);
  }, [notice, error, clear]);
  if (!notice && !error) return null;
  return (
    <div className={styles.feedback}>
      <p className={error ? styles.error : styles.success} role={error ? 'alert' : 'status'}>
        {error || notice}
      </p>
      {clear && (
        <button type="button" className="ghost" aria-label="关闭提示" onClick={clear}>
          ×
        </button>
      )}
    </div>
  );
}
export function Loading({ error, retry }: { error: boolean; retry: () => void }) {
  return error ? (
    <div role="alert">
      <p>无法读取本机设置，请重试。</p>
      <button onClick={retry}>重新读取</button>
    </div>
  ) : (
    <p className={styles.hint} role="status">
      正在读取设置…
    </p>
  );
}
