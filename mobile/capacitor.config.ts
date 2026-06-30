import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'dev.aasis21.helm',
  appName: 'Helm',
  webDir: 'dist',
  server: {
    androidScheme: 'https',
  },
  android: {
    captureInput: true,
    webContentsDebuggingEnabled: true,
  },
};

export default config;
