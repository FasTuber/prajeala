/**
 * Rectangle helpers used to convert global DIP coordinates into per-overlay
 * local coordinates (see the convention in src/shared/ipc.ts).
 */
import type { Rect } from '../shared/ipc';

export interface Point {
  x: number;
  y: number;
}

export function rectContainsPoint(r: Rect, p: Point): boolean {
  return p.x >= r.x && p.y >= r.y && p.x < r.x + r.width && p.y < r.y + r.height;
}

export function rectsIntersect(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
}

export function rectsEqual(a: Rect, b: Rect): boolean {
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
}

/** Translates a global point into coordinates local to `origin` (a display's bounds). */
export function toLocalPoint(p: Point, origin: Rect): Point {
  return { x: p.x - origin.x, y: p.y - origin.y };
}

/** Translates a global rect into coordinates local to `origin` (a display's bounds). */
export function toLocalRect(r: Rect, origin: Rect): Rect {
  return { x: r.x - origin.x, y: r.y - origin.y, width: r.width, height: r.height };
}

export function rectCenter(r: Rect): Point {
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
}
