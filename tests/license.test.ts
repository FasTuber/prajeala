import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  FREE_LIMITS,
  LS_OFFLINE_GRACE_DAYS,
  ONLINE_RECHECK_DAYS,
  applyTierLimits,
  assembleSignedLicense,
  base64UrlDecode,
  base64UrlEncode,
  buildLicenseInfo,
  clampIntensity,
  clampPalette,
  encodeSignedPayload,
  evaluateLicense,
  isIntensityAllowed,
  isLockedForTier,
  isPaletteAllowed,
  maskLicenseKey,
  matchesProduct,
  needsOnlineRecheck,
  normalizeLicenseInput,
  normalizeLicenseRecord,
  parseLemonSqueezyResponse,
  parseLicenseKey,
  signedMessage,
  validateSignedPayload,
  type LicenseRecord,
  type SignedLicensePayload,
} from '../src/shared/license';
import { DEFAULT_SETTINGS, INTENSITIES, PALETTES, type Settings } from '../src/shared/settings';
import { parseCli } from '../src/main/cli';
import { LemonSqueezyClient, type FetchLike } from '../src/main/lemon-squeezy';
import { loadLicenseConfig, normalizePublicKeyHex } from '../src/main/license-config';
import { makeVerifier, publicKeyFromHex } from '../src/main/license-crypto';
import { LicenseStore } from '../src/main/license-store';
import { stepIntensity } from '../src/main/shortcuts';
import { licenseLabel } from '../src/main/tray';

// ───────────────────────────── helpers ─────────────────────────────

const keyPair = generateKeyPairSync('ed25519');
const spki = keyPair.publicKey.export({ type: 'spki', format: 'der' });
const PUBLIC_HEX = Buffer.from(spki.subarray(spki.length - 32)).toString('hex');
const otherPair = generateKeyPairSync('ed25519');

const LS_KEY = '38b1460a-5104-4067-a91d-77b872934d51';
const NOW = new Date('2026-10-11T12:00:00Z');

function issue(overrides: Partial<SignedLicensePayload> = {}, signer = keyPair.privateKey): string {
  const payload: SignedLicensePayload = { v: 1, product: 'prajeala', tier: 'pro', issued: '2026-10-01', expires: null, ...overrides };
  const b64 = encodeSignedPayload(payload);
  const sig = sign(null, Buffer.from(signedMessage(b64)), signer);
  return assembleSignedLicense(b64, new Uint8Array(sig));
}

const verifier = makeVerifier(PUBLIC_HEX);
const evalOpts = { now: NOW, verify: verifier };

function record(key: string, extra: Partial<LicenseRecord> = {}): LicenseRecord {
  return { key, activatedAt: '2026-10-01T00:00:00Z', ...extra };
}

function lsBody(overrides: Record<string, unknown> = {}, kind: 'activated' | 'valid' | 'deactivated' = 'valid') {
  return {
    [kind]: true,
    error: null,
    license_key: { id: 1, status: 'active', key: LS_KEY, activation_limit: 3, activation_usage: 1, created_at: '2026-01-01', expires_at: null },
    instance: { id: 'inst-1', name: 'test', created_at: '2026-01-01' },
    meta: { store_id: 11, order_id: 2, product_id: 22, product_name: 'Prăjeală Pro', variant_id: 33, customer_name: 'Ana Pop', customer_email: 'ana@example.com' },
    ...overrides,
  };
}

interface FakeCall {
  url: string;
  fields: Record<string, string>;
}

function fakeFetch(handler: (endpoint: string, fields: Record<string, string>) => { status?: number; body?: unknown } | Error): {
  fetch: FetchLike;
  calls: FakeCall[];
} {
  const calls: FakeCall[] = [];
  const fetch: FetchLike = (url, init) => {
    const fields = Object.fromEntries(new URLSearchParams(init.body));
    calls.push({ url, fields });
    const endpoint = url.slice(url.lastIndexOf('/') + 1);
    const r = handler(endpoint, fields);
    if (r instanceof Error) return Promise.reject(r);
    const body = r.body;
    return Promise.resolve({
      status: r.status ?? 200,
      json: () => (body === undefined ? Promise.reject(new Error('no json')) : Promise.resolve(body)),
      text: () => Promise.resolve(JSON.stringify(body ?? '')),
    });
  };
  return { fetch, calls };
}

