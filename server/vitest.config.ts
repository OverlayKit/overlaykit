import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  resolve: {
    alias: {
      '@overlaykit/protocol/element': fileURLToPath(
        new URL('../protocol/src/element.ts', import.meta.url)
      ),
      '@overlaykit/protocol/scene': fileURLToPath(
        new URL('../protocol/src/scene.ts', import.meta.url)
      ),
      '@overlaykit/visual-compiler': fileURLToPath(
        new URL('../visual-compiler/src/index.ts', import.meta.url)
      ),
      '@overlaykit/visual-protocol': fileURLToPath(
        new URL('../visual-protocol/src/index.ts', import.meta.url)
      ),
      '@overlaykit/visual-target-overlaykit': fileURLToPath(
        new URL('../visual-target-overlaykit/src/index.ts', import.meta.url)
      ),
    },
  },
  test: {
    globals: true,
    // Integration tests write through FileStorage; point it at a throwaway dir
    // (gitignored) so they never touch real data/.
    env: {
      DATA_DIR: path.resolve(__dirname, '.test-data'),
      LOG_LEVEL: 'error', // quiet the request logger during tests
    },
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
    },
  },
});
