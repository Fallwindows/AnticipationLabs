import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.dirname(fileURLToPath(import.meta.url));
const pkg = path.resolve(root, '..');

const shared = {
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  external: ['electron'],
  sourcemap: false,
  logLevel: 'info',
};

await build({
  ...shared,
  entryPoints: [path.join(pkg, 'electron', 'main.ts')],
  outfile: path.join(pkg, 'dist-electron', 'main.cjs'),
});

await build({
  ...shared,
  entryPoints: [path.join(pkg, 'electron', 'preload.ts')],
  outfile: path.join(pkg, 'dist-electron', 'preload.cjs'),
});