// ───────────────────────────── tiers ─────────────────────────────

describe('tier limits', () => {
  it('Free: classic only, medium max, no window fire; Pro: everything', () => {
    expect(FREE_LIMITS.palettes).toEqual(['classic']);
    for (const p of PALETTES) {
      expect(isPaletteAllowed('free', p)).toBe(p === 'classic');
      expect(isPaletteAllowed('pro', p)).toBe(true);
    }
    expect(isIntensityAllowed('free', 'low')).toBe(true);
    expect(isIntensityAllowed('free', 'medium')).toBe(true);
    expect(isIntensityAllowed('free', 'high')).toBe(false);
    expect(isIntensityAllowed('free', 'inferno')).toBe(false);
    for (const i of INTENSITIES) expect(isIntensityAllowed('pro', i)).toBe(true);
    expect(clampIntensity('free', 'inferno')).toBe('medium');
    expect(clampIntensity('free', 'low')).toBe('low');
    expect(clampPalette('free', 'plasma')).toBe('classic');
    expect(clampPalette('pro', 'plasma')).toBe('plasma');
  });

  it('applyTierLimits clamps without touching the input', () => {
    const stored: Settings = { ...DEFAULT_SETTINGS, palette: 'blue', intensity: 'inferno', burnActiveWindow: true, sparks: false };
    const snapshot = { ...stored };
    const free = applyTierLimits(stored, 'free');
    expect(free).toEqual({ ...stored, palette: 'classic', intensity: 'medium', burnActiveWindow: false });
    expect(stored).toEqual(snapshot);
    expect(applyTierLimits(stored, 'pro')).toEqual(stored);
    expect(applyTierLimits(stored, 'pro')).not.toBe(stored);
  });

  it('isLockedForTier flags only Pro values on Free', () => {
    expect(isLockedForTier('free', 'palette', 'ember')).toBe(true);
    expect(isLockedForTier('free', 'palette', 'classic')).toBe(false);
    expect(isLockedForTier('free', 'intensity', 'high')).toBe(true);
    expect(isLockedForTier('free', 'burnActiveWindow', true)).toBe(true);
    expect(isLockedForTier('free', 'burnActiveWindow', false)).toBe(false);
    expect(isLockedForTier('free', 'sparks', true)).toBe(false);
    expect(isLockedForTier('pro', 'palette', 'ember')).toBe(false);
  });

  it('shortcut intensity steps stay inside the tier', () => {
    expect(stepIntensity('low', 1, 'free')).toBe('medium');
    expect(stepIntensity('medium', 1, 'free')).toBe('medium');
    expect(stepIntensity('inferno', -1, 'free')).toBe('low'); // clamped to medium first, then one step down
    expect(stepIntensity('medium', 1, 'pro')).toBe('high');
    expect(stepIntensity('inferno', 1, 'pro')).toBe('inferno');
  });
});

// ───────────────────────────── key parsing ─────────────────────────────

describe('base64url', () => {
  it('round-trips arbitrary bytes and rejects garbage', () => {
    for (const len of [0, 1, 2, 3, 31, 32, 64, 100]) {
      const bytes = new Uint8Array(len).map((_, i) => (i * 37 + len) & 0xff);
      const enc = base64UrlEncode(bytes);
      expect(enc).not.toMatch(/[+/=]/);
      expect(Array.from(base64UrlDecode(enc)!)).toEqual(Array.from(bytes));
    }
    expect(base64UrlDecode('not base64!')).toBeNull();
    expect(base64UrlDecode('a+b/c=')).toBeNull();
  });
});

