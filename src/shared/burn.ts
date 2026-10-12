/**
 * "Arde tot" — burning the real desktop. Shared contract + pure geometry
 * helpers (main computes rectangles in local CSS px, the renderer converts
 * them to texture space).
 */
import type { Rect } from './ipc';

export type BurnMode = 'screen' | 'window' | 'image';

/** Main → overlay: start burning this picture. */
export interface BurnStart {
  mode: BurnMode;
  /** Encoded picture (JPEG/PNG bytes) — decoded in the renderer with createImageBitmap. */
  image: Uint8Array;
  mime: string;
  /** Where the picture is drawn, local CSS px (the whole display for screen/window). */
  imageRect: Rect;
  /** The part that burns, local CSS px (the window for 'window', else = imageRect). */
  burnRect: Rect;
  /** First ignition point, local CSS px (cursor or centre). */
  ignite: { x: number; y: number };
  durationMs: number;
}

/** Overlay → main when its burn is over (finished, aborted or failed). */
export interface BurnDoneReport {
  ok: boolean;
  aborted: boolean;
  error?: string;
}

export const BURN_DURATION_MS = 10_000;
/** Longest side of the snapshot sent to a renderer (texture limits, upload time). */
export const BURN_MAX_SIDE = 4096;

/** UV rectangle (x0, y0, x1, y1) with y up — the convention of the GL passes. */
export type UvRect = [number, number, number, number];

/** Converts a local CSS rect (y down) into a y-up UV rect of a `width`×`height` canvas, clamped to [0,1]. */
export function toUvRect(r: Rect, width: number, height: number): UvRect {
  const w = Math.max(1, width);
  const h = Math.max(1, height);
  const clamp = (v: number) => Math.min(1, Math.max(0, v));
  return [clamp(r.x / w), clamp(1 - (r.y + r.height) / h), clamp((r.x + r.width) / w), clamp(1 - r.y / h)];
}

/** Largest rect with the aspect ratio of `imageW`×`imageH` that fits `box`, centred. */
export function fitContain(imageW: number, imageH: number, box: Rect, margin = 0): Rect {
  const bw = Math.max(1, box.width - margin * 2);
  const bh = Math.max(1, box.height - margin * 2);
  const k = Math.min(bw / Math.max(1, imageW), bh / Math.max(1, imageH));
  const w = Math.round(imageW * k);
  const h = Math.round(imageH * k);
  return { x: Math.round(box.x + (box.width - w) / 2), y: Math.round(box.y + (box.height - h) / 2), width: w, height: h };
}

/** Intersection of two rects (zero-size when they do not overlap). */
export function intersectRect(a: Rect, b: Rect): Rect {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const r = Math.min(a.x + a.width, b.x + b.width);
  const btm = Math.min(a.y + a.height, b.y + b.height);
  return { x, y, width: Math.max(0, r - x), height: Math.max(0, btm - y) };
}

/** Scale that keeps `w`×`h` within `maxSide` (1 when it already fits). */
export function downscaleFactor(w: number, h: number, maxSide = BURN_MAX_SIDE): number {
  const side = Math.max(w, h);
  return side > maxSide ? maxSide / side : 1;
}
