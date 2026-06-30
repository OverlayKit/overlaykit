import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import path from 'path'

// https://vitejs.dev/config/
export default defineConfig({
    plugins: [vue()],
    resolve: {
        alias: {
            '@': path.resolve(__dirname, './src'),
            '@client': path.resolve(__dirname, '../client/src'),
            '@shared': path.resolve(__dirname, '../shared'),
            '@overlaykit/renderer': path.resolve(__dirname, '../shared'),
            '@overlaykit/ui': path.resolve(__dirname, '../shared/ui'),
        },
    },
    define: {
        __DEV__: process.env.NODE_ENV !== 'production',
    },
    server: {
        port: 5174,
        strictPort: true, // deterministic port; fail loudly instead of silent fallback
    }
})
