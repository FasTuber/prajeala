import { describe, expect, it } from 'vitest';

import {
  CURSOR_MODES,
  DEFAULT_SETTINGS,
  INTENSITIES,
  INTENSITY_PRESETS,
  PALETTES,
  SETTINGS_LIMITS,
  mergeSettings,
  nextIntensity,
  normalizeSettings,
} from '../src/shared/settings';
import type { Intensity, IntensityPreset, Settings } from '../src/shared/settings';

const settingsKeys = Object.keys(DEFAULT_SETTINGS).sort();

describe('DEFAULT_SETTINGS / SETTINGS_LIMITS', () => {
  it('defaults are frozen and already valid', () => {
    expect(Object.isFrozen(DEFAULT_SETTINGS)).toBe(true);
    expect(normalizeSettings(DEFAULT_SETTINGS)).toEqual(DEFAULT_SETTINGS);
  });

  it('numeric defaults sit inside their limits', () => {
    for (const key of ['simScale', 'maxFps', 'pressureIterations', 'audioGain'] as const) {
      const { min, max } = SETTINGS_LIMITS[key];
      expect(min).toBeLessThan(max);
      expect(DEFAULT_SETTINGS[key]).toBeGreaterThanOrEqual(min);
      expect(DEFAULT_SETTINGS[key]).toBeLessThanOrEqual(max);
    }
  });

  it('enum defaults are members of their enums', () => {
    expect(INTENSITIES).toContain(DEFAULT_SETTINGS.intensity);
    expect(PALETTES).toContain(DEFAULT_SETTINGS.palette);
    expect(CURSOR_MODES).toContain(DEFAULT_SETTINGS.cursorMode);
  });
});