describe('parseLicenseKey', () => {
  it('recognises raw Lemon Squeezy keys (case-insensitive, whitespace tolerant)', () => {
    const parsed = parseLicenseKey(`  ${LS_KEY.toUpperCase()}\n`);
    expect(parsed?.kind).toBe('lemonsqueezy');
    expect(parsed?.kind === 'lemonsqueezy' && parsed.key).toBe(LS_KEY);
    expect(maskLicenseKey(parsed)).toBe('38b1460a…4d51');
  });

  it('parses a signed key and exposes the payload and the signed bytes', () => {
    const key = issue({ key: LS_KEY, name: 'Ana', email: 'ana@example.com', id: 'abc' });
    const parsed = parseLicenseKey(key);
    expect(parsed?.kind).toBe('signed');
    if (parsed?.kind !== 'signed') throw new Error('unreachable');
    expect(parsed.payload).toEqual({ v: 1, product: 'prajeala', tier: 'pro', id: 'abc', key: LS_KEY, name: 'Ana', email: 'ana@example.com', issued: '2026-10-01', expires: null });
    expect(parsed.signature.length).toBe(64);
    expect(new TextDecoder().decode(parsed.message)).toBe(key.slice(0, key.lastIndexOf('.')));
    expect(maskLicenseKey(parsed)).toMatch(/^PRAJ1…[A-Za-z0-9_-]{6}$/);
    // keys copied from e-mails arrive with line breaks
    expect(parseLicenseKey(key.replace(/(.{40})/g, '$1\n'))?.kind).toBe('signed');
  });

  it('rejects malformed input without throwing', () => {
    const good = issue();
    const [p, payload, sig] = good.split('.') as [string, string, string];
    for (const bad of [
      '',
      null,
      undefined,
      42,
      'hello',
      'PRAJ1',
      `${p}.${payload}`,
      `PRAJ2.${payload}.${sig}`,
      `${p}.${payload}.${sig.slice(0, -2)}`, // 63-byte signature
      `${p}.${base64UrlEncode(new TextEncoder().encode('not json'))}.${sig}`,
      `${p}.${base64UrlEncode(new TextEncoder().encode('{"v":2}'))}.${sig}`,
      `${p}..${sig}`,
      '38b1460a-5104-4067-a91d-77b872934d5', // short uuid
    ]) {
      expect(parseLicenseKey(bad)).toBeNull();
    }
    expect(normalizeLicenseInput('  a b\nc ')).toBe('abc');
  });

  it('validateSignedPayload enforces the schema', () => {
    const base = { v: 1, product: 'prajeala', tier: 'pro', issued: '2026-01-02' };
    expect(validateSignedPayload(base)).toEqual({ ...base, expires: null });
    expect(validateSignedPayload({ ...base, expires: '2027-01-01' })?.expires).toBe('2027-01-01');
    for (const bad of [
      null,
      [],
      { ...base, v: 2 },
      { ...base, tier: 'free' },
      { ...base, product: '' },
      { ...base, issued: '2026-1-2' },
      { ...base, issued: '2026-13-45' },
      { ...base, expires: 'soon' },
      { ...base, email: 5 },
    ]) {
      expect(validateSignedPayload(bad)).toBeNull();
    }
  });

  it('encodeSignedPayload is canonical (independent of input key order)', () => {
    const a = encodeSignedPayload({ v: 1, product: 'prajeala', tier: 'pro', issued: '2026-10-01', expires: null, email: 'x@y.z' });
    const b = encodeSignedPayload({ email: 'x@y.z', expires: null, issued: '2026-10-01', tier: 'pro', product: 'prajeala', v: 1 });
    expect(a).toBe(b);
  });
});

// ───────────────────────────── crypto ─────────────────────────────

describe('Ed25519 verifier', () => {
  it('accepts a genuine signature and rejects forgeries / wrong keys', () => {
    const key = issue({ email: 'ana@example.com' });
    const parsed = parseLicenseKey(key);
    if (parsed?.kind !== 'signed') throw new Error('unreachable');
    expect(verifier(parsed.message, parsed.signature)).toBe(true);
    const tampered = new Uint8Array(parsed.signature);
    tampered[3] = (tampered[3] ?? 0) ^ 0x01;
    expect(verifier(parsed.message, tampered)).toBe(false);
    expect(verifier(new TextEncoder().encode('other'), parsed.signature)).toBe(false);

    const forged = parseLicenseKey(issue({}, otherPair.privateKey));
    if (forged?.kind !== 'signed') throw new Error('unreachable');
    expect(verifier(forged.message, forged.signature)).toBe(false);
  });

  it('a payload edit after signing invalidates the key', () => {
    const key = issue({ expires: '2026-10-05' });
    const [p, , sig] = key.split('.');
    const forgedPayload = encodeSignedPayload({ v: 1, product: 'prajeala', tier: 'pro', issued: '2026-10-01', expires: '2099-01-01' });
    const forged = parseLicenseKey(`${p}.${forgedPayload}.${sig}`);
    if (forged?.kind !== 'signed') throw new Error('unreachable');
    expect(verifier(forged.message, forged.signature)).toBe(false);
  });

  it('returns null (unsupported) when no public key is configured', () => {
    expect(makeVerifier('')(new Uint8Array(1), new Uint8Array(64))).toBeNull();
    expect(makeVerifier('zz')(new Uint8Array(1), new Uint8Array(64))).toBeNull();
    expect(publicKeyFromHex(PUBLIC_HEX)).not.toBeNull();
    expect(publicKeyFromHex(PUBLIC_HEX.slice(1))).toBeNull();
  });
});

