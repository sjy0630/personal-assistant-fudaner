import { createElement, memo } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

function safeLink(value: string): string {
  try { const url = new URL(value); return ['https:', 'http:', 'mailto:'].includes(url.protocol) ? url.href : ''; }
  catch { return ''; }
}

/** 无原始 HTML、无远程图片请求。未闭合的流式 Markdown 由 CommonMark 解析器处理。 */
export const ChatMarkdown = memo(function ChatMarkdown({ text }: { text: string }) {
  return createElement('div', { className: 'chat-markdown' }, createElement(Markdown, {
    children: text, skipHtml: true, remarkPlugins: [remarkGfm], urlTransform: safeLink,
    components: {
      a: ({ href, children }) => href ? createElement('a', { href, target: '_blank', rel: 'noopener noreferrer' }, children) : createElement('span', null, children),
      img: ({ alt }) => createElement('span', { className: 'markdown-image' }, `[图片：${alt || '未提供说明'}]`),
      table: ({ children }) => createElement('div', { className: 'markdown-table', tabIndex: 0, role: 'region', 'aria-label': '表格，可横向滚动' }, createElement('table', null, children)),
    },
  }));
});
