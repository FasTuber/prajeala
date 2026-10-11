#!/usr/bin/env node
// Bundles the three Electron entry points with esbuild.
//   node scripts/build.mjs          one-shot build
//   node scripts/build.mjs --watch  rebuild on change
import { build, context } from 'esbuild';
import { cpSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const watch = process.argv.includes('--watch');
const production = process.argv.includes('--production') || process.env.NODE_ENV === 'production';

/** Native / runtime modules that must never be bundled. */
const nodeExternals = ['electron', 'uiohook-napi', 'get-windows'];

/**
 * Licensing configuration baked into the main bundle (see src/main/license-config.ts).
 * Environment variables win; the Ed25519 public key may also live in the git-ignored
 * `license/public.key` written by `npm run license:keygen`.
 */
function licenseBuildConfig() {
  let publicKey = (process.env.PRAJEALA_LICENSE_PUBLIC_KEY ?? '').trim();
  const keyFile = resolve(root, 'license/public.key');
  if (!publicKey && existsSync(keyFile)) publicKey = readFileSync(keyFile, 'utf8').trim();
  if (!/^[0-9a-fA-F]{64}$/.test(publicKey)) {
    if (publicKey) console.warn('[build] PRAJEALA_LICENSE_PUBLIC_KEY is not 64 hex chars; ignoring it');
    else if (!watch) console.warn('[build] no licence public key configured: signed licence keys will be rejected (see README › Pro)');
    publicKey = '';
  }
  return {
    licensePublicKey: publicKey.toLowerCase(),
    lsStoreId: Number(process.env.PRAJEALA_LS_STORE_ID ?? 0) || 0,
    lsProductId: Number(process.env.PRAJEALA_LS_PRODUCT_ID ?? 0) || 0,
    buyUrl: (process.env.PRAJEALA_BUY_URL ?? '').trim(),
  };
}

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
    __PRAJEALA_BUILD__: JSON.stringify(licenseBuildConfig()),
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
    entryPoints: ['src/renderer/main.ts'],
    outfile: 'dist/renderer/main.js',
    platform: 'browser',
    format: 'esm',
    target: 'chrome134',
    loader: { '.glsl': 'text', '.frag': 'text', '.vert': 'text' },
  },
  {
    ...common,
    entryPoints: ['src/renderer/license/main.ts'],
    outfile: 'dist/renderer/license.js',
    platform: 'browser',
    format: 'esm',
    target: 'chrome134',
  },
];

function copyStatic() {
  mkdirSync(resolve(root, 'dist/renderer'), { recursive: true });
  for (const page of ['index.html', 'license.html', 'settings.html']) {
    const src = resolve(root, 'src/renderer', page);
    if (existsSync(src)) cpSync(src, resolve(root, 'dist/renderer', page));
  }
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
