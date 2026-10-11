#!/usr/bin/env node
// Offline licence keys for Prăjeală Pro (giveaways, press, sponsors, manual sales).
//
//   npm run license -- keygen                    create the Ed25519 key pair (once) and
//                                                write the public key into src/shared/product.ts
//   npm run license -- issue --to "Ana <ana@example.com>"
//                                                print a PRJ1-… key for that person
//   npm run license -- verify PRJ1-…             check a key against src/shared/product.ts
//
// Options:
//   --private=PATH   private key file (default: ~/.prajeala/license-private.pem,
//                    or $PRAJEALA_LICENSE_PRIVATE_KEY_FILE)
//   --id=ID          key id for `issue` (default: random); list leaked ids in
//                    PRODUCT.revokedOfflineKeyIds to revoke them
//   --force          `keygen`: overwrite an existing private key (invalidates every key issued so far!)
//
// The private key never belongs in the repository. Back it up somewhere safe
// (password manager): without it you cannot issue new keys for this public key.
import { createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, sign, verify } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PRODUCT_FILE = resolve(root, 'src/shared/product.ts');
const PREFIX = 'PRJ1-';

/** @returns {{ privateKeyPem: string, publicKeySpkiBase64: string }} */
export function generateKeyPair() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return {
    privateKeyPem: privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
    publicKeySpkiBase64: publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
  };
}

export function publicKeyFromPrivate(privateKeyPem) {
  return createPublicKey(createPrivateKey(privateKeyPem)).export({ format: 'der', type: 'spki' }).toString('base64');
}

/**
 * @param {string} privateKeyPem
 * @param {{ to: string, id?: string, at?: string }} details
 */
export function issueKey(privateKeyPem, details) {
  const to = String(details.to ?? '').trim();
  if (!to) throw new Error('--to is required (name or e-mail of the licensee)');
  const payload = {
    v: 1,
    id: details.id ?? randomBytes(6).toString('hex'),
    to,
    at: details.at ?? new Date().toISOString().slice(0, 10),
  };
  const signed = PREFIX + Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const signature = sign(null, Buffer.from(signed, 'ascii'), createPrivateKey(privateKeyPem));
  return { key: `${signed}.${signature.toString('base64url')}`, payload };
}

export function verifyKey(key, publicKeySpkiBase64) {
  const k = String(key).replace(/\s+/g, '');
  const dot = k.lastIndexOf('.');
  if (!k.startsWith(PREFIX) || dot < 0) return { ok: false, reason: 'malformed' };
  const publicKey = createPublicKey({ key: Buffer.from(publicKeySpkiBase64, 'base64'), format: 'der', type: 'spki' });
  const ok = verify(null, Buffer.from(k.slice(0, dot), 'ascii'), publicKey, Buffer.from(k.slice(dot + 1), 'base64url'));
  if (!ok) return { ok: false, reason: 'bad signature' };
  return { ok: true, payload: JSON.parse(Buffer.from(k.slice(PREFIX.length, dot), 'base64url').toString('utf8')) };
}

function readConfiguredPublicKey() {
  const text = readFileSync(PRODUCT_FILE, 'utf8');
  const m = /offlinePublicKey:\s*'([^']*)'/.exec(text);
  return m ? m[1] : '';
}

function writeConfiguredPublicKey(base64) {
  const text = readFileSync(PRODUCT_FILE, 'utf8');
  const next = text.replace(/(offlinePublicKey:\s*)'[^']*'/, `$1'${base64}'`);
  if (next === text && !text.includes(`'${base64}'`)) throw new Error(`could not find offlinePublicKey in ${PRODUCT_FILE}`);
  writeFileSync(PRODUCT_FILE, next);
}

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') continue;
    const m = /^--([^=]+)(?:=(.*))?$/.exec(a);
    if (!m) {
      out._.push(a);
      continue;
    }
    const [, name, value] = m;
    if (value !== undefined) out[name] = value;
    else if (argv[i + 1] !== undefined && !argv[i + 1].startsWith('--') && name !== 'force') out[name] = argv[++i];
    else out[name] = true;
  }
  return out;
}

function defaultPrivatePath() {
  return process.env.PRAJEALA_LICENSE_PRIVATE_KEY_FILE || resolve(homedir(), '.prajeala', 'license-private.pem');
}

function main(argv) {
  const args = parseArgs(argv);
  const command = args._[0];
  const privatePath = resolve(String(args.private ?? defaultPrivatePath()));

  if (command === 'keygen') {
    if (existsSync(privatePath) && !args.force) {
      const pub = publicKeyFromPrivate(readFileSync(privatePath, 'utf8'));
      writeConfiguredPublicKey(pub);
      console.log(`[license] using the existing private key ${privatePath}`);
      console.log('[license] public key written to src/shared/product.ts (offlinePublicKey).');
      return 0;
    }
    const { privateKeyPem, publicKeySpkiBase64 } = generateKeyPair();
    mkdirSync(dirname(privatePath), { recursive: true });
    writeFileSync(privatePath, privateKeyPem, { mode: 0o600 });
    try {
      chmodSync(privatePath, 0o600);
    } catch {
      /* Windows */
    }
    writeConfiguredPublicKey(publicKeySpkiBase64);
    console.log(`[license] private key: ${privatePath}  ← back it up, never commit it`);
    console.log('[license] public key written to src/shared/product.ts (offlinePublicKey). Commit that file.');
    return 0;
  }

  if (command === 'issue') {
    if (!existsSync(privatePath)) {
      console.error(`[license] no private key at ${privatePath}. Run \`npm run license -- keygen\` first.`);
      return 1;
    }
    const privateKeyPem = readFileSync(privatePath, 'utf8');
    const configured = readConfiguredPublicKey();
    if (configured && configured !== publicKeyFromPrivate(privateKeyPem)) {
      console.error('[license] this private key does not match offlinePublicKey in src/shared/product.ts — the app would reject the key.');
      return 1;
    }
    const { key, payload } = issueKey(privateKeyPem, { to: args.to, id: typeof args.id === 'string' ? args.id : undefined });
    console.error(`[license] issued id=${payload.id} to="${payload.to}" at=${payload.at}`);
    console.log(key);
    return 0;
  }

  if (command === 'verify') {
    const key = args._[1];
    const pub = typeof args.pub === 'string' ? args.pub : readConfiguredPublicKey();
    if (!key || !pub) {
      console.error('[license] usage: verify <key> (needs offlinePublicKey in src/shared/product.ts or --pub=…)');
      return 1;
    }
    const res = verifyKey(key, pub);
    console.log(JSON.stringify(res, null, 2));
    return res.ok ? 0 : 1;
  }

  console.error('usage: npm run license -- keygen | issue --to "Name <email>" [--id=ID] | verify <key>');
  return 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (err) {
    console.error(`[license] ${err instanceof Error ? err.message : err}`);
    process.exitCode = 1;
  }
}
