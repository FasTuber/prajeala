/**
 * Minimal Lemon Squeezy License API client (activate / validate / deactivate).
 * No API key is needed for these endpoints. `fetch` is injectable for tests;
 * every failure is turned into a `LemonSqueezyResult` with `ok: false` and a
 * message — nothing here throws.
 */
import { LEMON_SQUEEZY_API, parseLemonSqueezyResponse, type LemonSqueezyResult } from '../shared/license';
import { createLogger } from './log';

const log = createLogger('lemonsqueezy');

export type FetchLike = (input: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<{
  status: number;
  json(): Promise<unknown>;
  text(): Promise<string>;
}>;

export interface LemonSqueezyClientOptions {
  fetch?: FetchLike;
  baseUrl?: string;
  timeoutMs?: number;
}

/** Marks a result that never reached the API (offline, DNS, timeout) so callers keep the previous state. */
export interface LemonSqueezyCallResult extends LemonSqueezyResult {
  network: boolean;
}

export class LemonSqueezyClient {
  private readonly fetchImpl: FetchLike;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor(options: LemonSqueezyClientOptions = {}) {
    this.fetchImpl = options.fetch ?? ((input, init) => fetch(input, init));
    this.baseUrl = (options.baseUrl ?? LEMON_SQUEEZY_API).replace(/\/$/, '');
    this.timeoutMs = options.timeoutMs ?? 15_000;
  }

  activate(licenseKey: string, instanceName: string): Promise<LemonSqueezyCallResult> {
    return this.post('activate', { license_key: licenseKey, instance_name: instanceName });
  }

  validate(licenseKey: string, instanceId: string | null): Promise<LemonSqueezyCallResult> {
    const fields: Record<string, string> = { license_key: licenseKey };
    if (instanceId) fields.instance_id = instanceId;
    return this.post('validate', fields);
  }

  deactivate(licenseKey: string, instanceId: string): Promise<LemonSqueezyCallResult> {
    return this.post('deactivate', { license_key: licenseKey, instance_id: instanceId });
  }

  private async post(endpoint: string, fields: Record<string, string>): Promise<LemonSqueezyCallResult> {
    const url = `${this.baseUrl}/${endpoint}`;
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), this.timeoutMs) : null;
    try {
      const res = await this.fetchImpl(url, {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(fields).toString(),
        signal: controller?.signal,
      });
      let body: unknown = null;
      try {
        body = await res.json();
      } catch {
        body = null;
      }
      const parsed = parseLemonSqueezyResponse(body);
      if (!parsed.ok && !parsed.error) parsed.error = `HTTP ${res.status}`;
      if (res.status >= 500) {
        // Their outage, not the licence's fault: treat like a network error.
        return { ...parsed, ok: false, error: parsed.error ?? `HTTP ${res.status}`, network: true };
      }
      log.debug(`${endpoint} → ${res.status} ok=${parsed.ok} status=${parsed.status}${parsed.error ? ` error="${parsed.error}"` : ''}`);
      return { ...parsed, network: false };
    } catch (err) {
      const message = err instanceof Error ? (err.name === 'AbortError' ? 'request timed out' : err.message) : String(err);
      log.debug(`${endpoint} failed: ${message}`);
      return {
        ...parseLemonSqueezyResponse(null),
        ok: false,
        error: `could not reach Lemon Squeezy (${message})`,
        network: true,
      };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
