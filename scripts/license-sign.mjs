#!/usr/bin/env node
// Issues a signed Prăjeală Pro licence key (format `PRAJ1.<payload>.<signature>`).
//
//   node scripts/license-sign.mjs --email=ana@example.com --name="Ana Pop"
//   node scripts/license-sign.mjs --key=<lemon squeezy key> --email=... --expires=2027-12-31
//   node scripts/license-sign.mjs --verify=PRAJ1....            check a key against license/public.key
//
// Options:
//   --key=UUID         Lemon Squeezy licence key to embed (enables optional online re-checks)
//   --email, --name    shown in the app's licence window
//   --id=STRING        your own licence id (default: random)
//   --issued=DATE      YYYY-MM-DD (default: today)
//   --expires=DATE     YYYY-MM-DD (default: perpetual)
//   --private=PATH     PKCS8 PEM (default: license/private.key or $PRAJEALA_LICENSE_PRIVATE_KEY contents)
//   --public=PATH      64-hex public key for --verify (default: license/public.key or $PRAJEALA_LICENSE_PUBLIC_KEY)
//   --json             print the payload as well
//
// The payload encoding must match src/shared/license.ts (`encodeSignedPayload`):
// canonical key order v, product, tier, id?, key?, name?, email?, issued, expires.
import { createPrivateKey, createPublicKey, randomBytes, sign, verify } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const option = (name) => argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const flag = (name) => argv.includes(`--${name}`);

const PREFIX = 'PRAJ1';
const PRODUCT = 'prajeala';
const SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

const b64url = (buf) => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
const fromB64url = (s) => Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s) && Number.isFinite(Date.parse(`${s}T00:00:00Z`));

function loadPublicKey() {
  const file = option('public') ?? resolve(root, 'license/public.key');
  let hex = process.env.PRAJEALA_LICENSE_PUBLIC_KEY?.trim();
  if (option('public') || !hex) hex = existsSync(file) ? readFileSync(file, 'utf8').trim() : hex;
  if (!hex || !/^[0-9a-fA-F]{64}$/.test(hex)) {
    console.error('[license] no public key: run `npm run license:keygen` or set PRAJEALA_LICENSE_PUBLIC_KEY');
    process.exit(1);
  }
  return createPublicKey({ key: Buffer.concat([SPKI_PREFIX, Buffer.from(hex, 'hex')]), format: 'der', type: 'spki' });
}

function loadPrivateKey() {
  const file = option('private') ?? resolve(root, 'license/private.key');
  let pem = process.env.PRAJEALA_LICENSE_PRIVATE_KEY;
  if (option('private') || !pem) {
    if (!existsSync(file)) {
      console.error(`[license] private key not found at ${file} — run \`npm run license:keygen\` first`);
      process.exit(1);
    }
    pem = readFileSync(file, 'utf8');
  }
  return createPrivateKey(pem);
}

// ── verify mode ─────────────────────────────────────────────────────────────
const toVerify = option('verify');
if (toVerify) {
  const parts = toVerify.trim().split('.');
  if (parts.length !== 3 || parts[0] !== PREFIX) {
    console.error('[license] not a PRAJ1 signed key');
    process.exit(1);
  }
  const ok = verify(null, Buffer.from(`${PREFIX}.${parts[1]}`, 'utf8'), loadPublicKey(), fromB64url(parts[2]));
  try {
    console.log(JSON.stringify(JSON.parse(fromB64url(parts[1]).toString('utf8')), null, 2));
  } catch {
    console.log('[license] payload is not valid JSON');
  }
  console.log(ok ? '[license] signature OK' : '[license] signature INVALID');
  process.exit(ok ? 0 : 1);
}

// ── sign mode ───────────────────────────────────────────────────────────────
const issued = option('issued') ?? new Date().toISOString().slice(0, 10);
const expires = option('expires') ?? null;
if (!isDate(issued) || (expires !== null && !isDate(expires))) {
  console.error('[license] --issued / --expires must be YYYY-MM-DD');
  process.exit(1);
}
const payload = { v: 1, product: PRODUCT, tier: 'pro' };
payload.id = option('id') ?? randomBytes(6).toString('hex');
const lsKey = option('key');
if (lsKey) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(lsKey)) {
    console.error('[license] --key must be a Lemon Squeezy licence key (UUID)');
    process.exit(1);
  }
  payload.key = lsKey.toLowerCase();
}
if (option('name')) payload.name = option('name');
if (option('email')) payload.email = option('email');
payload.issued = issued;
payload.expires = expires;

const payloadB64 = b64url(Buffer.from(JSON.stringify(payload), 'utf8'));
const signature = sign(null, Buffer.from(`${PREFIX}.${payloadB64}`, 'utf8'), loadPrivateKey());
const key = `${PREFIX}.${payloadB64}.${b64url(signature)}`;

if (flag('json')) console.log(JSON.stringify(payload, null, 2));
console.log(key);
