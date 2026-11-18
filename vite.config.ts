import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  root: 'web',
  plugins: [react()],
  build: {
    outDir: '../dist/web',
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    proxy: {
      // The API (including the SSE stream and OIDC callback) runs on :3000 in dev.
      '/api': { target: 'http://localhost:3000' },
    },
  },
});
