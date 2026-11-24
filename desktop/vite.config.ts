import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const smE2eCapture = /^(1|true|yes|on)$/i.test(process.env.SM_E2E_CAPTURE || '');

export default defineConfig(({ command }) => ({
  // Electron loads the built renderer over file://, where Vite's default
  // absolute asset paths ('/assets/...') resolve to the filesystem root and fail
  // to load (white screen). Emit relative paths for the build; keep '/' for the
  // dev server so HMR and the http audits work normally.
  base: command === 'serve' ? '/' : './',
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: false,
    hmr: smE2eCapture ? false : undefined,
    watch: smE2eCapture ? { ignored: ['**/tsconfig.json', '**/electron/tsconfig.json'] } : undefined
  },
  build: {
    outDir: 'dist-renderer',
    rolldownOptions: {
      output: {
        codeSplitting: true
      }
    }
  }
}));
