import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pkg from './package.json';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [react()],
  esbuild: {
    pure: process.env.NODE_ENV === 'production' ? ['console.log', 'console.debug'] : [],
  },
  resolve: {
    alias: [{ find: '@', replacement: path.resolve(__dirname, './src') }],
    extensions: ['.mjs', '.js', '.mts', '.ts', '.jsx', '.tsx', '.json'],
  },
  server: {
    host: true,
    port: 5173,
    strictPort: true,
  },
  build: {
    target: 'esnext',
    outDir: 'dist',
    assetsDir: 'assets',
    sourcemap: true,
    rollupOptions: {
      output: {
        format: 'es',
        manualChunks: {
          'vendor-react': ['react', 'react-dom'],
          'vendor-capacitor': ['@capacitor/core', '@capacitor/preferences'],
          'vendor-relay': ['@supabase/supabase-js'],
        },
      },
    },
  },
  define: {
    'import.meta.env.VITE_APP_VERSION': JSON.stringify(pkg.version),
  },
});
