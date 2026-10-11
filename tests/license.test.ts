import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { generateKeyPair, issueKey, verifyKey } from '../scripts/license.mjs';
import { LicenseManager, parseLicenseFile } from '../src/main/license/license-manager';
import {
  activateStoreKey,
  deactivateStoreKey,
  validateStoreKey,
  type FetchLike,
} from '../src/main/license/lemonsqueezy';
import { verifyOfflineKey } from '../src/main/license/offline';
import { DAY_MS, classifyKey, cleanKey, maskKey, parseOfflinePayload, trialState } from '../src/shared/license';
import { PRODUCT, type ProductConfig } from '../src/shared/product';

const STORE_KEY = '38b1460a-5104-4067-a91d-77b872934d51';
const LS = { storeId: 1234, productId: 5678 };

const { privateKeyPem, publicKeySpkiBase64 } = generateKeyPair();
const other = generateKeyPair();

// ───────────────────────────── fake Lemon Squeezy ─────────────────────────────

interface Call {
  url: string;
  params: Record<string, string>;
}

type Reply = { status: number; body: unknown } | Error;

function fakeFetch(replies: Record<string, Reply | ((params: Record<string, string>) => Reply)>): FetchLike & { calls: Call[] } {
  const calls: Call[] = [];
  const fn: FetchLike = async (url, init) => {
    const params = Object.fromEntries(new URLSearchParams(init.body));
    calls.push({ url, params });
    expect(init.headers.Accept).toBe('application/json');
    const endpoint = url.split('/').pop() ?? '';
    const entry = replies[endpoint];
    const reply = typeof entry === 'function' ? entry(params) : entry;
    if (!reply) throw new Error(`unexpected call to ${endpoint}`);
    if (reply instanceof Error) throw reply;
    return { ok: reply.status >= 200 && reply.status < 300, status: reply.status, json: async () => reply.body };
  };
  return Object.assign(fn, { calls });
}

const meta = (overrides: Record<string, unknown> = {}) => ({
  store_id: LS.storeId,
  product_id: LS.productId,
  customer_name: 'Ana Pop',
  customer_email: 'ana@example.com',
  ...overrides,
});

const activated = (overrides: Record<string, unknown> = {}): Reply => ({
  status: 200,
  body: {
    activated: true,
    error: null,
    license_key: { id: 1, status: 'active', key: STORE_KEY, activation_limit: 3, activation_usage: 1 },
    instance: { id: 'inst-1', name: 'x', created_at: '2026-10-11T00:00:00Z' },
    meta: meta(overrides),
  },
});

const valid: Reply = {
  status: 200,
  body: { valid: true, error: null, license_key: { status: 'active' }, instance: { id: 'inst-1' }, meta: meta() },
};

// ───────────────────────────── shared helpers ─────────────────────────────

describe('licence helpers', () => {
  it('classifies keys', () => {
    expect(classifyKey(STORE_KEY)).toBe('store');
    expect(classifyKey(` ${STORE_KEY.toUpperCase()}\n`)).toBe('store');
    expect(classifyKey(issueKey(privateKeyPem, { to: 'x' }).key)).toBe('offline');
    expect(classifyKey('hello')).toBe('unknown');
    expect(classifyKey('')).toBe('unknown');
  });

  it('cleans and masks keys', () => {
    expect(cleanKey(' ab\n cd\t')).toBe('abcd');
    expect(maskKey(STORE_KEY)).toBe('••••-77b872934d51');
    expect(maskKey('')).toBe('');
    expect(maskKey(STORE_KEY)).not.toContain('38b1460a');
  });

  it('computes the trial window', () => {
    const start = Date.UTC(2026, 9, 1);
    expect(trialState(start, start, 7)).toEqual({ active: true, daysLeft: 7, endsAt: start + 7 * DAY_MS });
    expect(trialState(start, start + 6.5 * DAY_MS, 7).daysLeft).toBe(1);
    expect(trialState(start, start + 7 * DAY_MS, 7).active).toBe(false);
    expect(trialState(start, start - 30 * DAY_MS, 7).daysLeft).toBe(7); // clock moved backwards
    expect(trialState(start, start, 0).active).toBe(false);
  });

  it('validates offline payloads', () => {
    expect(parseOfflinePayload({ v: 1, id: 'a1', to: 'Ana', at: '2026-10-11' })).toEqual({ v: 1, id: 'a1', to: 'Ana', at: '2026-10-11' });
    expect(parseOfflinePayload({ v: 2, id: 'a1', to: 'Ana', at: '2026-10-11' })).toBeNull();
    expect(parseOfflinePayload({ v: 1, id: '', to: 'Ana', at: '2026-10-11' })).toBeNull();
    expect(parseOfflinePayload({ v: 1, id: 'a', to: ' ', at: '2026-10-11' })).toBeNull();
    expect(parseOfflinePayload({ v: 1, id: 'a', to: 'Ana', at: 'yesterday' })).toBeNull();
    expect(parseOfflinePayload(null)).toBeNull();
  });
});