// ───────────────────────────── evaluation ─────────────────────────────

describe('evaluateLicense', () => {
  it('no record → free/none; unparseable → free/invalid', () => {
    expect(evaluateLicense(null, evalOpts)).toMatchObject({ tier: 'free', status: 'none', kind: 'none' });
    expect(evaluateLicense(record('garbage'), evalOpts)).toMatchObject({ tier: 'free', status: 'invalid' });
  });

  it('valid signed key → pro, with name/email/expiry from the payload', () => {
    const e = evaluateLicense(record(issue({ name: 'Ana', email: 'ana@example.com', expires: '2027-01-01' })), evalOpts);
    expect(e).toMatchObject({ tier: 'pro', status: 'active', kind: 'signed', name: 'Ana', email: 'ana@example.com', expiresAt: '2027-01-01' });
    expect(e.message).toContain('2027-01-01');
    expect(evaluateLicense(record(issue()), evalOpts).message).toContain('perpetual');
  });

  it('signed key: forged, wrong product, expired, revoked, unsupported', () => {
    expect(evaluateLicense(record(issue({}, otherPair.privateKey)), evalOpts)).toMatchObject({ tier: 'free', status: 'invalid' });
    expect(evaluateLicense(record(issue({ product: 'other-app' })), evalOpts)).toMatchObject({ tier: 'free', status: 'invalid' });
    expect(evaluateLicense(record(issue({ expires: '2026-10-10' })), evalOpts)).toMatchObject({ tier: 'free', status: 'expired', expiresAt: '2026-10-10' });
    // valid through the end of the expiry day (UTC)
    expect(evaluateLicense(record(issue({ expires: '2026-10-11' })), evalOpts).tier).toBe('pro');
    expect(evaluateLicense(record(issue({ key: LS_KEY }), { lastOnlineResult: 'invalid', lsStatus: 'disabled' }), evalOpts)).toMatchObject({ tier: 'free', status: 'revoked' });
    expect(evaluateLicense(record(issue({ key: LS_KEY }), { lastOnlineResult: 'invalid', lsStatus: 'expired' }), evalOpts)).toMatchObject({ tier: 'free', status: 'expired' });
    // "not found" / unknown rejections are reported but the signature still wins
    const notFound = evaluateLicense(record(issue({ key: LS_KEY }), { lastOnlineResult: 'invalid', lsStatus: null, lastOnlineError: 'license_key not found.' }), evalOpts);
    expect(notFound.tier).toBe('pro');
    expect(notFound.message).toContain('not found');
    // a network error never downgrades a signed key
    expect(evaluateLicense(record(issue(), { lastOnlineResult: 'error' }), evalOpts).tier).toBe('pro');
    expect(evaluateLicense(record(issue()), { now: NOW, verify: () => null })).toMatchObject({ tier: 'free', status: 'unsupported' });
  });

  it('raw Lemon Squeezy key: activation, grace period and revocation', () => {
    expect(evaluateLicense(record(LS_KEY), evalOpts)).toMatchObject({ tier: 'free', status: 'unverified' });
    const active = record(LS_KEY, { instanceId: 'inst-1', lastOnlineCheckAt: '2026-10-01T00:00:00Z', lastOnlineResult: 'valid', lsStatus: 'active', customerName: 'Ana' });
    const e = evaluateLicense(active, evalOpts);
    expect(e).toMatchObject({ tier: 'pro', status: 'active', kind: 'lemonsqueezy', name: 'Ana' });
    expect(e.graceUntil).toBe(new Date(Date.parse('2026-10-01T00:00:00Z') + LS_OFFLINE_GRACE_DAYS * 86_400_000).toISOString());
    // last check too long ago → unverified until the next successful check
    const stale = { ...active, lastOnlineCheckAt: '2026-08-01T00:00:00Z' };
    expect(evaluateLicense(stale, evalOpts)).toMatchObject({ tier: 'free', status: 'unverified' });
    // a failed network check keeps the old anchor but does not revoke
    expect(evaluateLicense({ ...active, lastOnlineResult: 'error' }, evalOpts).tier).toBe('pro');
    expect(evaluateLicense({ ...active, lastOnlineResult: 'invalid' }, evalOpts)).toMatchObject({ tier: 'free', status: 'revoked' });
    expect(evaluateLicense({ ...active, lsStatus: 'disabled' }, evalOpts)).toMatchObject({ tier: 'free', status: 'revoked' });
    expect(evaluateLicense({ ...active, lsStatus: 'expired' }, evalOpts)).toMatchObject({ tier: 'free', status: 'expired' });
    expect(evaluateLicense({ ...active, lsExpiresAt: '2026-01-01T00:00:00Z' }, evalOpts)).toMatchObject({ tier: 'free', status: 'expired' });
    expect(evaluateLicense({ ...active, lsExpiresAt: '2027-01-01T00:00:00Z' }, evalOpts)).toMatchObject({ tier: 'pro', expiresAt: '2027-01-01T00:00:00Z' });
  });

  it('needsOnlineRecheck follows the cadence and the setting', () => {
    const active = record(LS_KEY, { instanceId: 'i', lastOnlineCheckAt: '2026-10-10T00:00:00Z', lastOnlineResult: 'valid' });
    expect(needsOnlineRecheck(active, NOW, true)).toBe(false);
    const old = new Date(NOW.getTime() + ONLINE_RECHECK_DAYS * 86_400_000);
    expect(needsOnlineRecheck(active, old, true)).toBe(true);
    expect(needsOnlineRecheck(active, old, false)).toBe(false);
    expect(needsOnlineRecheck({ ...active, lastOnlineCheckAt: null }, NOW, true)).toBe(true);
    expect(needsOnlineRecheck({ ...active, lastOnlineResult: 'invalid' }, old, true)).toBe(false);
    expect(needsOnlineRecheck(record(LS_KEY), old, true)).toBe(false); // never activated
    expect(needsOnlineRecheck(record(issue()), old, true)).toBe(false); // signed without LS key
    expect(needsOnlineRecheck(record(issue({ key: LS_KEY })), old, true)).toBe(true);
    expect(needsOnlineRecheck(null, old, true)).toBe(false);
  });

  it('buildLicenseInfo never leaks the full key and mirrors the record', () => {
    const key = issue({ email: 'ana@example.com' });
    const rec = record(key, { lastOnlineCheckAt: '2026-10-02T00:00:00Z', lastOnlineResult: 'valid' });
    const info = buildLicenseInfo(rec, evaluateLicense(rec, evalOpts), { onlineCheckEnabled: false, signedKeysSupported: true, buyUrl: 'https://x', busy: false });
    expect(JSON.stringify(info)).not.toContain(key);
    expect(info).toMatchObject({ tier: 'pro', status: 'active', email: 'ana@example.com', onlineCheckEnabled: false, buyUrl: 'https://x', lastOnlineResult: 'valid', activatedAt: rec.activatedAt, canCheckOnline: false });
    const withLs = record(issue({ key: LS_KEY }));
    expect(buildLicenseInfo(withLs, evaluateLicense(withLs, evalOpts), { onlineCheckEnabled: true, signedKeysSupported: true, buyUrl: '', busy: false }).canCheckOnline).toBe(true);
    const raw = record(LS_KEY);
    expect(buildLicenseInfo(raw, evaluateLicense(raw, evalOpts), { onlineCheckEnabled: true, signedKeysSupported: true, buyUrl: '', busy: false }).canCheckOnline).toBe(true);
    expect(licenseLabel(info)).toBe('Licence: Pro');
    expect(licenseLabel({ ...info, tier: 'free', status: 'expired' })).toContain('expired');
  });

  it('normalizeLicenseRecord tolerates garbage', () => {
    expect(normalizeLicenseRecord(null)).toBeNull();
    expect(normalizeLicenseRecord({})).toBeNull();
    expect(normalizeLicenseRecord({ key: 42 })).toBeNull();
    const r = normalizeLicenseRecord({ key: ` ${LS_KEY} `, instanceId: 7, lastOnlineResult: 'maybe', lsStatus: 'weird', activatedAt: '2026-01-01T00:00:00Z' });
    expect(r).toMatchObject({ key: LS_KEY, instanceId: null, lastOnlineResult: null, lsStatus: null, activatedAt: '2026-01-01T00:00:00Z' });
  });
});

