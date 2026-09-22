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
      // Phase 4: where an agent reports their position.
      '/api/location': {
        target: 'http://localhost:4004',
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/api\/location/, ''),
      },
      // Phase 6: accepting and declining collection offers.
      '/api/engine': {
        target: 'http://localhost:4005',
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/api\/engine/, ''),
      },
      // Phase 7: donation status and timeline.
      '/api/tracking': {
        target: 'http://localhost:4006',
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/api\/tracking/, '/tracking'),
      },
      // Phase 10: the read-only monitoring view.
      '/api/monitoring': {
        target: 'http://localhost:4006',
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/api\/monitoring/, '/monitoring'),
      },
      // Phase 7: the notification inbox.
      '/api/notify': {
        target: 'http://localhost:4007',
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/api\/notify/, '/notifications'),
      },
    },
  },
});