// ───────────────────────────── offline keys ─────────────────────────────

describe('offline keys', () => {
  it('round-trips through scripts/license.mjs and the app verifier', () => {
    const { key, payload } = issueKey(privateKeyPem, { to: 'Ana Pop <ana@example.com>', id: 'k1', at: '2026-10-11' });
    expect(key.startsWith('PRJ1-')).toBe(true);
    expect(payload).toEqual({ v: 1, id: 'k1', to: 'Ana Pop <ana@example.com>', at: '2026-10-11' });
    expect(verifyKey(key, publicKeySpkiBase64).ok).toBe(true);
    const res = verifyOfflineKey(key, publicKeySpkiBase64);
    expect(res).toEqual({ ok: true, payload });
    // tolerant to line breaks from e-mail clients
    expect(verifyOfflineKey(`${key.slice(0, 40)}\n${key.slice(40)}`, publicKeySpkiBase64).ok).toBe(true);
  });

  it('rejects keys signed by somebody else, edited keys and revoked ids', () => {
    const { key } = issueKey(privateKeyPem, { to: 'Ana', id: 'k2' });
    expect(verifyOfflineKey(key, other.publicKeySpkiBase64)).toMatchObject({ ok: false, code: 'invalid' });

    const [signed, sig] = key.split('.');
    const forged = Buffer.from(JSON.stringify({ v: 1, id: 'k2', to: 'Mallory', at: '2026-10-11' })).toString('base64url');
    expect(verifyOfflineKey(`PRJ1-${forged}.${sig}`, publicKeySpkiBase64)).toMatchObject({ ok: false, code: 'invalid' });
    expect(verifyOfflineKey(`${signed}.AAAA`, publicKeySpkiBase64)).toMatchObject({ ok: false, code: 'invalid' });
    expect(verifyOfflineKey('PRJ1-nope', publicKeySpkiBase64)).toMatchObject({ ok: false, code: 'malformed' });
    expect(verifyOfflineKey(key, publicKeySpkiBase64, ['k2'])).toMatchObject({ ok: false, code: 'invalid' });
  });

  it('is disabled without a public key', () => {
    const { key } = issueKey(privateKeyPem, { to: 'Ana' });
    expect(verifyOfflineKey(key, '')).toMatchObject({ ok: false, code: 'not-configured' });
    expect(verifyOfflineKey(key, 'bm90IGEga2V5')).toMatchObject({ ok: false, code: 'not-configured' });
  });
});

// ───────────────────────────── Lemon Squeezy client ─────────────────────────────

