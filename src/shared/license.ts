/**
 * Free / Pro tiers and the licence-key contract shared by the main process
 * (verification, persistence, Lemon Squeezy calls), the tray and the renderers
 * (effective settings, licence window). Pure module: no Node, Electron or DOM
 * imports, so every rule here is unit-tested with Vitest. Cryptography (Ed25519)
 * and networking are injected by the main process.
 *
 * Two key formats are accepted:
 *
 *  1. Signed key — `PRAJ1.<base64url payload>.<base64url Ed25519 signature>`.
 *     Issued by the vendor (`npm run license:sign`) after a Lemon Squeezy
 *     purchase and verified fully OFFLINE against the public key compiled into
 *     the app. The payload may embed the Lemon Squeezy key for optional online
 *     re-validation (refunds / revocations).
 *  2. Raw Lemon Squeezy key — the UUID Lemon Squeezy e-mails to the buyer.
 *     Has no signature, so it needs one online activation
 *     (`/v1/licenses/activate`); afterwards it stays valid offline for
 *     `LS_OFFLINE_GRACE_DAYS` since the last successful online check.
 */
import {
  INTENSITIES,
  PALETTES,
  type Intensity,
  type Palette,
  type Settings,
} from './settings';

// ───────────────────────────── tiers & limits ─────────────────────────────

export const TIERS = ['free', 'pro'] as const;
export type Tier = (typeof TIERS)[number];

export interface TierLimits {
  /** Palettes that may be used, or null for "all". */
  palettes: readonly Palette[] | null;
  /** Highest intensity that may be used. */
  maxIntensity: Intensity;
  /** Fire on the focused window frame. */
  burnActiveWindow: boolean;
  /** Sound reactivity. */
  audioReactive: boolean;
  /** Imported JSON themes (settings.themeId). */
  customThemes: boolean;
}

/** What the Free tier can do. Change the product here, nowhere else. */
export const FREE_LIMITS: Readonly<TierLimits> = Object.freeze({
  palettes: ['classic'] as readonly Palette[],
  maxIntensity: 'medium' as Intensity,
  burnActiveWindow: false,
  audioReactive: false,
  customThemes: false,
});

export const PRO_LIMITS: Readonly<TierLimits> = Object.freeze({
  palettes: null,
  maxIntensity: INTENSITIES[INTENSITIES.length - 1] ?? 'inferno',
  burnActiveWindow: true,
  audioReactive: true,
  customThemes: true,
});

export function limitsFor(tier: Tier): Readonly<TierLimits> {
  return tier === 'pro' ? PRO_LIMITS : FREE_LIMITS;
}

export function isPaletteAllowed(tier: Tier, palette: Palette): boolean {
  const allowed = limitsFor(tier).palettes;
  return allowed === null || allowed.includes(palette);
}

export function isIntensityAllowed(tier: Tier, intensity: Intensity): boolean {
  return INTENSITIES.indexOf(intensity) <= INTENSITIES.indexOf(limitsFor(tier).maxIntensity);
}

/** Highest intensity the tier allows that is not above `intensity`. */
export function clampIntensity(tier: Tier, intensity: Intensity): Intensity {
  if (isIntensityAllowed(tier, intensity)) return intensity;
  return limitsFor(tier).maxIntensity;
}

/** First allowed palette when `palette` is locked (the Free default). */
export function clampPalette(tier: Tier, palette: Palette): Palette {
  if (isPaletteAllowed(tier, palette)) return palette;
  const allowed = limitsFor(tier).palettes;
  return allowed?.[0] ?? PALETTES[0];
}

/**
 * The settings the renderer actually runs with. The user's stored settings are
 * never rewritten (a lapsed Pro keeps its choices for when the licence comes
 * back); the main process applies this before every send to the overlays.
 */
export function applyTierLimits(settings: Settings, tier: Tier): Settings {
  const limits = limitsFor(tier);
  const out: Settings = { ...settings };
  out.palette = clampPalette(tier, settings.palette);
  out.intensity = clampIntensity(tier, settings.intensity);
  if (!limits.burnActiveWindow) out.burnActiveWindow = false;
  if (!limits.audioReactive) out.audioReactive = false;
  if (!limits.customThemes) out.themeId = '';
  return out;
}

