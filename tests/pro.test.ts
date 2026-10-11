import { describe, expect, it } from 'vitest';

import {
  FREE_INTENSITIES,
  FREE_PALETTES,
  PRO_PALETTES,
  allowedDisplayCount,
  effectiveSettings,
  isIntensityLocked,
  isPaletteLocked,
  lockedFeaturesInUse,
  nextAllowedIntensity,
  stripLockedChoices,
} from '../src/shared/pro';
import { DEFAULT_SETTINGS, INTENSITIES, PALETTES, normalizeSettings } from '../src/shared/settings';
import { PRODUCT, buyUrl, externalUrl, isStoreConfigured, type ProductConfig } from '../src/shared/product';

describe('free / pro split', () => {
  it('the defaults are usable without Pro', () => {
    expect(FREE_PALETTES).toContain(DEFAULT_SETTINGS.palette);
    expect(FREE_INTENSITIES).toContain(DEFAULT_SETTINGS.intensity);
    expect(effectiveSettings(DEFAULT_SETTINGS, false)).toBe(DEFAULT_SETTINGS);
  });

  it('every palette is either free or pro, and both groups are non-empty', () => {
    expect([...FREE_PALETTES, ...PRO_PALETTES].sort()).toEqual([...PALETTES].sort());
    expect(FREE_PALETTES.length).toBeGreaterThan(0);
    expect(PRO_PALETTES.length).toBeGreaterThan(0);
  });

  it('locks only apply without Pro', () => {
    for (const p of PALETTES) {
      expect(isPaletteLocked(p, true)).toBe(false);
      expect(isPaletteLocked(p, false)).toBe(!FREE_PALETTES.includes(p));
    }
    for (const i of INTENSITIES) {
      expect(isIntensityLocked(i, true)).toBe(false);
    }
    expect(isIntensityLocked('inferno', false)).toBe(true);
    expect(isIntensityLocked('high', false)).toBe(false);
  });

  it('effectiveSettings keeps Pro choices with Pro and falls back without it', () => {
    const stored = normalizeSettings({ palette: 'aurora', intensity: 'inferno', cursorMode: 'halo' });
    expect(effectiveSettings(stored, true)).toBe(stored);
    const free = effectiveSettings(stored, false);
    expect(free.palette).toBe(DEFAULT_SETTINGS.palette);
    expect(free.intensity).toBe('high');
    expect(free.cursorMode).toBe('halo');
    // the stored object is untouched
    expect(stored.palette).toBe('aurora');
  });

  it('lockedFeaturesInUse reports what a free install cannot deliver', () => {
    const stored = normalizeSettings({ palette: 'gold', intensity: 'inferno' });
    expect(lockedFeaturesInUse(stored, true, 3)).toEqual([]);
    expect(lockedFeaturesInUse(stored, false, 2)).toEqual(['palettes', 'inferno', 'multiMonitor']);
    expect(lockedFeaturesInUse(DEFAULT_SETTINGS, false, 1)).toEqual([]);
  });

  it('allowedDisplayCount limits free installs to the primary display', () => {
    expect(allowedDisplayCount(3, true)).toBe(3);
    expect(allowedDisplayCount(3, false)).toBe(1);
    expect(allowedDisplayCount(0, false)).toBe(0);
  });

  it('nextAllowedIntensity never steps onto a locked intensity', () => {
    expect(nextAllowedIntensity('high', 1, false)).toBe('high');
    expect(nextAllowedIntensity('high', 1, true)).toBe('inferno');
    expect(nextAllowedIntensity('inferno', -1, false)).toBe('medium');
    expect(nextAllowedIntensity('inferno', 1, false)).toBe('high');
    expect(nextAllowedIntensity('low', -1, false)).toBe('low');
  });
});

describe('stripLockedChoices', () => {
  it('drops Pro-only values from free patches and keeps everything else', () => {
    expect(stripLockedChoices({ palette: 'aurora', intensity: 'inferno', sparks: false }, false)).toEqual({ sparks: false });
    expect(stripLockedChoices({ palette: 'ember', intensity: 'high' }, false)).toEqual({ palette: 'ember', intensity: 'high' });
    expect(stripLockedChoices({ palette: 'aurora', intensity: 'inferno' }, true)).toEqual({ palette: 'aurora', intensity: 'inferno' });
    // unknown values are left for normalizeSettings to reject
    expect(stripLockedChoices({ palette: 'nope' }, false)).toEqual({ palette: 'nope' });
    expect(stripLockedChoices(null, false)).toEqual({});
    expect(stripLockedChoices([1, 2], false)).toEqual({});
  });
});

describe('product config', () => {
  const custom = (patch: Partial<ProductConfig>): ProductConfig => ({ ...PRODUCT, ...patch });

  it('buy link falls back to the pricing section of the website', () => {
    expect(buyUrl(custom({ buyUrl: '', websiteUrl: 'https://example.com/app' }))).toBe('https://example.com/app/#pro');
    expect(buyUrl(custom({ buyUrl: 'https://store.example/buy/1' }))).toBe('https://store.example/buy/1');
  });

  it('online activation needs a store id', () => {
    expect(isStoreConfigured(custom({ lemonSqueezy: { storeId: 0, productId: 0 } }))).toBe(false);
    expect(isStoreConfigured(custom({ lemonSqueezy: { storeId: 42, productId: 0 } }))).toBe(true);
  });

  it('only known links can be opened', () => {
    expect(externalUrl('website')).toBe(PRODUCT.websiteUrl);
    expect(externalUrl('sponsor', custom({ sponsorUrl: '' }))).toBeNull();
    expect(externalUrl('nope' as never)).toBeNull();
    for (const link of ['buy', 'website', 'repo'] as const) {
      expect(externalUrl(link)).toMatch(/^https:\/\//);
    }
  });
});
