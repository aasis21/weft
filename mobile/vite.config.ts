import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pkg from './package.json';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// The phone and the laptop have to agree on what "the current build" means, so both read the same
// repo-root VERSION file the extension bundles inline (see extension/src/version.mjs). Falling back
// to the workspace package.json only matters if VERSION is ever missing.
const appVersion = (() => {
  try {
    return fs.readFileSync(path.resolve(__dirname, '../VERSION'), 'utf8').trim() || pkg.version;
  } catch {
    return pkg.version;
  }
})();

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
    'import.meta.env.VITE_APP_VERSION': JSON.stringify(appVersion),
  },
});
