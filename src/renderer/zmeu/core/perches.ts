/**
 * Where the dragon may sit: the active window's title-bar ledge and four
 * floor spots, plus the breath plan along a window's top edge and the
 * classifier for active-window changes. Pure; results go into caller-owned
 * objects.
 */
import type { Rect } from '../../../shared/ipc';
import type { Random } from '../../util/math';
import type { ZmeuSenses } from './senses';
import { ZMEU_TUNING as T } from './tuning';
import { hyp } from './vec';

export interface ZmeuPerch {
  /** Anchor on the edge (CSS px). */
  x: number;
  y: number;
  facing: number;
  /** 1 = the tail drapes over a window edge, 0 = resting on the floor. */
  drape: number;
  window: boolean;
  /** Window perches: anchor x as a fraction of the window width. */
  fx: number;
  /** Usable ledge span (CSS px), for make-way hops. */
  x0: number;
  x1: number;
}

export function createPerch(): ZmeuPerch {
  return { x: 0, y: 0, facing: 1, drape: 0, window: false, fx: 0.5, x0: 0, x1: 0 };
}

export function copyPerch(dst: ZmeuPerch, src: ZmeuPerch): ZmeuPerch {
  dst.x = src.x;
  dst.y = src.y;
  dst.facing = src.facing;
  dst.drape = src.drape;
  dst.window = src.window;
  dst.fx = src.fx;
  dst.x0 = src.x0;
  dst.x1 = src.x1;
  return dst;
}

/** The usable title-bar span of `win` (minus margins and the buttons zone), or null when the ledge is not a valid perch. */
export function windowSpan(s: Readonly<ZmeuSenses>, out: { x0: number; x1: number }): boolean {
  const w = s.win;
  if (!w || s.winMaximized || !(w.width > 0) || !(w.height > 0)) return false;
  const L = s.L;
  const m = T.boundsMargin * s.S;
  if (w.y < 0.3 * L || w.y > s.floor - 0.15 * s.S) return false;
  let x0 = Math.max(w.x, m);
  let x1 = Math.min(w.x + w.width, s.width - m);
  if (s.buttonsZone === 'left90') x0 = Math.max(x0, w.x + 90);
  else x1 = Math.min(x1, w.x + w.width - 150);
  if (!(x1 - x0 >= 0.8 * L)) return false;
  out.x0 = x0;
  out.x1 = x1;
  return true;
}

const span = { x0: 0, x1: 0 };

/** A perch on the active window's ledge, anchored in the middle third of its usable span; null when invalid. */
export function pickWindowPerch(s: Readonly<ZmeuSenses>, rng: Random, out: ZmeuPerch): ZmeuPerch | null {
  if (!windowSpan(s, span)) return null;
  const w = s.win!;
  const len = span.x1 - span.x0;
  const x = span.x0 + len / 3 + rng.next() * (len / 3);
  out.x = x;
  out.y = w.y;
  out.facing = s.cursorKnown && s.cursorInside ? (s.cx >= x ? 1 : -1) : rng.next() < 0.5 ? -1 : 1;
  out.drape = 1;
  out.window = true;
  out.fx = (x - w.x) / w.width;
  out.x0 = span.x0;
  out.x1 = span.x1;
  return out;
}

/** The four floor spots at 0.12, 0.30, 0.70 and 0.88 of the width, facing the screen centre. */
export function floorPerches(s: Readonly<ZmeuSenses>, out: readonly ZmeuPerch[]): readonly ZmeuPerch[] {
  const fr = FLOOR_X;
  const m = T.boundsMargin * s.S;
  for (let i = 0; i < out.length && i < fr.length; i++) {
    const p = out[i]!;
    p.x = fr[i]! * s.width;
    p.y = s.floor;
    p.facing = fr[i]! < 0.5 ? 1 : -1;
    p.drape = 0;
    p.window = false;
    p.fx = 0;
    p.x0 = m;
    p.x1 = s.width - m;
  }
  return out;
}

export const FLOOR_X: readonly number[] = [0.12, 0.3, 0.7, 0.88];

/**
 * The sleep spot: the floor perch farthest from the window's centre among those
 * reachable within `reach` px of (hx, hy); the nearest one when there is no window.
 */
export function sleepPerch(s: Readonly<ZmeuSenses>, floors: readonly ZmeuPerch[], hx: number, hy: number, reach: number, out: ZmeuPerch): ZmeuPerch {
  const w = s.win;
  let best = -1;
  let bestScore = -Infinity;
  let nearest = 0;
  let nearestD = Infinity;
  for (let i = 0; i < floors.length; i++) {
    const p = floors[i]!;
    const d = hyp(p.x - hx, p.y - hy);
    if (d < nearestD) {
      nearestD = d;
      nearest = i;
    }
    if (!w || d > reach) continue;
    const score = Math.abs(p.x - (w.x + w.width / 2));
    if (score > bestScore) {
      bestScore = score;
      best = i;
    }
  }
  return copyPerch(out, floors[best >= 0 ? best : nearest]!);
}

export type ZmeuWindowChange = 'same' | 'moved' | 'new';

/**
 * Classifies an active-window update. `new`: the app key changed, a window
 * appeared, or it jumped more than 0.1·S. A title-only change keeps the key
 * (App hashes the app name), so it reads as `same`.
 */
export function classifyWindowChange(prev: Rect | null, next: Rect | null, prevKey: number, nextKey: number, S: number): ZmeuWindowChange {
  if (!next) return prev ? 'moved' : 'same';
  if (!prev || prevKey !== nextKey) return 'new';
  const jump = hyp(next.x - prev.x, next.y - prev.y);
  if (jump > 0.1 * S) return 'new';
  if (jump > 0.5 || Math.abs(next.width - prev.width) > 0.5 || Math.abs(next.height - prev.height) > 0.5) return 'moved';
  return 'same';
}

export interface ZmeuBreathPlan {
  /** Hover point while aiming and blasting. */
  hoverX: number;
  hoverY: number;
  /** The impact sweeps along y = edgeY from x0 (near corner) to x1 (60 % of the width). */
  x0: number;
  x1: number;
  edgeY: number;
  /** −1 / +1: which side of the window the dragon hovers on. */
  side: number;
}

/** Plans a fire breath along the top edge of `win`; false when the edge is not usable on this display. */
export function breathPlan(win: Rect | null, headX: number, _headY: number, s: Readonly<ZmeuSenses>, _rng: Random, out: ZmeuBreathPlan): boolean {
  if (!win || !(win.width > 0) || !(win.height > 0)) return false;
  const S = s.S;
  const W = s.width;
  if (win.y < 0.05 * S || win.y > s.floor - 0.05 * S) return false;
  const left = Math.max(win.x, 0);
  const right = Math.min(win.x + win.width, W);
  if (right - left < 40) return false;
  const nearLeft = headX < (left + right) / 2;
  const span = (right - left) * 0.6;
  out.x0 = nearLeft ? left + 2 : right - 2;
  out.x1 = nearLeft ? left + span : right - span;
  out.side = nearLeft ? -1 : 1;
  out.edgeY = win.y;
  const m = T.boundsMargin * S;
  out.hoverX = Math.min(W - m, Math.max(m, out.x0 + out.side * 0.2 * S));
  out.hoverY = Math.max(win.y - 0.16 * S, 0.08 * S);
  return true;
}
