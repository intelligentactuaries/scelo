import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig({
  plugins: [react()],
  root: '.',
  publicDir: 'public',
  resolve: {
    alias: {
      '@shared': path.resolve(__dirname, 'src/shared'),
      '@client': path.resolve(__dirname, 'src/client'),
    },
  },
  server: {
    port: 5190,
    strictPort: true,
    proxy: {
      '/api': {
        target: 'http://localhost:3010',
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: true,
    // styles.css names the SN Pro arrows file once per weight; inlined, that
    // is five base64 copies. Emit it as one file instead.
    assetsInlineLimit: (file) => (file.endsWith('sn-pro-arrows.woff2') ? false : undefined),
  },
});
