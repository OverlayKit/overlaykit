import { defineConfig } from 'vite';

// Marketing landing page. Static single page; the CTA links to the editor.
export default defineConfig({
  server: { port: 5180, strictPort: true },
  build: { outDir: 'dist' },
});
