import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

const apiTarget = process.env.VITE_API_PROXY_TARGET || 'http://127.0.0.1:3002';

export default defineConfig({
  plugins: [vue()],
  server: {
    host: '0.0.0.0',
    port: 3001,
    watch:
      process.env.VITE_USE_POLLING === 'true'
        ? { usePolling: true, interval: 500 }
        : undefined,
    proxy: {
      '/api': apiTarget,
      '/kafka-ui-embed': apiTarget,
      '/keycloak-embed': { target: apiTarget, xfwd: true },
      '/mailhog-embed': apiTarget,
    },
  },
  build: { outDir: 'dist', emptyOutDir: true },
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
});
