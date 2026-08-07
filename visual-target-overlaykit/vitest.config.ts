import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@overlaykit/visual-protocol': fileURLToPath(new URL('../visual-protocol/src/index.ts', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
  },
});
