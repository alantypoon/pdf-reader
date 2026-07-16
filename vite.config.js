import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  base: './',
  server: {
    proxy: {
      '/api': {
        target: 'http://localhost:3007',
        changeOrigin: true,
        timeout: 180000,
        proxyTimeout: 180000
      },
      '/pdf-reader/data': 'http://localhost:3007'
    }
  }
});
