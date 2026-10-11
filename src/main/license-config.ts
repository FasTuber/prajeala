/**
 * Licensing configuration. Values are baked in at build time by
 * `scripts/build.mjs` (`__PRAJEALA_BUILD__`, from environment variables or the
 * git-ignored `license/public.key`) and can be overridden at runtime through the
 * same environment variables — handy for `npm start` during development.
 *
 *   PRAJEALA_LICENSE_PUBLIC_KEY   Ed25519 public key, 32 raw bytes as 64 hex chars
 *                                 (`npm run license:keygen`). Empty → signed keys rejected.
 *   PRAJEALA_LS_STORE_ID          Lemon Squeezy store id the key must belong to (0 = any)
 *   PRAJEALA_LS_PRODUCT_ID        Lemon Squeezy product id the key must belong to (0 = any)
 *   PRAJEALA_BUY_URL              Checkout / landing page opened by "Buy Prăjeală Pro"
 */

export interface LicenseConfig {
  /** 64 hex chars, or '' when unset. */
  publicKeyHex: string;
  storeId: number;
  productId: number;
  buyUrl: string;
}

interface BuildDefines {
  licensePublicKey?: string;
  lsStoreId?: number | string;
  lsProductId?: number | string;
  buyUrl?: string;
}

declare const __PRAJEALA_BUILD__: BuildDefines | undefined;

export const DEFAULT_BUY_URL = 'https://github.com/FasTuber/prajeala#pro';

function buildDefines(): BuildDefines {
  try {
    return typeof __PRAJEALA_BUILD__ === 'object' && __PRAJEALA_BUILD__ ? __PRAJEALA_BUILD__ : {};
  } catch {
    return {};
  }
}

function toInt(v: unknown): number {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v) : NaN;
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : 0;
}

export function normalizePublicKeyHex(v: unknown): string {
  if (typeof v !== 'string') return '';
  const hex = v.trim().toLowerCase().replace(/^0x/, '');
  return /^[0-9a-f]{64}$/.test(hex) ? hex : '';
}

export function loadLicenseConfig(env: NodeJS.ProcessEnv = process.env): LicenseConfig {
  const b = buildDefines();
  return {
    publicKeyHex: normalizePublicKeyHex(env.PRAJEALA_LICENSE_PUBLIC_KEY ?? b.licensePublicKey ?? ''),
    storeId: toInt(env.PRAJEALA_LS_STORE_ID ?? b.lsStoreId),
    productId: toInt(env.PRAJEALA_LS_PRODUCT_ID ?? b.lsProductId),
    buyUrl: (env.PRAJEALA_BUY_URL ?? b.buyUrl ?? '').trim() || DEFAULT_BUY_URL,
  };
}
