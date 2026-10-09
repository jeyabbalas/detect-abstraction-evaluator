/// <reference types="vitest/config" />
import { createReadStream, existsSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { defineConfig, type Plugin } from 'vite';

/**
 * Dev-server only: exposes the git-ignored examples/experiment_1 folder so the
 * landing page can load it without a file picker. Never part of a build.
 */
function localExamples(): Plugin {
  const base = resolve(import.meta.dirname, 'examples');
  const root = join(base, 'experiment_1');
  const walk = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      const full = join(dir, name);
      return statSync(full).isDirectory() ? walk(full) : [full];
    });
  return {
    name: 'local-examples',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/__examples', (req, res, next) => {
        if (!existsSync(root)) {
          res.statusCode = 404;
          res.end('examples/experiment_1 not found');
          return;
        }
        const url = decodeURIComponent((req.url ?? '').split('?')[0] ?? '');
        if (url === '/list') {
          const files = walk(root).map((f) => relative(base, f).split(sep).join('/'));
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify(files));
          return;
        }
        if (url.startsWith('/file/')) {
          const full = resolve(base, url.slice('/file/'.length));
          if (!full.startsWith(base + sep) || !existsSync(full)) {
            res.statusCode = 404;
            res.end();
            return;
          }
          createReadStream(full).pipe(res);
          return;
        }
        next();
      });
    },
  };
}

// Relative base: the built app works from any sub-path (GitHub Pages project
// sites live under /<repo>/) and from a local `vite preview`.
export default defineConfig({
  base: './',
  plugins: [localExamples()],
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
