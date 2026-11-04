import { defineConfig } from 'vite';

export default defineConfig({
  root: 'demo',
  server: { port: 5199, strictPort: false },
  define: { global: 'globalThis' },
  worker: { format: 'es' },
  build: { outDir: '../dist', emptyOutDir: true, target: 'es2022' },
});
