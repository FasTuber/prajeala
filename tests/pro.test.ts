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
    const free = effectiveSettings(DEFAULT_SETTINGS, false);
    expect(free.palette).toBe(DEFAULT_SETTINGS.palette);
    expect(free.intensity).toBe(DEFAULT_SETTINGS.intensity);
    expect(free.typingFire).toBe(false); // Pro feature
    expect(effectiveSettings(DEFAULT_SETTINGS, true)).toBe(DEFAULT_SETTINGS);
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

describe('Ritmul Focului gating', () => {
  it('keeps the EQ wall for Pro and falls back to pulses without it', () => {
    const stored = normalizeSettings({ audioSource: 'system', audioStyle: 'eq' });
    expect(effectiveSettings(stored, true).audioStyle).toBe('eq');
    const free = effectiveSettings(stored, false);
    expect(free.audioStyle).toBe('pulse');
    expect(free.audioSource).toBe('system');
    expect(stripLockedChoices({ audioStyle: 'eq', audioDrops: true }, false)).toEqual({ audioDrops: true });
  });
  it('the early-return identity check covers every Pro field (regression)', () => {
    // A free install with only a Pro audio style stored must still get a corrected object.
    const onlyEq = normalizeSettings({ audioStyle: 'eq' });
    expect(effectiveSettings(onlyEq, false)).not.toBe(onlyEq);
  });
});

describe('Mod Torță gating', () => {
  it('is Pro only, stripped from free patches and reported as locked', () => {
    const stored = normalizeSettings({ torch: true });
    expect(effectiveSettings(stored, true).torch).toBe(true);
    expect(effectiveSettings(stored, false).torch).toBe(false);
    expect(effectiveSettings(stored, false)).not.toBe(stored);
    expect(stripLockedChoices({ torch: true, sparks: false }, false)).toEqual({ sparks: false });
    expect(stripLockedChoices({ torch: false }, false)).toEqual({ torch: false });
    expect(lockedFeaturesInUse(stored, false, 1)).toContain('torch');
  });
});

describe('custom palette and colours', () => {
  it('normalizes custom colours and keeps them out of free installs', async () => {
    const { customPalette, resolvePalette, PALETTE_DEFINITIONS } = await import('../src/shared/palettes');
    const s = normalizeSettings({ customColors: ['#00FF00', 'nope', '#123456', '#ffffff'] });
    expect(s.customColors).toEqual(['#00ff00', DEFAULT_SETTINGS.customColors[1], '#123456']);
    expect(isPaletteLocked('custom', false)).toBe(true);
    const def = customPalette(['#ff0000', '#00ff00', '#0000ff']);
    expect(def.stops[0]).toEqual([0, 0, 0, 0]);
    expect(def.stops[2]).toEqual([0.45, 1, 0, 0]);
    expect(def.stops.at(-1)![0]).toBe(1);
    expect(resolvePalette('aurora', s.customColors)).toBe(PALETTE_DEFINITIONS.aurora);
    expect(resolvePalette('custom', ['#ff0000', '#00ff00', '#0000ff'])).toEqual(def);
  });
});
