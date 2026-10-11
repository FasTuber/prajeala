#!/usr/bin/env node
// Generates the Ed25519 key pair used to sign Prăjeală Pro licence keys.
//
//   node scripts/license-keygen.mjs             write license/private.key + license/public.key
//   node scripts/license-keygen.mjs --force     overwrite an existing pair
//   node scripts/license-keygen.mjs --out=DIR   somewhere else than license/
//
// `license/` is git-ignored. Keep private.key secret (password manager / CI secret);
// the public key (64 hex chars) is compiled into the app by scripts/build.mjs,
// either from license/public.key or from PRAJEALA_LICENSE_PUBLIC_KEY.
import { generateKeyPairSync } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const option = (name) => argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const outDir = resolve(root, option('out') ?? 'license');
const force = argv.includes('--force');

const privatePath = resolve(outDir, 'private.key');
const publicPath = resolve(outDir, 'public.key');
if (!force && (existsSync(privatePath) || existsSync(publicPath))) {
  console.error(`[license] ${outDir} already holds a key pair — pass --force to overwrite (this invalidates every key signed so far).`);
  process.exit(1);
}

const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const spki = publicKey.export({ type: 'spki', format: 'der' });
const rawPublicHex = Buffer.from(spki.subarray(spki.length - 32)).toString('hex');
const privatePem = privateKey.export({ type: 'pkcs8', format: 'pem' });

mkdirSync(outDir, { recursive: true });
writeFileSync(privatePath, privatePem, { mode: 0o600 });
writeFileSync(publicPath, rawPublicHex + '\n');

console.log(`[license] private key → ${privatePath}  (keep it secret!)`);
console.log(`[license] public key  → ${publicPath}`);
console.log(`[license] PRAJEALA_LICENSE_PUBLIC_KEY=${rawPublicHex}`);
