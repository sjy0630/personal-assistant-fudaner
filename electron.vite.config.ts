import { resolve } from 'node:path';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';

// @fudaner/* 是工作区里的 TypeScript 源码包，需要打包进主进程，不能外部化
const workspacePkgs = ['@fudaner/fudan-auth', '@fudaner/mcp-fudan-elearning', '@fudaner/mcp-fudan-mail', '@fudaner/mcp-fudan-courses'];

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
    plugins: [react()],
  },
});
