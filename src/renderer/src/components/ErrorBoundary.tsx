import { Component, type ErrorInfo, type ReactNode } from 'react';

/**
 * 界面出错时显示错误信息和恢复办法，而不是整个窗口白屏。
 * - scope="page"：包住单个页面，出错时左侧导航仍可用（可以去设置页清数据）；切换页面后自动恢复。
 * - scope="app"：包住整个应用，最后一道兜底。
 * 错误同时打到控制台，主进程会把它转发到运行 npm run dev 的终端。
 */
export class ErrorBoundary extends Component<{ scope: 'app' | 'page'; resetKey?: string; children: ReactNode }, { error: Error | null; stack: string }> {
  state = { error: null as Error | null, stack: '' };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    this.setState({ stack: info.componentStack ?? '' });
    console.error(`[Fudaner 界面错误] ${error.message}\n${error.stack ?? ''}\n组件：${info.componentStack ?? ''}`);
  }

  componentDidUpdate(prev: { resetKey?: string }) {
    if (this.state.error && prev.resetKey !== this.props.resetKey) this.setState({ error: null, stack: '' });
  }

  render() {
    const { error, stack } = this.state;
    if (!error) return this.props.children;
    const detail = `${error.message}\n\n${error.stack ?? ''}\n\n组件：${stack}`;
    const clearUiCache = () => {
      try { window.localStorage.clear(); } catch { /* 无存储权限时直接重新加载 */ }
      window.location.reload();
    };
    return (
      <div role="alert" style={{ padding: 32, maxWidth: 760, margin: '0 auto', color: 'var(--text)' }}>
        <h1>{this.props.scope === 'page' ? '这个页面出错了' : 'Fudaner 出错了'}</h1>
        <p className="muted">
          {this.props.scope === 'page'
            ? '可以先切换到左侧其他页面继续使用。如果每次打开都出错，多半是某条数据显示不了：把下面的错误信息发给开发同学。'
            : '可以先试试重新加载。如果每次打开都出错，把下面的错误信息发给开发同学。'}
        </p>
        <pre style={{ whiteSpace: 'pre-wrap', fontSize: 12, maxHeight: 280, overflow: 'auto', padding: 12, border: '1px solid var(--border)', borderRadius: 8, background: 'var(--panel)' }}>{detail}</pre>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 12 }}>
          <button className="primary" onClick={() => window.location.reload()}>重新加载</button>
          <button onClick={() => void navigator.clipboard?.writeText(detail)}>复制错误信息</button>
          <button onClick={clearUiCache} title="清除对话草稿、侧栏和主题设置；不会删除聊天记录、账号和数据">清除界面缓存并重新加载</button>
        </div>
      </div>
    );
  }
}