// ───────────────────────────── Lemon Squeezy ─────────────────────────────

describe('parseLemonSqueezyResponse', () => {
  it('maps the documented shape', () => {
    const r = parseLemonSqueezyResponse(lsBody({}, 'activated'));
    expect(r).toMatchObject({ ok: true, error: null, status: 'active', instanceId: 'inst-1', storeId: 11, productId: 22, variantId: 33, customerName: 'Ana Pop', customerEmail: 'ana@example.com', activationLimit: 3, activationUsage: 1 });
    expect(matchesProduct(r, 11, 22)).toBe(true);
    expect(matchesProduct(r, 11, 99)).toBe(false);
    expect(matchesProduct(r, 12, 0)).toBe(false);
    expect(matchesProduct(r)).toBe(true);
  });

  it('errors and garbage', () => {
    expect(parseLemonSqueezyResponse({ valid: false, error: 'license_key not found.' })).toMatchObject({ ok: false, error: 'license_key not found.', status: 'unknown' });
    expect(parseLemonSqueezyResponse(null)).toMatchObject({ ok: false, error: expect.stringContaining('unexpected') });
    expect(parseLemonSqueezyResponse('nope').ok).toBe(false);
    expect(parseLemonSqueezyResponse({ valid: true, license_key: { status: 'DISABLED' } }).status).toBe('disabled');
    // rejections without license_key.status: the reason is read from the error text
    expect(parseLemonSqueezyResponse({ valid: false, error: 'This license key has been disabled.' }).status).toBe('disabled');
    expect(parseLemonSqueezyResponse({ valid: false, error: 'license_key expired' }).status).toBe('expired');
    expect(parseLemonSqueezyResponse({ valid: false, error: 'license_key not found.' }).status).toBe('unknown');
  });
});