describe('normalizeSettings', () => {
  it('returns the defaults for non-object input', () => {
    for (const input of [undefined, null, 42, 'medium', true, [], [1, 2], () => 1, Symbol('x'), NaN]) {
      expect(normalizeSettings(input)).toEqual(DEFAULT_SETTINGS);
    }
  });

  it('returns a fresh, mutable object (never DEFAULT_SETTINGS itself)', () => {
    const a = normalizeSettings({});
    const b = normalizeSettings({});
    expect(a).toEqual(DEFAULT_SETTINGS);
    expect(a).not.toBe(DEFAULT_SETTINGS);
    expect(a).not.toBe(b);
    expect(Object.isFrozen(a)).toBe(false);
    a.maxFps = 30;
    expect(DEFAULT_SETTINGS.maxFps).toBe(60);
  });

  it('keeps exactly the known keys and drops unknown ones', () => {
    const out = normalizeSettings({ foo: 1, bar: 'x', __proto__: { evil: true }, maxFps: 30 });
    expect(Object.keys(out).sort()).toEqual(settingsKeys);
    expect('foo' in out).toBe(false);
    expect(out.maxFps).toBe(30);
  });

  it('passes through a fully valid object unchanged', () => {
    const valid: Settings = {
      enabled: false,
      intensity: 'inferno',
      palette: 'plasma',
      cursorMode: 'trail',
      clickBursts: false,
      burnActiveWindow: false,
      screenBottomFire: true,
      sparks: false,
      simScale: 0.5,
      maxFps: 120,
      pressureIterations: 20,
      launchAtLogin: true,
      showDebugHud: true,
      licenseOnlineCheck: false,
      audioReactive: true,
      audioSource: 'system',
      audioGain: 2,
    };
    expect(normalizeSettings(valid)).toEqual(valid);
  });

  describe('booleans', () => {
    const boolKeys = [
      'enabled',
      'clickBursts',
      'burnActiveWindow',
      'screenBottomFire',
      'sparks',
      'launchAtLogin',
      'showDebugHud',
      'licenseOnlineCheck',
      'audioReactive',
    ] as const;

    it.each(boolKeys)('%s accepts true/false and falls back to the default otherwise', (key) => {
      expect(normalizeSettings({ [key]: true })[key]).toBe(true);
      expect(normalizeSettings({ [key]: false })[key]).toBe(false);
      for (const bad of ['true', 'false', 1, 0, null, undefined, {}, [], 'yes']) {
        expect(normalizeSettings({ [key]: bad })[key]).toBe(DEFAULT_SETTINGS[key]);
      }
    });
  });

  describe('enums', () => {
    it('accepts every intensity, palette and cursor mode', () => {
      for (const intensity of INTENSITIES) expect(normalizeSettings({ intensity }).intensity).toBe(intensity);
      for (const palette of PALETTES) expect(normalizeSettings({ palette }).palette).toBe(palette);
      for (const cursorMode of CURSOR_MODES) expect(normalizeSettings({ cursorMode }).cursorMode).toBe(cursorMode);
    });

    it('falls back to the default for unknown or mis-cased values', () => {
      for (const bad of ['ultra', 'INFERNO', 'Medium', '', 2, null, true, {}, ['high']]) {
        expect(normalizeSettings({ intensity: bad }).intensity).toBe(DEFAULT_SETTINGS.intensity);
        expect(normalizeSettings({ palette: bad }).palette).toBe(DEFAULT_SETTINGS.palette);
        expect(normalizeSettings({ cursorMode: bad }).cursorMode).toBe(DEFAULT_SETTINGS.cursorMode);
      }
      expect(normalizeSettings({ palette: 'rainbow' }).palette).toBe('classic');
      expect(normalizeSettings({ cursorMode: 'laser' }).cursorMode).toBe('comet');
    });

    it('audioSource accepts microphone/system only', () => {
      expect(normalizeSettings({ audioSource: 'system' }).audioSource).toBe('system');
      expect(normalizeSettings({ audioSource: 'microphone' }).audioSource).toBe('microphone');
      expect(normalizeSettings({ audioSource: 'line-in' }).audioSource).toBe(DEFAULT_SETTINGS.audioSource);
    });
  });

  it('clamps audioGain and keeps the default at 1', () => {
    expect(DEFAULT_SETTINGS.audioGain).toBe(1);
    expect(normalizeSettings({ audioGain: 0 }).audioGain).toBe(SETTINGS_LIMITS.audioGain.min);
    expect(normalizeSettings({ audioGain: 99 }).audioGain).toBe(SETTINGS_LIMITS.audioGain.max);
    expect(normalizeSettings({ audioGain: '2' }).audioGain).toBe(2);
    expect(normalizeSettings({ audioGain: 'loud' }).audioGain).toBe(1);
  });

  describe('numbers', () => {
    it('clamps simScale, maxFps and pressureIterations to their limits', () => {
      expect(normalizeSettings({ simScale: 5 }).simScale).toBe(SETTINGS_LIMITS.simScale.max);
      expect(normalizeSettings({ simScale: 0 }).simScale).toBe(SETTINGS_LIMITS.simScale.min);
      expect(normalizeSettings({ simScale: -1 }).simScale).toBe(SETTINGS_LIMITS.simScale.min);
      expect(normalizeSettings({ simScale: 0.33 }).simScale).toBe(0.33);

      expect(normalizeSettings({ maxFps: 1000 }).maxFps).toBe(SETTINGS_LIMITS.maxFps.max);
      expect(normalizeSettings({ maxFps: 1 }).maxFps).toBe(SETTINGS_LIMITS.maxFps.min);
      expect(normalizeSettings({ maxFps: -60 }).maxFps).toBe(SETTINGS_LIMITS.maxFps.min);

      expect(normalizeSettings({ pressureIterations: 100 }).pressureIterations).toBe(
        SETTINGS_LIMITS.pressureIterations.max,
      );
      expect(normalizeSettings({ pressureIterations: -5 }).pressureIterations).toBe(
        SETTINGS_LIMITS.pressureIterations.min,
      );
      expect(normalizeSettings({ pressureIterations: 0 }).pressureIterations).toBe(0);
    });

    it('keeps the limits inclusive', () => {
      expect(normalizeSettings({ simScale: 0.1 }).simScale).toBe(0.1);
      expect(normalizeSettings({ simScale: 1 }).simScale).toBe(1);
      expect(normalizeSettings({ maxFps: 15 }).maxFps).toBe(15);
      expect(normalizeSettings({ maxFps: 240 }).maxFps).toBe(240);
      expect(normalizeSettings({ pressureIterations: 64 }).pressureIterations).toBe(64);
    });

    it('rounds the integer settings but not simScale', () => {
      expect(normalizeSettings({ maxFps: 59.6 }).maxFps).toBe(60);
      expect(normalizeSettings({ maxFps: 29.5 }).maxFps).toBe(30);
      expect(normalizeSettings({ pressureIterations: 12.4 }).pressureIterations).toBe(12);
      expect(normalizeSettings({ simScale: 0.333 }).simScale).toBe(0.333);
    });

    it('accepts numeric strings', () => {
      expect(normalizeSettings({ simScale: '0.5' }).simScale).toBe(0.5);
      expect(normalizeSettings({ maxFps: '120' }).maxFps).toBe(120);
      expect(normalizeSettings({ maxFps: ' 144 ' }).maxFps).toBe(144);
      expect(normalizeSettings({ maxFps: '29.5' }).maxFps).toBe(30);
      expect(normalizeSettings({ pressureIterations: '8' }).pressureIterations).toBe(8);
      expect(normalizeSettings({ maxFps: '9999' }).maxFps).toBe(SETTINGS_LIMITS.maxFps.max);
    });

    it('falls back to the default for non-numeric input', () => {
      for (const bad of ['abc', '12px', NaN, Infinity, -Infinity, null, undefined, true, false, {}, [1], () => 1]) {
        expect(normalizeSettings({ simScale: bad }).simScale).toBe(DEFAULT_SETTINGS.simScale);
        expect(normalizeSettings({ maxFps: bad }).maxFps).toBe(DEFAULT_SETTINGS.maxFps);
        expect(normalizeSettings({ pressureIterations: bad }).pressureIterations).toBe(
          DEFAULT_SETTINGS.pressureIterations,
        );
      }
    });
  });

  it('never throws, whatever the shape of the input', () => {
    const weird: unknown[] = [
      Object.create(null),
      { simScale: { valueOf: () => 0.5 } },
      { intensity: Symbol('high') },
      { maxFps: 10n },
      new Date(),
      new Map([['maxFps', 30]]),
      /regex/,
      { toString: null },
    ];
    for (const input of weird) {
      expect(() => normalizeSettings(input)).not.toThrow();
      expect(Object.keys(normalizeSettings(input)).sort()).toEqual(settingsKeys);
    }
  });
});

