import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The browser talks to ONE origin (the dev server) and Vite forwards to each
// service. Without this the app would call three different ports directly,
// which means CORS configuration on every service and three base URLs to keep
// in sync. In production api-gateway (Phase 12) plays exactly this role, so
// the frontend's view of the world does not change when it is introduced.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api/auth': {
        target: 'http://localhost:4001',
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/api\/auth/, '/auth'),
      },
      '/api/donations': {
        target: 'http://localhost:4002',
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/api\/donations/, '/donations'),
      },
      // Donation photos are served by donation-service off disk.
      '/uploads': {
        target: 'http://localhost:4002',
        changeOrigin: true,
      },
      '/api/geo': {
        target: 'http://localhost:4003',
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/api\/geo/, ''),
      },
    },
  },
});
