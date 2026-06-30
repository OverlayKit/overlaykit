import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import path from 'path';

export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: {
      '@overlaykit/renderer': path.resolve(__dirname, '../shared'),
    },
  },
  server: {
    // Dedicated port for the OBS overlay. NOT 5173 — that's the default Vite
    // port every other project grabs, so a stray app would push the overlay to a
    // random fallback port and the documented OBS URL would open the wrong app.
    port: 5183,
    strictPort: true, // fail loudly if 5183 is taken instead of silently moving
    cors: true,
    // The bundled sound catalog is served by the API host (:3000) but referenced by
    // root-relative URLs (/sounds/...). In dev the overlay runs on a different origin
    // (:5183) with no env, so without this proxy `new Audio('/sounds/..')` would hit
    // the overlay's SPA fallback (text/html) and never play. Proxy /sounds → API.
    // (In prod, VITE_API_URL absolutizes these in SoundManager, or they're same-origin.)
    proxy: {
      '/sounds': { target: 'http://localhost:3000', changeOrigin: true },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
  define: {
    __DEV__: JSON.stringify(process.env.NODE_ENV === 'development'),
  },
});