describe('Lemon Squeezy client', () => {
  it('activates a key of the configured product', async () => {
    const f = fakeFetch({ activate: activated() });
    const res = await activateStoreKey(STORE_KEY, 'Prăjeală · Linux · abc', LS, f);
    expect(res).toMatchObject({ ok: true, code: 'activated', instanceId: 'inst-1', licensee: 'Ana Pop' });
    expect(f.calls[0]!.url).toBe('https://api.lemonsqueezy.com/v1/licenses/activate');
    expect(f.calls[0]!.params).toEqual({ license_key: STORE_KEY, instance_name: 'Prăjeală · Linux · abc' });
  });

  it('rejects keys of other stores/products and frees the slot it consumed', async () => {
    const f = fakeFetch({ activate: activated({ store_id: 999 }), deactivate: { status: 200, body: { deactivated: true } } });
    const res = await activateStoreKey(STORE_KEY, 'n', LS, f);
    expect(res).toMatchObject({ ok: false, code: 'wrong-product', definitive: true });
    await Promise.resolve();
    expect(f.calls.map((c) => c.url.split('/').pop())).toEqual(['activate', 'deactivate']);

    const g = fakeFetch({ activate: activated({ product_id: 1 }), deactivate: { status: 200, body: { deactivated: true } } });
    expect(await activateStoreKey(STORE_KEY, 'n', LS, g)).toMatchObject({ code: 'wrong-product' });
    // productId 0 accepts any product of the store
    expect(await activateStoreKey(STORE_KEY, 'n', { storeId: LS.storeId, productId: 0 }, g)).toMatchObject({ ok: true });
  });

  it('maps negative answers', async () => {
    const limit = fakeFetch({
      activate: { status: 400, body: { activated: false, error: 'This license key has reached the activation limit.', meta: meta() } },
    });
    expect(await activateStoreKey(STORE_KEY, 'n', LS, limit)).toMatchObject({ ok: false, code: 'limit', definitive: true });

    const unknown = fakeFetch({ activate: { status: 404, body: { activated: false, error: 'license_key not found.' } } });
    expect(await activateStoreKey(STORE_KEY, 'n', LS, unknown)).toMatchObject({ ok: false, code: 'invalid', definitive: true });

    const expired = fakeFetch({ validate: { status: 400, body: { valid: false, error: 'expired', license_key: { status: 'expired' } } } });
    expect(await validateStoreKey(STORE_KEY, 'inst-1', LS, expired)).toMatchObject({ ok: false, code: 'expired', definitive: true });

    const disabled = fakeFetch({ validate: { status: 200, body: { valid: true, license_key: { status: 'disabled' }, meta: meta() } } });
    expect(await validateStoreKey(STORE_KEY, 'inst-1', LS, disabled)).toMatchObject({ ok: false, code: 'disabled' });
  });

  it('treats outages as transient', async () => {
    const down = fakeFetch({ validate: { status: 503, body: null } });
    expect(await validateStoreKey(STORE_KEY, 'inst-1', LS, down)).toMatchObject({ ok: false, code: 'network', definitive: false });
    const offline = fakeFetch({ validate: new Error('getaddrinfo ENOTFOUND') });
    expect(await validateStoreKey(STORE_KEY, 'inst-1', LS, offline)).toMatchObject({ ok: false, code: 'network', definitive: false });
    const throttled = fakeFetch({ activate: { status: 429, body: {} } });
    expect(await activateStoreKey(STORE_KEY, 'n', LS, throttled)).toMatchObject({ definitive: false });
  });

  it('validates with the instance id and deactivates', async () => {
    const f = fakeFetch({ validate: valid, deactivate: { status: 200, body: { deactivated: true, meta: meta() } } });
    expect(await validateStoreKey(STORE_KEY, 'inst-1', LS, f)).toMatchObject({ ok: true, licensee: 'Ana Pop' });
    expect(f.calls[0]!.params).toEqual({ license_key: STORE_KEY, instance_id: 'inst-1' });
    expect(await deactivateStoreKey(STORE_KEY, 'inst-1', f)).toMatchObject({ ok: true, code: 'deactivated' });
  });
});

// ───────────────────────────── LicenseManager ─────────────────────────────

