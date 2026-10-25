import { rmSync } from 'node:fs';

import { build } from 'esbuild';

// Production build: ONE self-contained file, dist/beepers.mjs, holding our source and every dependency. It runs with
// the migrations (MIGRATIONS_DIR, ./drizzle here) and the built web UI (WEB_DIST) beside it; no node_modules, no
// package.json. See deploy/compose.yaml.
//
// PGlite isn't in it: production always has DATABASE_URL, and PGlite loads its WASM from files of its own. Drizzle's
// PGlite modules stay out too, so their import of PGlite stays behind db/index.ts's dynamic import() rather than being
// hoisted to the bundle's top. pg-native is pg's optional native driver, which we don't use.

rmSync('dist', { recursive: true, force: true });

await build({
  entryPoints: ['src/index.ts'],
  outfile: 'dist/beepers.mjs',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  minify: true,
  sourcemap: true,
  tsconfig: 'tsconfig.json',
  external: ['@electric-sql/pglite', 'drizzle-orm/pglite', 'drizzle-orm/pglite/*', 'pg-native'],
  // ESM output: recreate the CommonJS globals some bundled deps still reach for.
  banner: {
    js: [
      "import { createRequire as __createRequire } from 'node:module';",
      "import { fileURLToPath as __fileURLToPath } from 'node:url';",
      "import { dirname as __esbuildDirname } from 'node:path';",
      'const require = __createRequire(import.meta.url);',
      'const __filename = __fileURLToPath(import.meta.url);',
      'const __dirname = __esbuildDirname(__filename);',
    ].join('\n'),
  },
});

console.log('server bundle written to dist/beepers.mjs');