describe('mergeSettings', () => {
  const current: Settings = { ...DEFAULT_SETTINGS, intensity: 'high', maxFps: 30, sparks: false };

  it('applies a partial patch on top of the current settings', () => {
    const out = mergeSettings(current, { palette: 'blue', simScale: 0.5 });
    expect(out).toEqual({ ...current, palette: 'blue', simScale: 0.5 });
  });

  it('does not mutate its inputs and returns a new object', () => {
    const snapshot = { ...current };
    const patch = { maxFps: 90 };
    const out = mergeSettings(current, patch);
    expect(current).toEqual(snapshot);
    expect(patch).toEqual({ maxFps: 90 });
    expect(out).not.toBe(current);
    expect(out.maxFps).toBe(90);
  });

  it('re-validates the patch (clamping, string numbers)', () => {
    expect(mergeSettings(current, { maxFps: 10_000 }).maxFps).toBe(SETTINGS_LIMITS.maxFps.max);
    expect(mergeSettings(current, { simScale: '0.75' as unknown as number }).simScale).toBe(0.75);
    expect(mergeSettings(current, { pressureIterations: 3.7 }).pressureIterations).toBe(4);
  });

  it('invalid patch values fall back to the defaults (current contract: patch wins, then normalize)', () => {
    expect(mergeSettings(current, { intensity: 'nope' }).intensity).toBe(DEFAULT_SETTINGS.intensity);
    expect(mergeSettings(current, { maxFps: 'abc' }).maxFps).toBe(DEFAULT_SETTINGS.maxFps);
  });

  it('treats non-object patches as empty', () => {
    for (const patch of [undefined, null, 'high', 42, true, []]) {
      expect(mergeSettings(current, patch)).toEqual(current);
    }
  });

  it('also sanitises an invalid "current" value', () => {
    const broken = { ...current, palette: 'rainbow' } as unknown as Settings;
    expect(mergeSettings(broken, {}).palette).toBe(DEFAULT_SETTINGS.palette);
  });

  it('can be chained without drift', () => {
    let s = normalizeSettings({});
    s = mergeSettings(s, { intensity: 'low' });
    s = mergeSettings(s, { cursorMode: 'halo' });
    s = mergeSettings(s, { enabled: false });
    expect(s).toEqual({ ...DEFAULT_SETTINGS, intensity: 'low', cursorMode: 'halo', enabled: false });
  });
});

