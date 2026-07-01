import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  base: './',
  server: {
    proxy: {
      '/api': 'http://localhost:3001',
      '/pdf-reader/data': 'http://localhost:3001'
    }
  }
});
