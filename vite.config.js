import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  base: '/pdf-reader/',
  server: {
    host: '0.0.0.0',
    port: 5174,
    allowedHosts: ['ai-edu.dedyn.io'],
    proxy: {
      '/pdf-reader/api': {
        target: 'http://localhost:3007',
        changeOrigin: true,
        // App fetches use relative 'api/...' URLs, which resolve to
        // '/pdf-reader/api/...' under the /pdf-reader/ base — rewrite to the
        // server's actual /api/ mount (mirrors the nginx prod config).
        rewrite: (path) => path.replace(/^\/pdf-reader\/api/, '/api'),
        timeout: 180000,
        proxyTimeout: 180000
      },
      '/api': {
        target: 'http://localhost:3007',
        changeOrigin: true,
        timeout: 180000,
        proxyTimeout: 180000
      },
      '/pdf-reader/data/textbooks': 'http://localhost:3007',
      '/pdf-reader/data/past-papers': 'http://localhost:3007'
    }
  }
});
