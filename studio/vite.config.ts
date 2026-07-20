import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import path from 'path';

export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: {
      '@overlaykit/ui': path.resolve(__dirname, '../shared/ui'),
    },
  },
  server: { port: 5173, strictPort: true },
  build: { outDir: 'dist' },
});
