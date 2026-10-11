#!/usr/bin/env node
// Assembles the one-page website in dist/web/: web/* plus the renderer bundle
// (which runs standalone with its in-page mock) and the app icon. Placeholders
// in web/index.html are filled from the environment:
//
//   PRAJEALA_BUY_URL        Lemon Squeezy checkout (default: GitHub README › Pro)
//   PRAJEALA_PRICE          price label, e.g. "€9" (default: "€9")
//   PRAJEALA_DOWNLOAD_URL   installers page (default: GitHub releases)
//
//   node scripts/build-web.mjs           (run `npm run build` first; `npm run build:web` does both)
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const out = resolve(root, 'dist/web');
const rendererDir = resolve(root, 'dist/renderer');

if (!existsSync(resolve(rendererDir, 'main.js'))) {
  console.error('[web] dist/renderer/main.js is missing — run `npm run build` first.');
  process.exit(1);
}

const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
const values = {
  BUY_URL: (process.env.PRAJEALA_BUY_URL ?? '').trim() || 'https://github.com/FasTuber/prajeala#pro',
  PRICE: (process.env.PRAJEALA_PRICE ?? '').trim() || '€9',
  DOWNLOAD_URL: (process.env.PRAJEALA_DOWNLOAD_URL ?? '').trim() || 'https://github.com/FasTuber/prajeala/releases/latest',
  VERSION: pkg.version,
};

const escapeHtml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

mkdirSync(resolve(out, 'renderer'), { recursive: true });
let html = readFileSync(resolve(root, 'web/index.html'), 'utf8');
for (const [key, value] of Object.entries(values)) html = html.replaceAll(`%${key}%`, escapeHtml(value));
const leftover = html.match(/%[A-Z_]+%/g);
if (leftover) {
  console.error(`[web] unfilled placeholders: ${[...new Set(leftover)].join(', ')}`);
  process.exit(1);
}
writeFileSync(resolve(out, 'index.html'), html);
cpSync(resolve(root, 'web/demo.js'), resolve(out, 'demo.js'));
cpSync(resolve(rendererDir, 'main.js'), resolve(out, 'renderer/main.js'));
cpSync(resolve(rendererDir, 'index.html'), resolve(out, 'renderer/index.html'));
cpSync(resolve(root, 'assets/icon-256.png'), resolve(out, 'icon-256.png'));
writeFileSync(resolve(out, '.nojekyll'), '');
console.log(`[web] dist/web ready (buy: ${values.BUY_URL}, price: ${values.PRICE}, downloads: ${values.DOWNLOAD_URL})`);
