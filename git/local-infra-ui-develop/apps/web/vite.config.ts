import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

export default defineConfig({
  plugins: [vue()],
  server: {
    port: 5173,
    proxy: { '/api': 'http://127.0.0.1:3000' },
  },
  build: { outDir: 'dist', emptyOutDir: true },
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
});
