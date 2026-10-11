/**
 * Lemon Squeezy License API client (activate / validate / deactivate).
 *
 * These three endpoints are public — no API key — and are meant to be called
 * from desktop apps: https://docs.lemonsqueezy.com/api/license-api
 * Every answer is checked against the store/product configured in
 * src/shared/product.ts, otherwise a key bought for *any* Lemon Squeezy product
 * would unlock Pro.
 *
 * `fetch` is injected so the tests can drive every branch without a network.
 */
import type { LicenseResultCode } from '../../shared/license';
import type { LemonSqueezyConfig } from '../../shared/product';

export const LEMON_SQUEEZY_LICENSE_API = 'https://api.lemonsqueezy.com/v1/licenses';

export interface FetchResponseLike {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}

export type FetchLike = (
  url: string,
  init: { method: 'POST'; headers: Record<string, string>; body: string; signal?: AbortSignal },
) => Promise<FetchResponseLike>;

export interface StoreResult {
  ok: boolean;
  code: LicenseResultCode;
  message: string;
  /**
   * True when the store gave a definite answer (key unknown, revoked, expired,
   * other product…). False for network errors, timeouts and 5xx answers: a
   * transient failure must never take Pro away from a paying user.
   */
  definitive: boolean;
  instanceId?: string;
  licensee?: string;
}

const TIMEOUT_MS = 15_000;

interface RawAnswer {
  status: number;
  body: Record<string, unknown>;
}

async function post(
  fetchImpl: FetchLike,
  endpoint: 'activate' | 'validate' | 'deactivate',
  params: Record<string, string>,
): Promise<RawAnswer | { failure: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetchImpl(`${LEMON_SQUEEZY_LICENSE_API}/${endpoint}`, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(params).toString(),
      signal: controller.signal,
    });
    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      body = null;
    }
    const obj = body && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
    return { status: res.status, body: obj };
  } catch (err) {
    return { failure: controller.signal.aborted ? 'timeout' : err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(timer);
  }
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function transient(message: string): StoreResult {
  return { ok: false, code: 'network', message, definitive: false };
}

/** Rejects answers about keys that belong to another store/product. */
function checkOwnership(body: Record<string, unknown>, config: LemonSqueezyConfig): StoreResult | null {
  const meta = record(body.meta);
  const storeId = Number(meta.store_id);
  const productId = Number(meta.product_id);
  if (storeId !== config.storeId || (config.productId > 0 && productId !== config.productId)) {
    return {
      ok: false,
      code: 'wrong-product',
      message: 'This licence key belongs to a different product.',
      definitive: true,
    };
  }
  return null;
}

/** Maps a negative answer (HTTP 4xx or `activated/valid: false`) to a result code. */
function negative(answer: RawAnswer): StoreResult {
  if (answer.status >= 500 || answer.status === 429) {
    return transient(`Licence server unavailable (HTTP ${answer.status}).`);
  }
  const error = typeof answer.body.error === 'string' ? answer.body.error : '';
  const status = String(record(answer.body.license_key).status ?? '');
  if (status === 'expired') return { ok: false, code: 'expired', message: 'This licence key has expired.', definitive: true };
  if (status === 'disabled') return { ok: false, code: 'disabled', message: 'This licence key has been disabled.', definitive: true };
  if (/activation limit/i.test(error)) {
    return {
      ok: false,
      code: 'limit',
      message: 'This licence key is already active on the maximum number of computers. Deactivate it on another one first.',
      definitive: true,
    };
  }
  return { ok: false, code: 'invalid', message: error || 'This licence key is not valid.', definitive: true };
}

function licensee(body: Record<string, unknown>): string {
  const meta = record(body.meta);
  const name = typeof meta.customer_name === 'string' ? meta.customer_name.trim() : '';
  const email = typeof meta.customer_email === 'string' ? meta.customer_email.trim() : '';
  return name || email;
}

export async function activateStoreKey(
  key: string,
  instanceName: string,
  config: LemonSqueezyConfig,
  fetchImpl: FetchLike,
): Promise<StoreResult> {
  const answer = await post(fetchImpl, 'activate', { license_key: key, instance_name: instanceName });
  if ('failure' in answer) return transient(`Could not reach the licence server (${answer.failure}).`);
  if (answer.status < 200 || answer.status >= 300 || answer.body.activated !== true) return negative(answer);
  const wrong = checkOwnership(answer.body, config);
  if (wrong) {
    // Free the activation we just consumed on somebody else's key.
    const instanceId = String(record(answer.body.instance).id ?? '');
    if (instanceId) void post(fetchImpl, 'deactivate', { license_key: key, instance_id: instanceId });
    return wrong;
  }
  const instanceId = String(record(answer.body.instance).id ?? '');
  if (!instanceId) return transient('The licence server did not return an activation id.');
  return { ok: true, code: 'activated', message: 'Prăjeală Pro is active.', definitive: true, instanceId, licensee: licensee(answer.body) };
}

export async function validateStoreKey(
  key: string,
  instanceId: string | null,
  config: LemonSqueezyConfig,
  fetchImpl: FetchLike,
): Promise<StoreResult> {
  const params: Record<string, string> = { license_key: key };
  if (instanceId) params.instance_id = instanceId;
  const answer = await post(fetchImpl, 'validate', params);
  if ('failure' in answer) return transient(`Could not reach the licence server (${answer.failure}).`);
  if (answer.status < 200 || answer.status >= 300 || answer.body.valid !== true) return negative(answer);
  const wrong = checkOwnership(answer.body, config);
  if (wrong) return wrong;
  const status = String(record(answer.body.license_key).status ?? '');
  if (status === 'expired' || status === 'disabled') return negative(answer);
  return { ok: true, code: 'activated', message: 'Licence is valid.', definitive: true, licensee: licensee(answer.body) };
}

export async function deactivateStoreKey(key: string, instanceId: string, fetchImpl: FetchLike): Promise<StoreResult> {
  const answer = await post(fetchImpl, 'deactivate', { license_key: key, instance_id: instanceId });
  if ('failure' in answer) return transient(`Could not reach the licence server (${answer.failure}).`);
  if (answer.status >= 200 && answer.status < 300 && answer.body.deactivated === true) {
    return { ok: true, code: 'deactivated', message: 'Licence deactivated on this computer.', definitive: true };
  }
  return negative(answer);
}
