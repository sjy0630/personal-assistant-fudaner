import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  root: fileURLToPath(new URL('../../', import.meta.url)),
  test: {
    include: ['tests/eval/**/*.eval.ts'],
    environment: 'node',
    fileParallelism: false,
    testTimeout: 300_000,
    hookTimeout: 30_000,
    server: { deps: { external: [/node:sqlite/] } },
  },
});
