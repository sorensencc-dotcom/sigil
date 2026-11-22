import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

// On Windows a lowercase drive in the working directory (c:\dev\...) makes vitest load itself and the
// setup file under two path casings, and every spec fails with "Vitest failed to find the current suite".
// Vitest has already loaded by the time this config runs, so changing directory or root here cannot repair it.
const cwd = process.cwd();
if (process.env.VITEST && process.platform === 'win32' && /^[a-z]:/.test(cwd)) {
  const upper = cwd.charAt(0).toUpperCase() + cwd.slice(1);
  throw new Error(`Run vitest from an uppercase drive path: cd '${upper}' (current directory is ${cwd})`);
}

export default defineConfig({
  plugins: [react()],
  build: { outDir: 'dist', sourcemap: false },
  server: { port: 5173, strictPort: true },
  test: {
    environment: 'jsdom',
    globals: true,
    include: ['src/**/*.spec.{ts,tsx}'],
    setupFiles: ['./src/setupTests.ts'],
  },
});
