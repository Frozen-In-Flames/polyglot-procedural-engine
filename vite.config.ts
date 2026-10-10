import { defineConfig } from 'vite';

export default defineConfig({
  root: 'demo',
  // Relative asset paths: the demo runs from file://, any static host,
  // or a subpath (e.g. GitHub Pages) with zero config.
  base: './',
  server: { port: 5173 },
  build: { outDir: '../dist-demo' },
});
