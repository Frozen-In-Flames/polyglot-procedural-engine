import { defineConfig } from 'vite';

// Workshop: the V5 session-proof build. Bundles games/workshop with the
// engine's public surface; zero new runtime dependencies.
export default defineConfig({
  root: '.',
  base: './',
  build: { outDir: 'dist' },
});
