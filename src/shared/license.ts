/**
 * Licence model shared by the main process (LicenseManager), the settings
 * window and the tests. Pure module: no crypto, no I/O.
 *
 * Two kinds of keys unlock Pro:
 *   - store keys  — issued by Lemon Squeezy on purchase (a UUID such as
 *                   `38b1460a-5104-4067-a91d-77b872934d51`), activated online once;
 *   - offline keys — `PRJ1-<payload>.<signature>`, Ed25519-signed by the author
 *                   with `npm run license -- issue` (giveaways, press, sponsors),
 *                   verified locally without any network access.
 */

export type LicenseTier = 'free' | 'trial' | 'pro';
export type LicenseSource = 'store' | 'offline';

/** What the UI needs to know about the licence. Never contains the full key. */
export interface LicenseStatus {
  tier: LicenseTier;
  /** True for `trial` and `pro`: Pro features are unlocked. */
  pro: boolean;
  source: LicenseSource | null;
  /** Buyer name or e-mail as reported by the store / embedded in the offline key ('' when unknown). */
  licensee: string;
  /** Masked key, e.g. `••••-77b872934d51` ('' without a key). */
  keyHint: string;
  /** Whole days left in the trial (0 outside the trial). */
  trialDaysLeft: number;
  /** End of the trial (epoch ms); null when there is no trial. */
  trialEndsAt: number | null;
  /** Lemon Squeezy store id configured in product.ts → online activation available. */
  storeConfigured: boolean;
  /** Offline public key configured in product.ts → `PRJ1-…` keys accepted. */
  offlineConfigured: boolean;
  /** Last successful online check (epoch ms), null for offline keys / never. */
  lastValidatedAt: number | null;
  /** Why a licence stopped working (shown once in the settings window); '' when nothing happened. */
  notice: string;
}

export interface LicenseActionResult {
  ok: boolean;
  /** Human-readable outcome (English; the UI maps known codes to translations). */
  message: string;
  /** Stable machine-readable code for the UI. */
  code: LicenseResultCode;
  status: LicenseStatus;
}

export type LicenseResultCode =
  | 'activated'
  | 'deactivated'
  | 'empty'
  | 'malformed'
  | 'invalid'
  | 'wrong-product'
  | 'limit'
  | 'expired'
  | 'disabled'
  | 'network'
  | 'not-configured'
  | 'busy'
  | 'error';

export const OFFLINE_KEY_PREFIX = 'PRJ1-';

/** Signed content of an offline key. */
export interface OfflineLicensePayload {
  /** Format version. */
  v: 1;
  /** Unique id chosen at issue time (lets the author revoke keys in a future release). */
  id: string;
  /** Licensee name or e-mail. */
  to: string;
  /** Issue date, YYYY-MM-DD. */
  at: string;
}

export const DAY_MS = 86_400_000;

/** Removes whitespace/line breaks that sneak in when keys are copied from e-mails. */
export function cleanKey(input: string): string {
  return String(input ?? '').replace(/\s+/g, '');
}

export type KeyKind = 'store' | 'offline' | 'unknown';

const STORE_KEY_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const OFFLINE_KEY_RE = /^PRJ1-[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

export function classifyKey(key: string): KeyKind {
  const k = cleanKey(key);
  if (OFFLINE_KEY_RE.test(k)) return 'offline';
  if (STORE_KEY_RE.test(k)) return 'store';
  return 'unknown';
}

/** `••••-77b872934d51` — enough for the buyer to recognise the key, useless to anyone else. */
export function maskKey(key: string): string {
  const k = cleanKey(key);
  if (!k) return '';
  return `••••-${k.slice(-Math.min(12, Math.max(4, Math.floor(k.length / 3))))}`;
}

export interface TrialState {
  active: boolean;
  daysLeft: number;
  endsAt: number;
}

/**
 * Trial window that starts at `firstRunAt`. A clock that moved backwards
 * counts as “no time elapsed”; `days <= 0` disables the trial.
 */
export function trialState(firstRunAt: number, now: number, days: number): TrialState {
  const endsAt = firstRunAt + Math.max(0, days) * DAY_MS;
  if (!(days > 0) || !Number.isFinite(firstRunAt)) return { active: false, daysLeft: 0, endsAt };
  const left = endsAt - Math.max(now, firstRunAt);
  return left > 0 ? { active: true, daysLeft: Math.ceil(left / DAY_MS), endsAt } : { active: false, daysLeft: 0, endsAt };
}

/** Validates a decoded offline payload (shape only — the signature is checked in main). */
export function parseOfflinePayload(value: unknown): OfflineLicensePayload | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  if (v.v !== 1) return null;
  if (typeof v.id !== 'string' || v.id.length === 0 || v.id.length > 64) return null;
  if (typeof v.to !== 'string' || v.to.trim().length === 0 || v.to.length > 200) return null;
  if (typeof v.at !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v.at)) return null;
  return { v: 1, id: v.id, to: v.to.trim(), at: v.at };
}

export const FREE_STATUS: Readonly<LicenseStatus> = Object.freeze({
  tier: 'free',
  pro: false,
  source: null,
  licensee: '',
  keyHint: '',
  trialDaysLeft: 0,
  trialEndsAt: null,
  storeConfigured: false,
  offlineConfigured: false,
  lastValidatedAt: null,
  notice: '',
});
