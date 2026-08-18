/**
 * Copies non-TypeScript runtime assets that `tsc` does not emit — hand-authored
 * `.cjs` files at the CJS/ESM boundary (e.g. src/shared/fts-utils.cjs) — from src/
 * into dist/, so the COMPILED hook (run via `node`, not `tsx`) can resolve them.
 *
 * Pure Node so it works as an npm script on any OS.
 */
import { readdirSync, mkdirSync, copyFileSync, existsSync } from 'fs';
import path from 'path';

const SRC = path.join('src', 'shared');
const DST = path.join('dist', 'shared');

if (existsSync(SRC)) {
  mkdirSync(DST, { recursive: true });
  for (const file of readdirSync(SRC)) {
    if (file.endsWith('.cjs')) {
      copyFileSync(path.join(SRC, file), path.join(DST, file));
      console.log(`[copy-assets] ${path.join(SRC, file)} -> ${path.join(DST, file)}`);
    }
  }
}
