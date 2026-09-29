import { defineConfig } from 'vite';

// In dev, /api is proxied to the FastAPI service so no CORS setup is needed.
export default defineConfig({
  server: {
    port: 5173,
    proxy: {
      '/api': { target: process.env.DEPTHWIZARD_API || 'http://localhost:8000', changeOrigin: true },
    },
  },
  build: { chunkSizeWarningLimit: 900 },
});
