#!/usr/bin/env node
// Bundles the Electron entry points (main, preloads, renderer pages) with esbuild.
//   node scripts/build.mjs          one-shot build
//   node scripts/build.mjs --watch  rebuild on change
import { build, context } from 'esbuild';
import { cpSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const watch = process.argv.includes('--watch');
const production = process.argv.includes('--production') || process.env.NODE_ENV === 'production';

/** Native / runtime modules that must never be bundled. */
const nodeExternals = ['electron', 'uiohook-napi', 'get-windows'];

/** @type {import('esbuild').BuildOptions} */
const common = {
  absWorkingDir: root,
  bundle: true,
  sourcemap: production ? false : 'inline',
  minify: production,
  logLevel: 'info',
  legalComments: 'none',
  define: {
    'process.env.NODE_ENV': JSON.stringify(production ? 'production' : 'development'),
  },
};

/** @type {import('esbuild').BuildOptions[]} */
const targets = [
  {
    ...common,
    entryPoints: ['src/main/index.ts'],
    outfile: 'dist/main/index.mjs',
    platform: 'node',
    format: 'esm',
    target: 'node22',
    external: nodeExternals,
    // Electron's ESM main process has no __dirname; see src/main/paths.ts.
    banner: {
      js: "import { createRequire as __prajealaCreateRequire } from 'node:module'; const require = __prajealaCreateRequire(import.meta.url);",
    },
  },
  {
    ...common,
    entryPoints: ['src/preload/index.ts'],
    outfile: 'dist/preload/index.cjs',
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    external: ['electron'],
  },
  {
    ...common,
    entryPoints: ['src/preload/settings.ts'],
    outfile: 'dist/preload/settings.cjs',
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    external: ['electron'],
  },
  {
    ...common,
    entryPoints: ['src/preload/media.ts'],
    outfile: 'dist/preload/media.cjs',
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    external: ['electron'],
  },
  {
    ...common,
    entryPoints: ['src/renderer/media/main.ts'],
    outfile: 'dist/renderer/media.js',
    platform: 'browser',
    format: 'esm',
    target: 'chrome134',
  },
  {
    ...common,
    entryPoints: ['src/renderer/settings/main.ts'],
    outfile: 'dist/renderer/settings.js',
    platform: 'browser',
    format: 'esm',
    target: 'chrome134',
  },
  {
    ...common,
    entryPoints: ['src/renderer/main.ts'],
    outfile: 'dist/renderer/main.js',
    platform: 'browser',
    format: 'esm',
    target: 'chrome134',
    loader: { '.glsl': 'text', '.frag': 'text', '.vert': 'text' },
  },
];

function copyStatic() {
  mkdirSync(resolve(root, 'dist/renderer'), { recursive: true });
  cpSync(resolve(root, 'src/renderer/index.html'), resolve(root, 'dist/renderer/index.html'));
  const settingsHtml = resolve(root, 'src/renderer/settings.html');
  if (existsSync(settingsHtml)) cpSync(settingsHtml, resolve(root, 'dist/renderer/settings.html'));
  const mediaHtml = resolve(root, 'src/renderer/media.html');
  if (existsSync(mediaHtml)) cpSync(mediaHtml, resolve(root, 'dist/renderer/media.html'));
}

if (watch) {
  const contexts = await Promise.all(targets.map((t) => context(t)));
  copyStatic();
  await Promise.all(contexts.map((c) => c.watch()));
  console.log('[build] watching for changes…');
} else {
  await Promise.all(targets.map((t) => build(t)));
  copyStatic();
  console.log('[build] done');
}