describe('LemonSqueezyClient', () => {
  it('posts form-encoded fields and distinguishes network failures', async () => {
    const { fetch, calls } = fakeFetch((endpoint, fields) => {
      if (endpoint === 'activate') return { body: lsBody({}, 'activated') };
      if (endpoint === 'validate') return { status: 404, body: { valid: false, error: `license_key not found (${fields.license_key}).` } };
      return new Error('ECONNREFUSED');
    });
    const client = new LemonSqueezyClient({ fetch, baseUrl: 'https://example.test/v1/licenses/' });
    const a = await client.activate(LS_KEY, 'my-pc');
    expect(a).toMatchObject({ ok: true, network: false, instanceId: 'inst-1' });
    expect(calls[0]).toEqual({ url: 'https://example.test/v1/licenses/activate', fields: { license_key: LS_KEY, instance_name: 'my-pc' } });
    const v = await client.validate(LS_KEY, 'inst-1');
    expect(v).toMatchObject({ ok: false, network: false, error: expect.stringContaining('not found') });
    expect(calls[1]?.fields).toEqual({ license_key: LS_KEY, instance_id: 'inst-1' });
    const d = await client.deactivate(LS_KEY, 'inst-1');
    expect(d).toMatchObject({ ok: false, network: true, error: expect.stringContaining('ECONNREFUSED') });
  });

  it('treats 5xx and unparseable bodies as transient', async () => {
    const { fetch } = fakeFetch(() => ({ status: 503 }));
    const r = await new LemonSqueezyClient({ fetch }).validate(LS_KEY, null);
    expect(r).toMatchObject({ ok: false, network: true });
  });
});

