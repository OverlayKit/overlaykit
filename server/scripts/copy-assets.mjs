// Post-build: copy non-TypeScript runtime assets (the JSON Schemas under
// validation/schemas, etc.) from src/ → dist/, preserving structure. `tsc` only
// emits compiled .ts; these files are read at runtime via __dirname-relative
// paths (see validation/validator.ts) and must sit alongside the compiled JS.
// Without this, `node dist/index.js` crashes with ENOENT on the schemas.
import { cp } from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const src = path.join(root, 'src');
const dist = path.join(root, 'dist');

await cp(src, dist, {
  recursive: true,
  // Descend into every directory; copy only non-.ts files (schemas, etc.).
  filter: (source) => !source.endsWith('.ts'),
});

console.log('[copy-assets] copied non-TS assets from src/ → dist/');
