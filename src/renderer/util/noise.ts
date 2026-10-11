/**
 * CPU-side value noise used for emitter flicker and spark turbulence.
 * Allocation free; the same hash is used by the GLSL noise chunk so the two
 * "feel" alike even if they are not bit-identical.
 */
import { hashInt } from './math';

function fade(t: number): number {
  return t * t * (3 - 2 * t);
}

/** 1-D value noise in [0,1]; `lane` selects an independent channel. */
export function noise1(x: number, lane = 0): number {
  const i = Math.floor(x);
  const f = fade(x - i);
  const a = hashInt(i * 7919 + lane * 104729);
  const b = hashInt((i + 1) * 7919 + lane * 104729);
  return a + (b - a) * f;
}

/** 2-D value noise in [0,1]. */
export function noise2(x: number, y: number, lane = 0): number {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = fade(x - ix);
  const fy = fade(y - iy);
  const s = lane * 104729;
  const h = (px: number, py: number): number => hashInt(px * 7919 + py * 31337 + s);
  const a = h(ix, iy);
  const b = h(ix + 1, iy);
  const c = h(ix, iy + 1);
  const d = h(ix + 1, iy + 1);
  const ab = a + (b - a) * fx;
  const cd = c + (d - c) * fx;
  return ab + (cd - ab) * fy;
}

/**
 * Two-octave flicker in [0,1] for emitter strength modulation. Deliberately
 * slow (≈3 Hz + a weak 8 Hz octave): faster flicker imprints visible bands on
 * the rising plume because the field is advected at a nearly constant speed.
 */
export function flicker(t: number, lane: number): number {
  return 0.72 * noise1(t * 3.0, lane) + 0.28 * noise1(t * 8.0 + 3.1, lane + 977);
}
