import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

// Forwards /api to the server in dev, so the browser and the server can share one origin
// with no CORS configuration needed. Production serves the built app from the same
// server or behind a reverse proxy that does the same forwarding.
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': { target: 'http://localhost:3001', changeOrigin: true },
    },
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/testing/setup.ts'],
    css: false,
  },
});
