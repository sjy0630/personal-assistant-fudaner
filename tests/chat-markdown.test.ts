import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ChatMarkdown } from '../src/renderer/src/pages/chat/ChatMarkdown';
const render=(text:string)=>renderToStaticMarkup(createElement(ChatMarkdown,{text}));
describe('对话 Markdown',()=>{
  it('排版粗体、列表、代码和表格',()=>{
    const html=render('**重点**\n\n- 第一项\n- 第二项\n\n```js\nconst x = 1;\n```\n\n| 课程 | 截止 |\n| --- | --- |\n| 数学 | 周五 |');
    expect(html).toContain('<strong>重点</strong>');expect(html).toContain('<li>第一项</li>');expect(html).toContain('<pre>');expect(html).toContain('<table>');
  });
  it('未闭合的流式代码块仍能安全显示',()=>{expect(render('```ts\nconst value =')).toContain('const value =');});
  it('原始 HTML、脚本 URL 和远程图片不能执行或自动发请求',()=>{
    const html=render('<script>alert(1)</script>\n\n[危险](javascript:alert%281%29)\n\n![图示](https://example.test/tracker.png)');
    expect(html).not.toContain('<script');expect(html).not.toContain('href="javascript:');expect(html).not.toContain('<img');expect(html).toContain('图示');
  });
  it('仅允许明确的外部链接，拒绝相对链接和本地文件协议',()=>{
    const html=render('[学校](https://www.fudan.edu.cn) [文件](file:///C:/test) [相对](/test)');
    expect(html).toContain('href="https://www.fudan.edu.cn/"');expect(html).not.toContain('href="file:');expect(html).not.toContain('href="/test"');
  });
});