describe('nextIntensity', () => {
  it('steps up and down through the ordered presets', () => {
    expect(nextIntensity('low', 1)).toBe('medium');
    expect(nextIntensity('medium', 1)).toBe('high');
    expect(nextIntensity('high', 1)).toBe('inferno');
    expect(nextIntensity('inferno', -1)).toBe('high');
    expect(nextIntensity('high', -1)).toBe('medium');
    expect(nextIntensity('medium', -1)).toBe('low');
  });

  it('saturates at both ends', () => {
    expect(nextIntensity('low', -1)).toBe('low');
    expect(nextIntensity('inferno', 1)).toBe('inferno');
  });

  it('walks from low to inferno and back in INTENSITIES.length - 1 steps', () => {
    let i: Intensity = 'low';
    for (let n = 0; n < INTENSITIES.length - 1; n++) i = nextIntensity(i, 1);
    expect(i).toBe(INTENSITIES[INTENSITIES.length - 1]);
    for (let n = 0; n < INTENSITIES.length - 1; n++) i = nextIntensity(i, -1);
    expect(i).toBe(INTENSITIES[0]);
  });

  it('maps an unknown value onto the first preset instead of throwing', () => {
    expect(nextIntensity('bogus' as Intensity, 1)).toBe(INTENSITIES[0]);
    expect(nextIntensity('bogus' as Intensity, -1)).toBe(INTENSITIES[0]);
  });
});

describe('INTENSITY_PRESETS', () => {
  const presetKeys: (keyof IntensityPreset)[] = [
    'heat',
    'velocity',
    'radius',
    'heatDissipation',
    'velocityDissipation',
    'buoyancy',
    'curl',
    'burst',
    'ambient',
    'sparkBudget',
  ];

  it('has a complete, finite, positive preset for every intensity', () => {
    expect(Object.keys(INTENSITY_PRESETS).sort()).toEqual([...INTENSITIES].sort());
    for (const intensity of INTENSITIES) {
      const preset = INTENSITY_PRESETS[intensity];
      for (const key of presetKeys) {
        expect(Number.isFinite(preset[key]), `${intensity}.${key}`).toBe(true);
        expect(preset[key], `${intensity}.${key}`).toBeGreaterThanOrEqual(0);
      }
      expect(Number.isInteger(preset.sparkBudget)).toBe(true);
    }
  });

  it('keeps dissipation factors in (0, 1] so the fluid never grows on its own', () => {
    for (const intensity of INTENSITIES) {
      const { heatDissipation, velocityDissipation } = INTENSITY_PRESETS[intensity];
      expect(heatDissipation).toBeGreaterThan(0);
      expect(heatDissipation).toBeLessThanOrEqual(1);
      expect(velocityDissipation).toBeGreaterThan(0);
      expect(velocityDissipation).toBeLessThanOrEqual(1);
    }
  });

  it.each(['heat', 'velocity', 'burst'] as const)('%s is non-decreasing from low to inferno', (key) => {
    const values = INTENSITIES.map((i) => INTENSITY_PRESETS[i][key]);
    for (let n = 1; n < values.length; n++) {
      expect(values[n], `${INTENSITIES[n]} >= ${INTENSITIES[n - 1]}`).toBeGreaterThanOrEqual(values[n - 1]!);
    }
  });

  it('inferno is strictly hotter than low', () => {
    expect(INTENSITY_PRESETS.inferno.heat).toBeGreaterThan(INTENSITY_PRESETS.low.heat);
    expect(INTENSITY_PRESETS.inferno.burst).toBeGreaterThan(INTENSITY_PRESETS.low.burst);
    expect(INTENSITY_PRESETS.inferno.sparkBudget).toBeGreaterThan(INTENSITY_PRESETS.low.sparkBudget);
  });

  it('is frozen', () => {
    expect(Object.isFrozen(INTENSITY_PRESETS)).toBe(true);
  });
});
