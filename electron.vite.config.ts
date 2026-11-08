import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';

// @fudaner/* 是工作区里的 TypeScript 源码包，需要打包进主进程，不能外部化
const workspacePkgs = ['@fudaner/fudan-auth', '@fudaner/mcp-fudan-elearning', '@fudaner/mcp-fudan-mail', '@fudaner/mcp-fudan-courses'];

// 只允许隔离 PPTX 框架中这段固定的本地脚本执行，主页面继续禁止任意内联脚本。
const previewRuntime = readFileSync(createRequire(import.meta.url).resolve('pptx-preview/dist/pptx-preview.umd.js'), 'utf8');
const previewBootstrap = readFileSync(resolve('src/renderer/src/components/pptx-bootstrap.js'), 'utf8');
const previewScript = (previewRuntime + '\n' + previewBootstrap).replace(/<\/script/gi, '<\\/script').replace(/\r\n?/g, '\n');
const previewHash = createHash('sha256').update(previewScript).digest('base64');
const wordRuntimePath = resolve('node_modules/docx-preview/dist/docx-preview.min.js').replace(/\\/g, '/');
const wordScript = [readFileSync(resolve('node_modules/jszip/dist/jszip.min.js'), 'utf8'), readFileSync(wordRuntimePath, 'utf8'), readFileSync(resolve('src/renderer/src/components/docx-bootstrap.js'), 'utf8')].join('\n').replace(/<\/script/gi, '<\\/script').replace(/\r\n?/g, '\n');
const wordHash = createHash('sha256').update(wordScript).digest('base64');

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin({ exclude: workspacePkgs })],
    build: { rollupOptions: { external: ['node:sqlite'] } },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    build: { rollupOptions: { input: resolve(__dirname, 'src/renderer/index.html') } },
    plugins: [react(), {
      name: 'preview-script-policy',
      transformIndexHtml(html) {
        return html.replace('script-src \'self\' blob:', `script-src 'self' 'sha256-${previewHash}' 'sha256-${wordHash}'`);
      },
    }],
  },
});
