import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
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
