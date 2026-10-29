import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import dotenv from 'dotenv';
import { resolve } from 'node:path';

dotenv.config({ path: [resolve('.env'), resolve('../.env')], quiet: true });

export default defineConfig({
  plugins: [react()],
  build: { outDir: 'dist/web', emptyOutDir: true },
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://127.0.0.1:' + (process.env.PORT || '3000'),
      '/auth': 'http://127.0.0.1:' + (process.env.PORT || '3000'),
    },
  },
});