// ───────────────────────────── store ─────────────────────────────

describe('LicenseStore', () => {
  let dir: string;
  let filePath: string;
  let onlineCheck = true;
  const clock = { now: NOW };
  const config = { publicKeyHex: PUBLIC_HEX, storeId: 11, productId: 22, buyUrl: 'https://buy.test' };

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'prajeala-license-'));
    filePath = path.join(dir, 'prajeala-license.json');
    onlineCheck = true;
    clock.now = NOW;
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  function makeStore(fetchImpl: FetchLike, persist = true) {
    return new LicenseStore({
      filePath,
      config,
      client: new LemonSqueezyClient({ fetch: fetchImpl }),
      persist,
      onlineCheckEnabled: () => onlineCheck,
      now: () => clock.now,
      instanceName: 'test-machine',
    });
  }

  it('starts Free, accepts a signed key offline, persists it with 0600 and reloads it', async () => {
    const { fetch, calls } = fakeFetch(() => new Error('offline'));
    const store = makeStore(fetch);
    expect(store.load()).toMatchObject({ tier: 'free', status: 'none', signedKeysSupported: true, buyUrl: 'https://buy.test' });
    const changes: string[] = [];
    store.onChange((info) => changes.push(info.tier));
    const r = await store.activate(issue({ email: 'ana@example.com' }));
    expect(r.ok).toBe(true);
    expect(r.info).toMatchObject({ tier: 'pro', status: 'active', email: 'ana@example.com' });
    expect(changes).toEqual(['pro']);
    expect(calls).toHaveLength(0); // no LS key embedded → no network at all
    expect(existsSync(filePath)).toBe(true);
    const saved = JSON.parse(readFileSync(filePath, 'utf8'));
    expect(saved.key).toMatch(/^PRAJ1\./);
    const reloaded = makeStore(fetch);
    expect(reloaded.load().tier).toBe('pro');
  });

  it('rejects forged / expired signed keys and does not store them', async () => {
    const store = makeStore(fakeFetch(() => new Error('offline')).fetch);
    store.load();
    const forged = await store.activate(issue({}, otherPair.privateKey));
    expect(forged).toMatchObject({ ok: false, error: expect.stringContaining('signature') });
    const expired = await store.activate(issue({ expires: '2020-01-01' }));
    expect(expired).toMatchObject({ ok: false, error: expect.stringContaining('expired') });
    const nonsense = await store.activate('hello');
    expect(nonsense.ok).toBe(false);
    expect(store.tier).toBe('free');
    expect(existsSync(filePath)).toBe(false);
  });

  it('activates a raw Lemon Squeezy key online, re-validates and honours revocation', async () => {
    let status = 'active';
    const { fetch, calls } = fakeFetch((endpoint) => {
      if (endpoint === 'activate') return { body: lsBody({}, 'activated') };
      if (endpoint === 'validate') {
        return status === 'active'
          ? { body: lsBody() }
          : { status: 400, body: { valid: false, error: 'license_key disabled', license_key: { status: 'disabled' } } };
      }
      return { body: lsBody({}, 'deactivated') };
    });
    const store = makeStore(fetch);
    store.load();
    const r = await store.activate(LS_KEY);
    expect(r.ok).toBe(true);
    expect(r.info).toMatchObject({ tier: 'pro', kind: 'lemonsqueezy', name: 'Ana Pop', maskedKey: '38b1460a…4d51' });
    expect(calls[0]?.fields).toEqual({ license_key: LS_KEY, instance_name: 'test-machine' });
    expect(JSON.parse(readFileSync(filePath, 'utf8')).instanceId).toBe('inst-1');

    // Re-activating the same key reuses the instance (validate, not activate).
    const again = await store.activate(LS_KEY);
    expect(again.ok).toBe(true);
    expect(calls[1]?.url.endsWith('/validate')).toBe(true);
    expect(calls[1]?.fields.instance_id).toBe('inst-1');

    // Explicit check: still valid.
    clock.now = new Date(NOW.getTime() + 2 * 86_400_000);
    expect((await store.checkOnline()).ok).toBe(true);
    expect(store.get().lastOnlineCheckAt).toBe(clock.now.toISOString());

    // Refund → revoked → Free.
    status = 'disabled';
    const revoked = await store.checkOnline();
    expect(revoked.ok).toBe(false);
    expect(store.get()).toMatchObject({ tier: 'free', status: 'revoked' });

    // Removing the key calls deactivate and deletes the file.
    const removed = await store.deactivate();
    expect(removed.ok).toBe(true);
    expect(calls.at(-1)?.url.endsWith('/deactivate')).toBe(true);
    expect(existsSync(filePath)).toBe(false);
    expect(store.tier).toBe('free');
  });

  it('a raw key cannot be activated offline; network errors keep the previous state', async () => {
    let online = false;
    const { fetch } = fakeFetch(() => (online ? { body: lsBody({}, 'activated') } : new Error('ENOTFOUND')));
    const store = makeStore(fetch);
    store.load();
    const offline = await store.activate(LS_KEY);
    expect(offline).toMatchObject({ ok: false, error: expect.stringContaining('internet') });
    expect(store.tier).toBe('free');
    online = true;
    expect((await store.activate(LS_KEY)).ok).toBe(true);
    online = false;
    const check = await store.checkOnline();
    expect(check.ok).toBe(false);
    expect(store.get()).toMatchObject({ tier: 'pro', lastOnlineResult: 'error' });
    // The grace anchor is not moved by a failed check.
    expect(store.get().lastOnlineCheckAt).toBe(NOW.toISOString());
  });

  it('rejects keys from another store/product', async () => {
    const { fetch } = fakeFetch(() => ({ body: lsBody({ meta: { store_id: 99, product_id: 22 } }, 'activated') }));
    const store = makeStore(fetch);
    store.load();
    const r = await store.activate(LS_KEY);
    expect(r).toMatchObject({ ok: false, error: expect.stringContaining('different product') });
  });

  it('persist=false never touches the disk and refresh() reflects the online-check setting', async () => {
    const store = makeStore(fakeFetch(() => new Error('offline')).fetch, false);
    store.load();
    expect((await store.activate(issue())).ok).toBe(true);
    expect(existsSync(filePath)).toBe(false);
    expect(store.get().onlineCheckEnabled).toBe(true);
    onlineCheck = false;
    store.refresh();
    expect(store.get().onlineCheckEnabled).toBe(false);
  });

  it('reports signed keys as unsupported when the build has no public key', async () => {
    const store = new LicenseStore({
      filePath,
      config: { ...config, publicKeyHex: '' },
      client: new LemonSqueezyClient({ fetch: fakeFetch(() => new Error('offline')).fetch }),
      onlineCheckEnabled: () => true,
      now: () => NOW,
    });
    expect(store.load().signedKeysSupported).toBe(false);
    const r = await store.activate(issue());
    expect(r).toMatchObject({ ok: false, error: expect.stringContaining('public key') });
  });
});

