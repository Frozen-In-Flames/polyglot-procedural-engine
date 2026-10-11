import { defineConfig } from 'vite';

// First Light: the game build. Bundles games/first-light with the engine's
// public surface; zero new runtime dependencies.
export default defineConfig({
  root: '.',
  base: './',
  build: { outDir: 'dist' },
});
