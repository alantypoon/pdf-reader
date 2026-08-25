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