// ───────────────────────────── config & cli ─────────────────────────────

describe('license config / cli', () => {
  it('loadLicenseConfig reads env with sane fallbacks', () => {
    const c = loadLicenseConfig({ PRAJEALA_LICENSE_PUBLIC_KEY: PUBLIC_HEX.toUpperCase(), PRAJEALA_LS_STORE_ID: '11', PRAJEALA_LS_PRODUCT_ID: 'x', PRAJEALA_BUY_URL: ' https://shop.test ' });
    expect(c).toEqual({ publicKeyHex: PUBLIC_HEX, storeId: 11, productId: 0, buyUrl: 'https://shop.test' });
    const d = loadLicenseConfig({});
    expect(d.publicKeyHex).toBe('');
    expect(d.buyUrl).toMatch(/^https:\/\//);
    expect(normalizePublicKeyHex('0x' + PUBLIC_HEX)).toBe(PUBLIC_HEX);
    expect(normalizePublicKeyHex('nope')).toBe('');
  });

  it('parseCli understands --license and --license-window', () => {
    const cli = parseCli(['.', `--license=${LS_KEY}`, '--license-window', '--no-sandbox']);
    expect(cli.license).toBe(LS_KEY);
    expect(cli.licenseWindow).toBe(true);
    expect(parseCli(['--license=']).license).toBeNull();
    expect(parseCli([]).license).toBeNull();
  });
});
