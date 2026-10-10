import { describe, expect, it } from 'vitest';

import { PALETTE_DEFINITIONS, bakePaletteLut, samplePalette } from '../src/shared/palettes';
import type { ColorStop, PaletteDefinition } from '../src/shared/palettes';
import { PALETTES } from '../src/shared/settings';

const luminance = (r: number, g: number, b: number) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

const custom = (name: string, stops: ColorStop[]): PaletteDefinition => ({
  name: 'classic',
  label: name,
  stops,
  spark: [1, 1, 1],
});

describe('PALETTE_DEFINITIONS', () => {
  it('defines exactly the palettes listed in settings, with matching names and labels', () => {
    expect(Object.keys(PALETTE_DEFINITIONS).sort()).toEqual([...PALETTES].sort());
    for (const name of PALETTES) {
      const def = PALETTE_DEFINITIONS[name];
      expect(def.name).toBe(name);
      expect(def.label.trim().length).toBeGreaterThan(0);
    }
  });

  it.each(PALETTES)('%s: stops start at t=0, end at t=1 and are strictly increasing', (name) => {
    const { stops } = PALETTE_DEFINITIONS[name];
    expect(stops.length).toBeGreaterThanOrEqual(2);
    expect(stops[0]![0]).toBe(0);
    expect(stops[stops.length - 1]![0]).toBe(1);
    for (let i = 1; i < stops.length; i++) {
      expect(stops[i]![0], `stop ${i} t`).toBeGreaterThan(stops[i - 1]![0]);
    }
  });

  it.each(PALETTES)('%s: every colour component (and the spark colour) is within 0..1', (name) => {
    const { stops, spark } = PALETTE_DEFINITIONS[name];
    for (const [t, r, g, b] of stops) {
      for (const v of [t, r, g, b]) {
        expect(Number.isFinite(v)).toBe(true);
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(1);
      }
    }
    expect(spark).toHaveLength(3);
    for (const v of spark) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
  });

  it.each(PALETTES)('%s: cold end is black and hot end is the brightest stop', (name) => {
    const { stops } = PALETTE_DEFINITIONS[name];
    const [, r0, g0, b0] = stops[0]!;
    expect([r0, g0, b0]).toEqual([0, 0, 0]);
    const lums = stops.map(([, r, g, b]) => luminance(r, g, b));
    expect(Math.max(...lums)).toBe(lums[lums.length - 1]);
  });
});

describe('samplePalette', () => {
  it.each(PALETTES)('%s: returns the exact colour at every stop', (name) => {
    const def = PALETTE_DEFINITIONS[name];
    for (const [t, r, g, b] of def.stops) {
      const [sr, sg, sb] = samplePalette(def, t);
      expect(sr).toBeCloseTo(r, 12);
      expect(sg).toBeCloseTo(g, 12);
      expect(sb).toBeCloseTo(b, 12);
    }
  });

  it.each(PALETTES)('%s: endpoints and clamping', (name) => {
    const def = PALETTE_DEFINITIONS[name];
    const first = def.stops[0]!;
    const last = def.stops[def.stops.length - 1]!;
    expect(samplePalette(def, 0)).toEqual([first[1], first[2], first[3]]);
    expect(samplePalette(def, 1)).toEqual([last[1], last[2], last[3]]);
    expect(samplePalette(def, -0.5)).toEqual([first[1], first[2], first[3]]);
    expect(samplePalette(def, -Infinity)).toEqual([first[1], first[2], first[3]]);
    expect(samplePalette(def, 1.5)).toEqual([last[1], last[2], last[3]]);
    expect(samplePalette(def, Infinity)).toEqual([last[1], last[2], last[3]]);
  });

  it.each(PALETTES)('%s: the midpoint between two stops is the average of their colours', (name) => {
    const def = PALETTE_DEFINITIONS[name];
    for (let i = 1; i < def.stops.length; i++) {
      const a = def.stops[i - 1]!;
      const b = def.stops[i]!;
      const [r, g, bl] = samplePalette(def, (a[0] + b[0]) / 2);
      expect(r).toBeCloseTo((a[1] + b[1]) / 2, 12);
      expect(g).toBeCloseTo((a[2] + b[2]) / 2, 12);
      expect(bl).toBeCloseTo((a[3] + b[3]) / 2, 12);
    }
  });

  it('interpolates linearly inside a segment (classic, t=0.4)', () => {
    // classic: [0.3 → 0.75, 0.10, 0.00] and [0.5 → 1.00, 0.38, 0.02]; t=0.4 is halfway.
    const [r, g, b] = samplePalette(PALETTE_DEFINITIONS.classic, 0.4);
    expect(r).toBeCloseTo(0.875, 12);
    expect(g).toBeCloseTo(0.24, 12);
    expect(b).toBeCloseTo(0.01, 12);
    // quarter of the way through the same segment
    const [r2, g2] = samplePalette(PALETTE_DEFINITIONS.classic, 0.35);
    expect(r2).toBeCloseTo(0.8125, 12);
    expect(g2).toBeCloseTo(0.17, 12);
  });

  it('never returns components outside 0..1 for any t', () => {
    for (const name of PALETTES) {
      const def = PALETTE_DEFINITIONS[name];
      for (let i = 0; i <= 1000; i++) {
        const rgb = samplePalette(def, i / 1000);
        for (const v of rgb) {
          expect(v).toBeGreaterThanOrEqual(0);
          expect(v).toBeLessThanOrEqual(1);
        }
      }
    }
  });

  it('handles degenerate definitions without throwing', () => {
    expect(samplePalette(custom('empty', []), 0.5)).toEqual([0, 0, 0]);
    const single = custom('single', [[0.5, 0.1, 0.2, 0.3]]);
    expect(samplePalette(single, 0)).toEqual([0.1, 0.2, 0.3]);
    expect(samplePalette(single, 0.5)).toEqual([0.1, 0.2, 0.3]);
    expect(samplePalette(single, 1)).toEqual([0.1, 0.2, 0.3]);
    // duplicate t: zero-length span must not divide by zero
    const dup = custom('dup', [
      [0, 0, 0, 0],
      [0.5, 1, 0, 0],
      [0.5, 0, 1, 0],
      [1, 0, 0, 1],
    ]);
    const mid = samplePalette(dup, 0.5);
    for (const v of mid) expect(Number.isFinite(v)).toBe(true);
    expect(samplePalette(dup, 0.75)).toEqual([0, 0.5, 0.5]);
  });
});

