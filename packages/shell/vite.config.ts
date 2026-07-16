import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// base './' so the built index.html works when loaded from file:// inside Electron.
export default defineConfig({
  plugins: [react()],
  base: './',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    strictPort: true,
  },
});
