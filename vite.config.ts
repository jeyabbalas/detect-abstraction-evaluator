/// <reference types="vitest/config" />
import { defineConfig } from 'vite';

// Relative base: the built app works from any sub-path (GitHub Pages project
// sites live under /<repo>/) and from a local `vite preview`.
export default defineConfig({
  base: './',
  optimizeDeps: {
    // DuckDB-WASM ships its own worker/WASM artifacts; pre-bundling hides them.
    exclude: ['@duckdb/duckdb-wasm'],
  },
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 2500,
  },
  worker: {
    format: 'es',
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    testTimeout: 60_000,
  },
});
