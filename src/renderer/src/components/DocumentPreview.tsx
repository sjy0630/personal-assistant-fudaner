import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import pptxRuntime from 'pptx-preview/dist/pptx-preview.umd.js?raw';
import { preparePresentation } from './pptx-input';

import pptxBootstrap from './pptx-bootstrap.js?raw';
import wordRuntime from '../../../../node_modules/docx-preview/dist/docx-preview.min.js?raw';
import zipRuntime from 'jszip/dist/jszip.min.js?raw';
import wordBootstrap from './docx-bootstrap.js?raw';

export function DocumentPreview({ id, title, mime }: { id: string; title: string; mime: string }) {
  const [result, setResult] = useState<{ id: string; url?: string; html?: string; error?: string } | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [renderError, setRenderError] = useState(false);
  const frameRef = useRef<HTMLIFrameElement>(null);
  const isPdf = mime === 'application/pdf';
  const isWord = mime === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  useEffect(() => {
    let active = true;
    const urls: string[] = [];
    let listener: ((event: MessageEvent) => void) | undefined;
    setResult(null);
    setRenderError(false);
    void api.library.preview(id).then(async (bytes) => {
      if (!active) return;
      const data = isPdf || isWord ? new Uint8Array(bytes) : await preparePresentation(new Uint8Array(bytes));
      if (!active) return;
      if (isPdf) {
        const url = URL.createObjectURL(new Blob([new Uint8Array(data).buffer], { type: 'application/pdf' }));
        urls.push(url);
        setResult({ id, url });
        return;
      }
      const script = (isWord ? [zipRuntime, wordRuntime, wordBootstrap].join('\n') : pptxRuntime + '\n' + pptxBootstrap).replace(/\r\n?/g, '\n');

      listener = (event: MessageEvent) => {
        if (!frameRef.current?.contentWindow || event.source !== frameRef.current.contentWindow) return;
        if (event.data?.type === 'preview-load') frameRef.current?.contentWindow?.postMessage(data.buffer, '*');
        if (event.data?.type === 'preview-error') setRenderError(true);
      };
      window.addEventListener('message', listener);
      const html = `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; connect-src 'none'"><style>body{margin:0;background:#dedede;padding:16px;font-family:Arial,sans-serif}#slides{background:white}*{box-sizing:border-box}</style><div id="slides"></div><script>${script.replace(/<\/script/gi, '<\\/script')}</script>`;
      setResult({ id, html });
    }).catch((error: unknown) => {
      if (active) setResult({ id, error: error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : '预览加载失败，请重试。' });
    });
    return () => {
      active = false;
      urls.forEach((url) => URL.revokeObjectURL(url));
      if (listener) window.removeEventListener('message', listener);
    };
  }, [id, attempt, isPdf, isWord]);
  if (!result || result.id !== id) return <p role="status">正在准备页面预览…</p>;
  if (result.error || renderError) return <div role="alert"><p>{result.error || '此文档暂时无法渲染，请切换文字阅读，或将其另存为 PDF 后上传。'}</p><button onClick={() => setAttempt((n) => n + 1)}>重试</button></div>;
  return <>
    {!isPdf && <p className="muted small">{isWord ? 'Word 页面预览 · 保留常见分页、图片、表格和页边距，特殊字体及复杂排版可能有差异。' : 'PPTX 页面预览 · 支持常见文字、图片和形状，特殊字体、动画和复杂图表可能有差异。'}</p>}
    {isPdf ? <iframe className="document-original-preview" title={`${title}原版式预览`} src={`${result.url}#toolbar=1&view=FitH`} /> :
      <iframe ref={frameRef} className="document-original-preview" title={`${title}${isWord ? 'Word' : '幻灯片'}预览`} sandbox="allow-scripts" srcDoc={result.html} />}
  </>;
}

