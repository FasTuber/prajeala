/**
 * Commercial configuration for Prăjeală Pro: what it costs, where to buy it and
 * how licences are checked. This is the one file to edit when setting up the
 * store — see docs/MONETIZARE.md for the step-by-step guide.
 *
 * Pure module (no Electron / DOM imports): main, preload-free renderers and
 * tests all read it.
 */

export interface LemonSqueezyConfig {
  /** Numeric store id (Lemon Squeezy → Settings → Stores). 0 = online activation disabled. */
  storeId: number;
  /**
   * Numeric product id of “Prăjeală Pro”. Keys from other products of the same
   * store are rejected. 0 = accept any product of `storeId`.
   */
  productId: number;
}

export interface ProductConfig {
  name: string;
  /** Shown on buttons and in the tray; the real price lives in the store. */
  priceLabel: string;
  /** Length of the automatic Pro trial that starts on first launch (0 disables it). */
  trialDays: number;
  /** Checkout link of the product (Lemon Squeezy “Share” URL). Empty → the website's #pro section. */
  buyUrl: string;
  websiteUrl: string;
  repoUrl: string;
  /** Optional “support the project” link (GitHub Sponsors, Ko-fi, Buy Me a Coffee…). */
  sponsorUrl: string;
  lemonSqueezy: LemonSqueezyConfig;
  /**
   * Ed25519 public key (SPKI, base64) that verifies offline `PRJ1-…` keys — the
   * ones you hand out yourself (giveaways, press, sponsors). Written by
   * `npm run license -- keygen`. Empty = offline keys disabled.
   */
  offlinePublicKey: string;
  /** Ids of offline keys that must stop working (leaked keys). */
  revokedOfflineKeyIds: readonly string[];
}

export const PRODUCT: Readonly<ProductConfig> = Object.freeze({
  name: 'Prăjeală Pro',
  priceLabel: '5 €',
  trialDays: 7,
  buyUrl: '',
  websiteUrl: 'https://fastuber.github.io/prajeala/',
  repoUrl: 'https://github.com/FasTuber/prajeala',
  sponsorUrl: '',
  lemonSqueezy: Object.freeze({ storeId: 0, productId: 0 }),
  offlinePublicKey: '',
  revokedOfflineKeyIds: Object.freeze([]),
});

/** Where “Buy Pro” leads: the checkout when configured, otherwise the pricing section of the website. */
export function buyUrl(config: ProductConfig = PRODUCT): string {
  return config.buyUrl || `${config.websiteUrl.replace(/\/?$/, '/')}#pro`;
}

export function isStoreConfigured(config: ProductConfig = PRODUCT): boolean {
  return Number.isInteger(config.lemonSqueezy.storeId) && config.lemonSqueezy.storeId > 0;
}

export type ExternalLink = 'buy' | 'website' | 'repo' | 'sponsor' | 'manage';

/** The only URLs the settings window may ask the main process to open. */
export function externalUrl(link: ExternalLink, config: ProductConfig = PRODUCT): string | null {
  switch (link) {
    case 'buy':
      return buyUrl(config);
    case 'website':
      return config.websiteUrl;
    case 'repo':
      return config.repoUrl;
    case 'sponsor':
      return config.sponsorUrl || null;
    case 'manage':
      // Lemon Squeezy's customer portal: buyers manage orders and licence activations there.
      return isStoreConfigured(config) ? 'https://app.lemonsqueezy.com/my-orders' : null;
    default:
      return null;
  }
}
