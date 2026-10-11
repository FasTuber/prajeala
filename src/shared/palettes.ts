/**
 * Fire colour ramps. Each palette is a list of stops `[t, r, g, b]` with
 * t ∈ [0,1] (temperature) and colours in [0,1]. The renderer bakes them into a
 * 1-D LUT texture; tests check monotonic stops and valid ranges.
 */
import type { Palette } from './settings';

export type ColorStop = readonly [t: number, r: number, g: number, b: number];

export interface PaletteDefinition {
  name: Palette;
  label: string;
  stops: readonly ColorStop[];
  /** Colour used for spark particles (r,g,b in 0..1). */
  spark: readonly [number, number, number];
}

export const PALETTE_DEFINITIONS: Readonly<Record<Palette, PaletteDefinition>> = Object.freeze({
  classic: {
    name: 'classic',
    label: 'Classic fire',
    stops: [
      [0.0, 0.0, 0.0, 0.0],
      [0.12, 0.25, 0.02, 0.0],
      [0.3, 0.75, 0.1, 0.0],
      [0.5, 1.0, 0.38, 0.02],
      [0.72, 1.0, 0.72, 0.15],
      [0.9, 1.0, 0.93, 0.55],
      [1.0, 1.0, 1.0, 0.95],
    ],
    spark: [1.0, 0.78, 0.35],
  },
  blue: {
    name: 'blue',
    label: 'Blue flame',
    stops: [
      [0.0, 0.0, 0.0, 0.0],
      [0.15, 0.0, 0.04, 0.3],
      [0.35, 0.02, 0.25, 0.85],
      [0.55, 0.2, 0.6, 1.0],
      [0.75, 0.55, 0.85, 1.0],
      [0.9, 0.85, 0.95, 1.0],
      [1.0, 1.0, 1.0, 1.0],
    ],
    spark: [0.6, 0.85, 1.0],
  },
  green: {
    name: 'green',
    label: 'Green fire',
    stops: [
      [0.0, 0.0, 0.0, 0.0],
      [0.15, 0.0, 0.18, 0.02],
      [0.35, 0.05, 0.55, 0.08],
      [0.55, 0.3, 0.9, 0.2],
      [0.75, 0.65, 1.0, 0.45],
      [0.9, 0.88, 1.0, 0.75],
      [1.0, 1.0, 1.0, 0.95],
    ],
    spark: [0.7, 1.0, 0.5],
  },
  plasma: {
    name: 'plasma',
    label: 'Plasma',
    stops: [
      [0.0, 0.0, 0.0, 0.0],
      [0.15, 0.2, 0.0, 0.35],
      [0.35, 0.6, 0.05, 0.75],
      [0.55, 0.95, 0.25, 0.7],
      [0.75, 1.0, 0.55, 0.45],
      [0.9, 1.0, 0.85, 0.35],
      [1.0, 1.0, 1.0, 0.9],
    ],
    spark: [1.0, 0.6, 0.95],
  },
  ember: {
    name: 'ember',
    label: 'Embers',
    stops: [
      [0.0, 0.0, 0.0, 0.0],
      [0.2, 0.18, 0.02, 0.0],
      [0.45, 0.55, 0.08, 0.0],
      [0.65, 0.85, 0.25, 0.02],
      [0.82, 1.0, 0.5, 0.1],
      [0.95, 1.0, 0.8, 0.35],
      [1.0, 1.0, 0.95, 0.7],
    ],
    spark: [1.0, 0.55, 0.2],
  },
  aurora: {
    name: 'aurora',
    label: 'Aurora',
    stops: [
      [0.0, 0.0, 0.0, 0.0],
      [0.15, 0.12, 0.0, 0.25],
      [0.35, 0.25, 0.1, 0.6],
      [0.55, 0.1, 0.65, 0.6],
      [0.75, 0.35, 0.95, 0.6],
      [0.9, 0.75, 1.0, 0.85],
      [1.0, 1.0, 1.0, 1.0],
    ],
    spark: [0.55, 1.0, 0.75],
  },
  gold: {
    name: 'gold',
    label: 'Molten gold',
    stops: [
      [0.0, 0.0, 0.0, 0.0],
      [0.15, 0.2, 0.1, 0.0],
      [0.35, 0.6, 0.35, 0.02],
      [0.55, 0.9, 0.65, 0.1],
      [0.75, 1.0, 0.85, 0.35],
      [0.9, 1.0, 0.95, 0.7],
      [1.0, 1.0, 1.0, 0.95],
    ],
    spark: [1.0, 0.88, 0.45],
  },
  ghost: {
    name: 'ghost',
    label: 'Ghost fire',
    stops: [
      [0.0, 0.0, 0.0, 0.0],
      [0.15, 0.08, 0.1, 0.14],
      [0.35, 0.3, 0.4, 0.5],
      [0.55, 0.6, 0.72, 0.8],
      [0.75, 0.82, 0.9, 0.97],
      [0.9, 0.94, 0.97, 1.0],
      [1.0, 1.0, 1.0, 1.0],
    ],
    spark: [0.85, 0.95, 1.0],
  },
});

/** Linear interpolation of a palette at temperature t ∈ [0,1]. Returns [r,g,b] in 0..1. */
export function samplePalette(def: PaletteDefinition, t: number): [number, number, number] {
  const stops = def.stops;
  const first = stops[0];
  const last = stops[stops.length - 1];
  if (!first || !last) return [0, 0, 0];
  if (t <= first[0]) return [first[1], first[2], first[3]];
  if (t >= last[0]) return [last[1], last[2], last[3]];
  for (let i = 0; i < stops.length - 1; i++) {
    const a = stops[i];
    const b = stops[i + 1];
    if (!a || !b) break;
    if (t >= a[0] && t <= b[0]) {
      const span = b[0] - a[0];
      const k = span > 0 ? (t - a[0]) / span : 0;
      return [a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k, a[3] + (b[3] - a[3]) * k];
    }
  }
  return [last[1], last[2], last[3]];
}

/** Bakes a palette into an RGBA8 lookup table of `size` texels (premultiplication is done in the shader). */
export function bakePaletteLut(def: PaletteDefinition, size = 256): Uint8Array {
  const out = new Uint8Array(size * 4);
  for (let i = 0; i < size; i++) {
    const t = size > 1 ? i / (size - 1) : 0;
    const [r, g, b] = samplePalette(def, t);
    out[i * 4 + 0] = Math.round(Math.min(1, Math.max(0, r)) * 255);
    out[i * 4 + 1] = Math.round(Math.min(1, Math.max(0, g)) * 255);
    out[i * 4 + 2] = Math.round(Math.min(1, Math.max(0, b)) * 255);
    out[i * 4 + 3] = 255;
  }
  return out;
}