describe('bakePaletteLut', () => {
  it('produces size*4 bytes, 256 texels by default', () => {
    const lut = bakePaletteLut(PALETTE_DEFINITIONS.classic);
    expect(lut).toBeInstanceOf(Uint8Array);
    expect(lut.length).toBe(256 * 4);
    expect(bakePaletteLut(PALETTE_DEFINITIONS.classic, 64).length).toBe(64 * 4);
    expect(bakePaletteLut(PALETTE_DEFINITIONS.classic, 1).length).toBe(4);
  });

  it.each(PALETTES)('%s: alpha is 255 everywhere (premultiplication happens in the shader)', (name) => {
    const lut = bakePaletteLut(PALETTE_DEFINITIONS[name]);
    for (let i = 3; i < lut.length; i += 4) expect(lut[i]).toBe(255);
  });

  it.each(PALETTES)('%s: first texel is black, last texel is the hot-end colour and the brightest', (name) => {
    const def = PALETTE_DEFINITIONS[name];
    const lut = bakePaletteLut(def);
    expect(Array.from(lut.subarray(0, 4))).toEqual([0, 0, 0, 255]);

    const last = def.stops[def.stops.length - 1]!;
    const n = lut.length / 4;
    expect(Array.from(lut.subarray((n - 1) * 4, n * 4))).toEqual([
      Math.round(last[1] * 255),
      Math.round(last[2] * 255),
      Math.round(last[3] * 255),
      255,
    ]);

    const lastLum = luminance(lut[(n - 1) * 4]!, lut[(n - 1) * 4 + 1]!, lut[(n - 1) * 4 + 2]!);
    for (let i = 0; i < n; i++) {
      expect(luminance(lut[i * 4]!, lut[i * 4 + 1]!, lut[i * 4 + 2]!)).toBeLessThanOrEqual(lastLum + 1e-9);
    }
  });

  it.each(PALETTES)('%s: brightness never decreases along the ramp (hotter = brighter)', (name) => {
    const lut = bakePaletteLut(PALETTE_DEFINITIONS[name]);
    let prev = -1;
    for (let i = 0; i < lut.length / 4; i++) {
      const lum = luminance(lut[i * 4]!, lut[i * 4 + 1]!, lut[i * 4 + 2]!);
      // allow one unit of 8-bit rounding noise
      expect(lum).toBeGreaterThanOrEqual(prev - 1);
      prev = lum;
    }
  });

  it('samples t uniformly from 0 to 1 inclusive', () => {
    const ramp = custom('ramp', [
      [0, 0, 0, 0],
      [1, 1, 1, 1],
    ]);
    const lut = bakePaletteLut(ramp, 5); // t = 0, .25, .5, .75, 1
    expect(Array.from(lut)).toEqual([0, 0, 0, 255, 64, 64, 64, 255, 128, 128, 128, 255, 191, 191, 191, 255, 255, 255, 255, 255]);
  });

  it('clamps out-of-range colours to 0..255 when baking', () => {
    const wild = custom('wild', [
      [0, -1, 2, 0.5],
      [1, 3, -2, 0.5],
    ]);
    const lut = bakePaletteLut(wild, 2);
    expect(Array.from(lut)).toEqual([0, 255, 128, 255, 255, 0, 128, 255]);
  });

  it('matches samplePalette texel by texel', () => {
    const def = PALETTE_DEFINITIONS.ember;
    const size = 32;
    const lut = bakePaletteLut(def, size);
    for (let i = 0; i < size; i++) {
      const [r, g, b] = samplePalette(def, i / (size - 1));
      expect(lut[i * 4]).toBe(Math.round(r * 255));
      expect(lut[i * 4 + 1]).toBe(Math.round(g * 255));
      expect(lut[i * 4 + 2]).toBe(Math.round(b * 255));
    }
  });
});
