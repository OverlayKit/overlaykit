import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  resolve: {
    alias: {
      '@overlaykit/renderer': path.resolve(__dirname, '../shared'),
    },
  },
  test: {
    globals: true,
    environment: 'happy-dom', // converter uses the DOM (DOMParser)
  },
});