/** Settings keys whose value may be locked for a tier (for tray labels). */
export function isLockedForTier(tier: Tier, key: keyof Settings, value: unknown): boolean {
  switch (key) {
    case 'palette':
      return !isPaletteAllowed(tier, value as Palette);
    case 'intensity':
      return !isIntensityAllowed(tier, value as Intensity);
    case 'burnActiveWindow':
      return value === true && !limitsFor(tier).burnActiveWindow;
    case 'audioReactive':
      return value === true && !limitsFor(tier).audioReactive;
    case 'themeId':
      return typeof value === 'string' && value.length > 0 && !limitsFor(tier).customThemes;
    default:
      return false;
  }
}

// ───────────────────────────── key formats ─────────────────────────────

export const LICENSE_PRODUCT = 'prajeala';
export const SIGNED_LICENSE_PREFIX = 'PRAJ1';
/** A raw Lemon Squeezy licence key (UUID v4 style). */
const LEMON_SQUEEZY_KEY_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface SignedLicensePayload {
  /** Payload format version. */
  v: 1;
  /** Must equal LICENSE_PRODUCT. */
  product: string;
  tier: 'pro';
  /** Unique licence id (for bookkeeping / future revocation lists). */
  id?: string;
  /** Lemon Squeezy licence key embedded for optional online re-validation. */
  key?: string;
  name?: string;
  email?: string;
  /** ISO date `YYYY-MM-DD`. */
  issued: string;
  /** ISO date `YYYY-MM-DD`; null / missing = perpetual. */
  expires?: string | null;
}

export type ParsedLicenseKey =
  | {
      kind: 'signed';
      raw: string;
      payload: SignedLicensePayload;
      /** Bytes that were signed: `PRAJ1.<payload base64url>` as UTF-8. */
      message: Uint8Array;
      signature: Uint8Array;
    }
  | { kind: 'lemonsqueezy'; raw: string; key: string };

export type LicenseKind = ParsedLicenseKey['kind'] | 'none';

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export function base64UrlEncode(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i] ?? 0);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