describe('LicenseManager', () => {
  let dir: string;
  let file: string;
  let clock: number;
  const T0 = Date.UTC(2026, 9, 11, 12);

  const product = (patch: Partial<ProductConfig> = {}): ProductConfig => ({
    ...PRODUCT,
    trialDays: 7,
    lemonSqueezy: LS,
    offlinePublicKey: publicKeySpkiBase64,
    revokedOfflineKeyIds: [],
    ...patch,
  });

  const manager = (fetch: FetchLike = fakeFetch({}), patch: Partial<ProductConfig> = {}, extra: object = {}) =>
    new LicenseManager({ filePath: file, persist: true, product: product(patch), fetch, platform: 'linux', now: () => clock, ...extra });

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'prajeala-license-'));
    file = path.join(dir, 'prajeala-license.json');
    clock = T0;
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('starts a trial on first run, persists it and ends it on time', () => {
    const m = manager();
    expect(m.load()).toMatchObject({ tier: 'trial', pro: true, trialDaysLeft: 7, storeConfigured: true, offlineConfigured: true });
    expect(m.isFirstRun).toBe(true);
    const saved = parseLicenseFile(JSON.parse(readFileSync(file, 'utf8')));
    expect(saved?.firstRunAt).toBe(T0);

    clock = T0 + 3 * DAY_MS;
    const again = manager();
    expect(again.load()).toMatchObject({ tier: 'trial', trialDaysLeft: 4 });
    expect(again.isFirstRun).toBe(false);

    clock = T0 + 8 * DAY_MS;
    expect(manager().load()).toMatchObject({ tier: 'free', pro: false, trialDaysLeft: 0 });
  });

  it('does not grant a new trial when the file is tampered with', () => {
    manager().load();
    writeFileSync(file, JSON.stringify({ v: 1, installId: 'short', firstRunAt: 'later' }));
    expect(manager().load()).toMatchObject({ tier: 'free' });
  });

  it('activates a store key, survives restarts and deactivates', async () => {
    const f = fakeFetch({ activate: activated(), deactivate: { status: 200, body: { deactivated: true } } });
    const m = manager(f);
    m.load();
    const changes: boolean[] = [];
    m.onChange((s) => changes.push(s.pro));

    const res = await m.activate(`  ${STORE_KEY} `);
    expect(res).toMatchObject({ ok: true, code: 'activated' });
    expect(res.status).toMatchObject({ tier: 'pro', source: 'store', licensee: 'Ana Pop', keyHint: '••••-77b872934d51' });
    expect(f.calls[0]!.params.instance_name).toMatch(/^Prăjeală · Linux · [0-9a-f]{8}$/);
    expect(changes).toEqual([true]);
    expect(JSON.stringify(res.status)).not.toContain(STORE_KEY);

    clock = T0 + 30 * DAY_MS;
    const reloaded = manager(f);
    expect(reloaded.load()).toMatchObject({ tier: 'pro', source: 'store' });

    const off = await reloaded.deactivate();
    expect(off).toMatchObject({ ok: true, code: 'deactivated' });
    expect(off.status.tier).toBe('free');
    expect(f.calls.at(-1)!.params).toEqual({ license_key: STORE_KEY, instance_id: 'inst-1' });
  });

  it('keeps the licence when deactivation cannot reach the server', async () => {
    const f = fakeFetch({ activate: activated(), deactivate: new Error('offline') });
    const m = manager(f);
    m.load();
    await m.activate(STORE_KEY);
    expect(await m.deactivate()).toMatchObject({ ok: false, code: 'network' });
    expect(m.status().tier).toBe('pro');
  });

  it('activates offline keys without any network call', async () => {
    const f = fakeFetch({});
    const m = manager(f);
    m.load();
    const { key } = issueKey(privateKeyPem, { to: 'Presă' });
    expect(await m.activate(key)).toMatchObject({ ok: true, status: { tier: 'pro', source: 'offline', licensee: 'Presă' } });
    expect(f.calls).toHaveLength(0);
    expect(manager(f).load()).toMatchObject({ tier: 'pro', source: 'offline' });
  });

  it('drops a stored offline key that is later revoked', async () => {
    const m = manager();
    m.load();
    const { key } = issueKey(privateKeyPem, { to: 'Leaky', id: 'leak1' });
    await m.activate(key);
    clock = T0 + 10 * DAY_MS;
    const status = manager(fakeFetch({}), { revokedOfflineKeyIds: ['leak1'] }).load();
    expect(status).toMatchObject({ tier: 'free', source: null });
    expect(status.notice).toMatch(/revoked/);
  });

  it('explains why a key is refused', async () => {
    const m = manager(fakeFetch({}), { lemonSqueezy: { storeId: 0, productId: 0 } });
    m.load();
    expect(await m.activate('')).toMatchObject({ ok: false, code: 'empty' });
    expect(await m.activate('not-a-key')).toMatchObject({ ok: false, code: 'malformed' });
    expect(await m.activate(STORE_KEY)).toMatchObject({ ok: false, code: 'not-configured' });
    const { key } = issueKey(other.privateKeyPem, { to: 'x' });
    expect(await m.activate(key)).toMatchObject({ ok: false, code: 'invalid' });
  });

  it('re-validates store keys only when due and downgrades only on a definite no', async () => {
    let validateReply: Reply = valid;
    const f = fakeFetch({ activate: activated(), validate: () => validateReply });
    const m = manager(f, {}, { revalidateEveryMs: 7 * DAY_MS });
    m.load();
    await m.activate(STORE_KEY);
    const count = () => f.calls.filter((c) => c.url.endsWith('/validate')).length;

    clock = T0 + 2 * DAY_MS;
    await m.revalidate();
    expect(count()).toBe(0); // not due yet

    clock = T0 + 8 * DAY_MS;
    validateReply = new Error('offline');
    await m.revalidate();
    expect(count()).toBe(1);
    expect(m.status().tier).toBe('pro'); // outage: keep Pro

    clock = T0 + 9 * DAY_MS;
    validateReply = valid;
    await m.revalidate();
    expect(m.status()).toMatchObject({ tier: 'pro', lastValidatedAt: T0 + 9 * DAY_MS });

    clock = T0 + 20 * DAY_MS;
    validateReply = { status: 400, body: { valid: false, error: 'license_key not found.' } };
    await m.revalidate();
    expect(m.status()).toMatchObject({ tier: 'free', notice: 'license_key not found.' });
  });

  it('honours the development tier override', () => {
    expect(manager(fakeFetch({}), {}, { forceTier: 'free' }).load()).toMatchObject({ tier: 'free', pro: false });
    clock = T0 + 100 * DAY_MS;
    expect(manager(fakeFetch({}), {}, { forceTier: 'pro' }).load()).toMatchObject({ pro: true });
  });
});
