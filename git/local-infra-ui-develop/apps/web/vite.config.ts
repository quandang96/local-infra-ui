import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

export default defineConfig({
  plugins: [vue()],
  server: {
    host: '0.0.0.0',
    port: 5173,
    watch:
      process.env.VITE_USE_POLLING === 'true'
        ? { usePolling: true, interval: 500 }
        : undefined,
    proxy: { '/api': process.env.VITE_API_PROXY_TARGET || 'http://127.0.0.1:3000' },
  },
  build: { outDir: 'dist', emptyOutDir: true },
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
});
