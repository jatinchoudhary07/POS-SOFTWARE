import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv } from 'vite';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  return {
    plugins: [react(), tailwindcss()],
    server: {
      // Listen on the network so the app can be opened from another computer during development.
      host: true,
      port: 5173,
      // The browser calls /api/... on the Vite dev server, which forwards to Express.
      // This keeps the frontend and backend on one origin (no CORS setup needed).
      proxy: {
        '/api': {
          target: env.API_PROXY_TARGET || 'http://localhost:3001',
          changeOrigin: false,
          headers: {
            'X-Forwarded-Host': 'localhost:5173',
          },
        },
        // Socket.IO (real-time updates) goes through the same proxy, as a WebSocket.
        '/socket.io': { target: env.API_PROXY_TARGET || 'http://localhost:3001', ws: true, changeOrigin: false },
      },
    },
    test: {
      environment: 'node',
      include: ['src/**/*.test.ts'],
    },
  };
});