export function base64UrlDecode(text: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]*$/.test(text)) return null;
  const b64 = text.replace(/-/g, '+').replace(/_/g, '/');
  const padded = b64 + '==='.slice(0, (4 - (b64.length % 4)) % 4);
  try {
    const bin = atob(padded);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

export function utf8Bytes(text: string): Uint8Array {
  return textEncoder.encode(text);
}

/** Normalises user input: trims, drops inner whitespace/newlines (keys get pasted from e-mails). */
export function normalizeLicenseInput(input: unknown): string {
  if (typeof input !== 'string') return '';
  return input.replace(/\s+/g, '').trim();
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function isValidDateString(s: unknown): s is string {
  return typeof s === 'string' && DATE_RE.test(s) && Number.isFinite(Date.parse(`${s}T00:00:00Z`));
}

/** Validates a decoded payload object. Returns null when the shape is wrong. */
export function validateSignedPayload(input: unknown): SignedLicensePayload | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const p = input as Record<string, unknown>;
  if (p.v !== 1) return null;
  if (typeof p.product !== 'string' || p.product.length === 0) return null;
  if (p.tier !== 'pro') return null;
  if (!isValidDateString(p.issued)) return null;
  if (p.expires !== undefined && p.expires !== null && !isValidDateString(p.expires)) return null;
  for (const k of ['id', 'key', 'name', 'email'] as const) {
    if (p[k] !== undefined && typeof p[k] !== 'string') return null;
  }
  const out: SignedLicensePayload = { v: 1, product: p.product, tier: 'pro', issued: p.issued };
  if (typeof p.id === 'string') out.id = p.id;
  if (typeof p.key === 'string') out.key = p.key;
  if (typeof p.name === 'string') out.name = p.name;
  if (typeof p.email === 'string') out.email = p.email;
  out.expires = typeof p.expires === 'string' ? p.expires : null;
  return out;
}

/** Message bytes covered by the signature for a given encoded payload. */
export function signedMessage(payloadB64: string): Uint8Array {
  return utf8Bytes(`${SIGNED_LICENSE_PREFIX}.${payloadB64}`);
}

/** Canonical payload encoding (stable key order) so signing and parsing agree byte for byte. */
export function encodeSignedPayload(payload: SignedLicensePayload): string {
  const ordered: Record<string, unknown> = { v: 1, product: payload.product, tier: payload.tier };
  if (payload.id !== undefined) ordered.id = payload.id;
  if (payload.key !== undefined) ordered.key = payload.key;
  if (payload.name !== undefined) ordered.name = payload.name;
  if (payload.email !== undefined) ordered.email = payload.email;
  ordered.issued = payload.issued;
  ordered.expires = payload.expires ?? null;
  return base64UrlEncode(utf8Bytes(JSON.stringify(ordered)));
}

/** Assembles a signed key from an encoded payload and its signature. */
export function assembleSignedLicense(payloadB64: string, signature: Uint8Array): string {
  return `${SIGNED_LICENSE_PREFIX}.${payloadB64}.${base64UrlEncode(signature)}`;
}

/**
 * Parses either key format. Never throws; returns null for anything else.
 * Signature VALIDITY is not checked here (see `evaluateLicense`).
 */
export function parseLicenseKey(input: unknown): ParsedLicenseKey | null {
  const raw = normalizeLicenseInput(input);
  if (!raw) return null;
  if (LEMON_SQUEEZY_KEY_RE.test(raw)) return { kind: 'lemonsqueezy', raw, key: raw.toLowerCase() };
  const parts = raw.split('.');
  if (parts.length !== 3 || parts[0] !== SIGNED_LICENSE_PREFIX) return null;
  const payloadB64 = parts[1] ?? '';
  const sigB64 = parts[2] ?? '';
  const payloadBytes = base64UrlDecode(payloadB64);
  const signature = base64UrlDecode(sigB64);
  if (!payloadBytes || !signature || signature.length !== 64 || payloadBytes.length === 0) return null;
  let decoded: unknown;
  try {
    decoded = JSON.parse(textDecoder.decode(payloadBytes));
  } catch {
    return null;
  }
  const payload = validateSignedPayload(decoded);
  if (!payload) return null;
  return { kind: 'signed', raw, payload, message: signedMessage(payloadB64), signature };
}

/** The Lemon Squeezy key an online check would ask about, if any. */
export function lemonSqueezyKeyOf(parsed: ParsedLicenseKey | null): string | null {
  if (!parsed) return null;
  return parsed.kind === 'lemonsqueezy' ? parsed.key : (parsed.payload.key ?? null);
}

export function hasLemonSqueezyKey(parsed: ParsedLicenseKey | null): boolean {
  return lemonSqueezyKeyOf(parsed) !== null;
}

/** Short, non-secret representation for menus and logs. */
export function maskLicenseKey(parsed: ParsedLicenseKey | null): string {
  if (!parsed) return '';
  if (parsed.kind === 'lemonsqueezy') return `${parsed.key.slice(0, 8)}…${parsed.key.slice(-4)}`;
  const sig = parsed.raw.slice(parsed.raw.lastIndexOf('.') + 1);
  return `${SIGNED_LICENSE_PREFIX}…${sig.slice(-6)}`;
}

// ───────────────────────────── Lemon Squeezy ─────────────────────────────

export const LEMON_SQUEEZY_API = 'https://api.lemonsqueezy.com/v1/licenses';
export const LS_STATUSES = ['inactive', 'active', 'expired', 'disabled'] as const;
export type LemonSqueezyStatus = (typeof LS_STATUSES)[number] | 'unknown';

export interface LemonSqueezyResult {
  /** `activated` / `valid` / `deactivated` flag of the respective endpoint. */
  ok: boolean;
  /** Error message from the API (also set for malformed responses). */
  error: string | null;
  status: LemonSqueezyStatus;
  instanceId: string | null;
  activationLimit: number | null;
  activationUsage: number | null;
  expiresAt: string | null;
  storeId: number | null;
  productId: number | null;
  variantId: number | null;
  customerName: string | null;
  customerEmail: string | null;
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}
function int(v: unknown): number | null {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

/** Normalises an activate / validate / deactivate response body (any shape, never throws). */
export function parseLemonSqueezyResponse(body: unknown): LemonSqueezyResult {
  const r = (body && typeof body === 'object' && !Array.isArray(body) ? body : {}) as Record<string, unknown>;
  const lk = (r.license_key && typeof r.license_key === 'object' ? r.license_key : {}) as Record<string, unknown>;
  const inst = (r.instance && typeof r.instance === 'object' ? r.instance : {}) as Record<string, unknown>;
  const meta = (r.meta && typeof r.meta === 'object' ? r.meta : {}) as Record<string, unknown>;
  const ok = r.activated === true || r.valid === true || r.deactivated === true;
  let error = str(r.error);
  if (!ok && !error) error = 'unexpected response from Lemon Squeezy';
  let rawStatus = str(lk.status)?.toLowerCase() ?? null;
  // Rejections do not always carry `license_key.status`; the error text names the reason.
  if (!rawStatus && !ok && error) {
    const lower = error.toLowerCase();
    if (lower.includes('disabled')) rawStatus = 'disabled';
    else if (lower.includes('expired')) rawStatus = 'expired';
  }
  const status: LemonSqueezyStatus = (LS_STATUSES as readonly string[]).includes(rawStatus ?? '')
    ? (rawStatus as LemonSqueezyStatus)
    : 'unknown';
  return {
    ok,
    error: ok ? str(r.error) : error,
    status,
    instanceId: str(inst.id),
    activationLimit: int(lk.activation_limit),
    activationUsage: int(lk.activation_usage),
    expiresAt: str(lk.expires_at),
    storeId: int(meta.store_id),
    productId: int(meta.product_id),
    variantId: int(meta.variant_id),
    customerName: str(meta.customer_name),
    customerEmail: str(meta.customer_email),
  };
}

// ───────────────────────────── stored record & evaluation ─────────────────────────────

/** What `userData/prajeala-license.json` holds. All strings are ISO timestamps unless noted. */
export interface LicenseRecord {
  key: string;
  activatedAt: string;
  /** Lemon Squeezy instance id (raw keys and signed keys that embed one). */
  instanceId?: string | null;
  lastOnlineCheckAt?: string | null;
  /** Outcome of the last online check: `valid`, `invalid` (definitive: refund/disabled/unknown key) or `error` (network). */
  lastOnlineResult?: 'valid' | 'invalid' | 'error' | null;
  lastOnlineError?: string | null;
  lsStatus?: LemonSqueezyStatus | null;
  lsExpiresAt?: string | null;
  customerName?: string | null;
  customerEmail?: string | null;
}

export function normalizeLicenseRecord(input: unknown): LicenseRecord | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const r = input as Record<string, unknown>;
  const key = normalizeLicenseInput(r.key);
  if (!key) return null;
  const s = (v: unknown): string | null => (typeof v === 'string' ? v : null);
  const result = r.lastOnlineResult;
  const lsStatus = s(r.lsStatus);
  return {
    key,
    activatedAt: s(r.activatedAt) ?? new Date(0).toISOString(),
    instanceId: s(r.instanceId),
    lastOnlineCheckAt: s(r.lastOnlineCheckAt),
    lastOnlineResult: result === 'valid' || result === 'invalid' || result === 'error' ? result : null,
    lastOnlineError: s(r.lastOnlineError),
    lsStatus: lsStatus && (LS_STATUSES as readonly string[]).includes(lsStatus) ? (lsStatus as LemonSqueezyStatus) : null,
    lsExpiresAt: s(r.lsExpiresAt),
    customerName: s(r.customerName),
    customerEmail: s(r.customerEmail),
  };
}

export type LicenseStatus =
  /** No key stored. */
  | 'none'
  /** Pro. */
  | 'active'
  /** Key parsed but the signature does not verify / malformed. */
  | 'invalid'
  /** Signed keys are not supported by this build (no public key compiled in). */
  | 'unsupported'
  /** Past its expiry date. */
  | 'expired'
  /** Lemon Squeezy reported the key as disabled / refunded / unknown. */
  | 'revoked'
  /** Raw Lemon Squeezy key that was never activated online, or not re-checked within the grace period. */
  | 'unverified';

/** Raw Lemon Squeezy keys stay Pro this long after the last successful online check. */
export const LS_OFFLINE_GRACE_DAYS = 30;
/** Automatic re-validation cadence (when `licenseOnlineCheck` is on). */
export const ONLINE_RECHECK_DAYS = 7;

export interface SignatureVerifier {
  /**
   * Returns true/false for a verified/forged signature, or null when this build
   * has no public key (signed keys unsupported).
   */
  (message: Uint8Array, signature: Uint8Array): boolean | null;
}

export interface EvaluateOptions {
  now: Date;
  verify: SignatureVerifier;
  /** Lemon Squeezy store / product the key must belong to (0 = don't check). */
  storeId?: number;
  productId?: number;
}

export interface LicenseEvaluation {
  tier: Tier;
  status: LicenseStatus;
  kind: LicenseKind;
  parsed: ParsedLicenseKey | null;
  /** Expiry as `YYYY-MM-DD` or ISO timestamp, null when perpetual / unknown. */
  expiresAt: string | null;
  /** Raw LS keys: when the offline grace runs out (ISO), else null. */
  graceUntil: string | null;
  name: string | null;
  email: string | null;
  /** Human-readable one-liner for the tray / licence window. */
  message: string;
}

const DAY_MS = 86_400_000;

function endOfDayUtc(date: string): number {
  // `YYYY-MM-DD` → valid through the end of that day; ISO timestamps are taken as-is.
  return DATE_RE.test(date) ? Date.parse(`${date}T23:59:59.999Z`) : Date.parse(date);
}

function dateExpired(date: string | null | undefined, now: Date): boolean {
  if (!date) return false;
  const t = endOfDayUtc(date);
  return Number.isFinite(t) && now.getTime() > t;
}

function free(status: LicenseStatus, kind: LicenseKind, parsed: ParsedLicenseKey | null, message: string): LicenseEvaluation {
  return { tier: 'free', status, kind, parsed, expiresAt: null, graceUntil: null, name: null, email: null, message };
}

/** Pure decision: record (+ clock + verifier) → tier/status. */
export function evaluateLicense(record: LicenseRecord | null, opts: EvaluateOptions): LicenseEvaluation {
  if (!record) return free('none', 'none', null, 'Free — no licence key.');
  const parsed = parseLicenseKey(record.key);
  if (!parsed) return free('invalid', 'none', null, 'The stored licence key is not in a recognised format.');

  if (parsed.kind === 'signed') {
    const verified = opts.verify(parsed.message, parsed.signature);
    if (verified === null) return free('unsupported', 'signed', parsed, 'This build cannot verify signed keys (no licence public key).');
    if (!verified) return free('invalid', 'signed', parsed, 'The licence signature does not verify.');
    const p = parsed.payload;
    if (p.product !== LICENSE_PRODUCT) return free('invalid', 'signed', parsed, 'This licence is for a different product.');
    if (dateExpired(p.expires, opts.now)) {
      return { ...free('expired', 'signed', parsed, `Licence expired on ${p.expires}.`), expiresAt: p.expires ?? null, name: p.name ?? null, email: p.email ?? null };
    }
    // The signature is the vendor's word; Lemon Squeezy only overrides it with an explicit
    // "disabled" (refund) or "expired". "Not found" and other errors are shown but keep Pro.
    if (record.lastOnlineResult === 'invalid' && (record.lsStatus === 'disabled' || record.lsStatus === 'expired')) {
      const status: LicenseStatus = record.lsStatus === 'expired' ? 'expired' : 'revoked';
      return { ...free(status, 'signed', parsed, `Lemon Squeezy reports this licence as ${record.lsStatus}.`), name: p.name ?? null, email: p.email ?? null };
    }
    const warning = record.lastOnlineResult === 'invalid' ? ` (online check: ${record.lastOnlineError ?? 'rejected'})` : '';
    return {
      tier: 'pro',
      status: 'active',
      kind: 'signed',
      parsed,
      expiresAt: p.expires ?? null,
      graceUntil: null,
      name: p.name ?? record.customerName ?? null,
      email: p.email ?? record.customerEmail ?? null,
      message: (p.expires ? `Pro — valid until ${p.expires}.` : 'Pro — perpetual licence.') + warning,
    };
  }

  // Raw Lemon Squeezy key.
  if (!record.instanceId) return free('unverified', 'lemonsqueezy', parsed, 'This key has not been activated online yet.');
  if (record.lastOnlineResult === 'invalid' || record.lsStatus === 'disabled') {
    return free('revoked', 'lemonsqueezy', parsed, `Lemon Squeezy reports this licence as ${record.lsStatus ?? 'invalid'}.`);
  }
  if (record.lsStatus === 'expired' || dateExpired(record.lsExpiresAt, opts.now)) {
    return { ...free('expired', 'lemonsqueezy', parsed, 'Licence expired.'), expiresAt: record.lsExpiresAt ?? null };
  }
  const lastOk = record.lastOnlineResult === 'valid' || record.lastOnlineResult === 'error' || record.lastOnlineResult == null;
  const anchor = Date.parse(record.lastOnlineCheckAt ?? record.activatedAt);
  const graceUntilMs = (Number.isFinite(anchor) ? anchor : 0) + LS_OFFLINE_GRACE_DAYS * DAY_MS;
  if (!lastOk || opts.now.getTime() > graceUntilMs) {
    return {
      ...free('unverified', 'lemonsqueezy', parsed, 'Please connect to the internet to re-verify this licence.'),
      graceUntil: new Date(graceUntilMs).toISOString(),
    };
  }
  return {
    tier: 'pro',
    status: 'active',
    kind: 'lemonsqueezy',
    parsed,
    expiresAt: record.lsExpiresAt ?? null,
    graceUntil: new Date(graceUntilMs).toISOString(),
    name: record.customerName ?? null,
    email: record.customerEmail ?? null,
    message: record.lsExpiresAt ? `Pro — valid until ${record.lsExpiresAt.slice(0, 10)}.` : 'Pro — Lemon Squeezy licence.',
  };
}

/** Whether a Lemon Squeezy result belongs to the configured store/product (0 = unchecked). */
export function matchesProduct(result: LemonSqueezyResult, storeId = 0, productId = 0): boolean {
  if (storeId > 0 && result.storeId !== null && result.storeId !== storeId) return false;
  if (productId > 0 && result.productId !== null && result.productId !== productId) return false;
  return true;
}

/** Should an automatic online re-check run now? */
export function needsOnlineRecheck(record: LicenseRecord | null, now: Date, enabled: boolean): boolean {
  if (!record || !enabled) return false;
  const parsed = parseLicenseKey(record.key);
  if (!parsed) return false;
  if (parsed.kind === 'signed' && !parsed.payload.key) return false; // nothing to ask Lemon Squeezy about
  if (parsed.kind === 'lemonsqueezy' && !record.instanceId) return false; // needs an explicit activation first
  if (record.lastOnlineResult === 'invalid') return false; // definitive; a manual check can still override
  const last = Date.parse(record.lastOnlineCheckAt ?? '');
  if (!Number.isFinite(last)) return true;
  return now.getTime() - last >= ONLINE_RECHECK_DAYS * DAY_MS;
}

// ───────────────────────────── IPC payloads ─────────────────────────────

/** Snapshot pushed to the tray / renderers (never contains the full key). */
export interface LicenseInfo {
  tier: Tier;
  status: LicenseStatus;
  kind: LicenseKind;
  maskedKey: string;
  name: string | null;
  email: string | null;
  expiresAt: string | null;
  graceUntil: string | null;
  activatedAt: string | null;
  lastOnlineCheckAt: string | null;
  lastOnlineResult: 'valid' | 'invalid' | 'error' | null;
  lastOnlineError: string | null;
  /** Mirrors `settings.licenseOnlineCheck`. */
  onlineCheckEnabled: boolean;
  /** True when there is a Lemon Squeezy key to ask about (raw key, or signed key embedding one). */
  canCheckOnline: boolean;
  /** False when the build has no licence public key (signed keys rejected). */
  signedKeysSupported: boolean;
  buyUrl: string;
  message: string;
  /** True while an activation / online check is in flight. */
  busy: boolean;
}

export interface LicenseActionResult {
  ok: boolean;
  error?: string;
  info: LicenseInfo;
}

export const FREE_LICENSE_INFO: Readonly<LicenseInfo> = Object.freeze({
  tier: 'free',
  status: 'none',
  kind: 'none',
  maskedKey: '',
  name: null,
  email: null,
  expiresAt: null,
  graceUntil: null,
  activatedAt: null,
  lastOnlineCheckAt: null,
  lastOnlineResult: null,
  lastOnlineError: null,
  onlineCheckEnabled: true,
  canCheckOnline: false,
  signedKeysSupported: false,
  buyUrl: '',
  message: 'Free — no licence key.',
  busy: false,
});

export function buildLicenseInfo(
  record: LicenseRecord | null,
  evaluation: LicenseEvaluation,
  extras: Pick<LicenseInfo, 'onlineCheckEnabled' | 'signedKeysSupported' | 'buyUrl' | 'busy'>,
): LicenseInfo {
  return {
    tier: evaluation.tier,
    status: evaluation.status,
    kind: evaluation.kind,
    maskedKey: maskLicenseKey(evaluation.parsed),
    name: evaluation.name,
    email: evaluation.email,
    expiresAt: evaluation.expiresAt,
    graceUntil: evaluation.graceUntil,
    activatedAt: record?.activatedAt ?? null,
    lastOnlineCheckAt: record?.lastOnlineCheckAt ?? null,
    lastOnlineResult: record?.lastOnlineResult ?? null,
    lastOnlineError: record?.lastOnlineError ?? null,
    onlineCheckEnabled: extras.onlineCheckEnabled,
    canCheckOnline: hasLemonSqueezyKey(evaluation.parsed),
    signedKeysSupported: extras.signedKeysSupported,
    buyUrl: extras.buyUrl,
    message: evaluation.message,
    busy: extras.busy,
  };
}
