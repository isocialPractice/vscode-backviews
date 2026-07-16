/**
 * Builds both bundles:
 *  - dist/extension.js  (extension host, Node CJS, `vscode` external)
 *  - media/webview.js   (browser IIFE: game, renderer, and the bundled
 *    cmd-backedges core)
 *
 * cmd-backedges is aliased to its TypeScript source because the published
 * package's `main` field points at dist/index.js while tsc actually emits
 * dist/src/index.js; bundling from source sidesteps the broken entry point.
 */
import esbuild from 'esbuild';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const watch = process.argv.includes('--watch');

const common = {
  bundle: true,
  sourcemap: true,
  logLevel: 'info',
  alias: {
    'cmd-backedges': path.join(root, '..', 'cmd-backedges', 'src', 'index.ts'),
  },
};

const extensionCtx = {
  ...common,
  entryPoints: [path.join(root, 'src', 'extension.ts')],
  outfile: path.join(root, 'dist', 'extension.js'),
  platform: 'node',
  format: 'cjs',
  target: 'node18',
  external: ['vscode'],
};

const webviewCtx = {
  ...common,
  entryPoints: [path.join(root, 'src', 'webview', 'main.ts')],
  outfile: path.join(root, 'media', 'webview.js'),
  platform: 'browser',
  format: 'iife',
  target: 'es2022',
};

if (watch) {
  const [a, b] = await Promise.all([esbuild.context(extensionCtx), esbuild.context(webviewCtx)]);
  await Promise.all([a.watch(), b.watch()]);
  console.log('watching for changes...');
} else {
  await Promise.all([esbuild.build(extensionCtx), esbuild.build(webviewCtx)]);
}
