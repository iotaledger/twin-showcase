import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  root: 'client',
  build: {
    outDir: '../server/public',
    emptyOutDir: true,
    rollupOptions: {
      output: {
        manualChunks: {
          'vendor-react': ['react', 'react-dom'],
          'vendor-maps': ['react-simple-maps', 'd3-geo'],
          'vendor-icons': ['lucide-react'],
          'vendor-motion': ['framer-motion'],
        },
      },
    },
  },
  server: {
    port: 3000,
    proxy: {
      '/api': 'http://localhost:4000',
    },
  },
});
