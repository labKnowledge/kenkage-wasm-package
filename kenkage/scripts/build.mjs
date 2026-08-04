import {
  cpSync,
  mkdirSync,
  rmSync,
  existsSync,
  readdirSync,
  statSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { execSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const DIST = join(ROOT, 'dist');
const SRC = join(ROOT, 'src');
const CORE_WASM_SRC = join(SRC, 'dist', 'kenkage-core.wasm');
const FULL_WASM_SRC = join(SRC, 'dist', 'kenkage-full.wasm');

// Clean dist/
console.log('Cleaning dist/...');
if (existsSync(DIST)) rmSync(DIST, { recursive: true });
mkdirSync(DIST, { recursive: true });

// Copy WASM files
console.log('Copying WASM files...');
cpSync(CORE_WASM_SRC, join(DIST, 'kenkage-core.wasm'));
if (existsSync(FULL_WASM_SRC)) {
  cpSync(FULL_WASM_SRC, join(DIST, 'kenkage-full.wasm'));
} else {
  console.warn('  kenkage-full.wasm not found — run scripts/build-full.sh first. Skipping.');
}

// Entry points for esbuild
const entries = [
  { in: join(SRC, 'index.ts'), out: 'index' },
  { in: join(SRC, 'react.tsx'), out: 'react' },
  { in: join(SRC, 'next.ts'), out: 'next' },
];

// Shared externals
const nodeBuiltins = ['node:fs', 'node:path', 'node:url'];
const allExternal = ['react', 'react-dom', ...nodeBuiltins];

// Build ESM (neutral platform — works in browser and bundlers)
console.log('Building ESM...');
await Promise.all(
  entries.map(({ in: input }) =>
    build({
      entryPoints: [input],
      bundle: true,
      format: 'esm',
      platform: 'neutral',
      outdir: DIST,
      outExtension: { '.js': '.mjs' },
      external: allExternal,
      sourcemap: true,
      minify: false,
    }),
  ),
);

// Build CJS (Node.js platform)
console.log('Building CJS...');
await Promise.all(
  entries.map(({ in: input }) =>
    build({
      entryPoints: [input],
      bundle: true,
      format: 'cjs',
      platform: 'node',
      outdir: DIST,
      outExtension: { '.js': '.js' },
      external: allExternal,
      sourcemap: true,
      minify: false,
    }),
  ),
);

// Generate .d.ts files
console.log('Generating type declarations...');
try {
  execSync('npx tsc --emitDeclarationOnly --declaration --declarationMap --outDir dist', {
    cwd: ROOT,
    stdio: 'inherit',
  });
} catch (err) {
  console.warn('tsc declarations failed (non-fatal):', err.message);
}

console.log('Build complete!');

// List output files
function listFiles(dir, prefix = '') {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      listFiles(full, prefix + entry + '/');
    } else {
      console.log(`   ${prefix}${entry}  (${(stat.size / 1024).toFixed(1)} KB)`);
    }
  }
}
listFiles(DIST);
