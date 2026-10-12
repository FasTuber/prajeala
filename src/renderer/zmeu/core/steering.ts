/**
 * Reynolds-style steering for the dragon's head, per substep. Every function
 * writes into caller-owned vectors (no allocation); positions are CSS px with
 * y down and velocities px/s.
 */
import { ZMEU_TUNING as T } from './tuning';
import { hyp } from './vec';

export interface Vec2 {
  x: number;
  y: number;
}

export interface ZmeuAgent {
  x: number;
  y: number;
  vx: number;
  vy: number;
}

export interface SteerLimits {
  /** Max speed (px/s), acceleration (px/s²) and turn rate (rad/s). */
  vmax: number;
  amax: number;
  omega: number;
}

/** Desired velocity toward (tx, ty), slowing down inside `slowR`. */
export function arrive(out: Vec2, px: number, py: number, tx: number, ty: number, vmax: number, slowR: number): Vec2 {
  const dx = tx - px;
  const dy = ty - py;
  const d = hyp(dx, dy);
  if (!(d > 1e-6)) {
    out.x = 0;
    out.y = 0;
    return out;
  }
  const k = (vmax * Math.min(1, d / Math.max(1e-6, slowR))) / d;
  out.x = dx * k;
  out.y = dy * k;
  return out;
}

/** Desired velocity straight at (tx, ty) at full speed. */
export function seek(out: Vec2, px: number, py: number, tx: number, ty: number, vmax: number): Vec2 {
  const dx = tx - px;
  const dy = ty - py;
  const d = hyp(dx, dy);
  if (!(d > 1e-6)) {
    out.x = 0;
    out.y = 0;
    return out;
  }
  out.x = (dx / d) * vmax;
  out.y = (dy / d) * vmax;
  return out;
}

/** Wander carrot: a point ahead of the head, displaced on a circle by the jitter angle. */
export function wanderCarrot(out: Vec2, px: number, py: number, dirX: number, dirY: number, theta: number, S: number): Vec2 {
  out.x = px + dirX * T.carrotAhead * S + Math.cos(theta) * T.carrotRadius * S;
  out.y = py + dirY * T.carrotAhead * S + Math.sin(theta) * T.carrotRadius * S;
  return out;
}

/** Sideways serpentine offset added to a carrot (normal = perp of the heading). */
export function serpentine(out: Vec2, dirX: number, dirY: number, S: number, t: number, mul: number): Vec2 {
  const a = T.serpentine * S * Math.sin(2 * Math.PI * T.serpentineHz * t) * mul;
  out.x += dirY * a;
  out.y += -dirX * a;
  return out;
}

/** Adds an inward push for each side of the safe rect the point has penetrated. */
export function boundsPush(out: Vec2, px: number, py: number, x0: number, y0: number, x1: number, y1: number, m: number, vmax: number): Vec2 {
  const k = vmax / Math.max(1e-6, m);
  if (px < x0 + m) out.x += (x0 + m - px) * k;
  if (px > x1 - m) out.x -= (px - (x1 - m)) * k;
  if (py < y0 + m) out.y += (y0 + m - py) * k;
  if (py > y1 - m) out.y -= (py - (y1 - m)) * k;
  return out;
}

/** Adds a push away from the cursor inside 0.2·S. */
export function avoidCursor(out: Vec2, px: number, py: number, cx: number, cy: number, S: number, vmax: number): Vec2 {
  const R = T.avoidRadius * S;
  const dx = px - cx;
  const dy = py - cy;
  const dc = hyp(dx, dy);
  if (dc >= R || !(dc > 1e-6)) return out;
  const k = (vmax * 0.8 * (1 - dc / R)) / dc;
  out.x += dx * k;
  out.y += dy * k;
  return out;
}

/** Clamps a vector's length in place. */
export function clampLen(v: Vec2, max: number): Vec2 {
  const l = hyp(v.x, v.y);
  if (l > max && l > 0) {
    v.x *= max / l;
    v.y *= max / l;
  }
  return v;
}

const steer: Vec2 = { x: 0, y: 0 };

/**
 * One substep: accelerate toward `desired` (limited by amax), limit the turn to
 * ω·h while moving faster than 20 px/s, cap the speed, then move.
 */
export function integrate(a: ZmeuAgent, desired: Vec2, lim: SteerLimits, h: number): void {
  steer.x = desired.x - a.vx;
  steer.y = desired.y - a.vy;
  clampLen(steer, lim.amax * h);
  let nx = a.vx + steer.x;
  let ny = a.vy + steer.y;
  const s0 = hyp(a.vx, a.vy);
  if (s0 > 20) {
    const s1 = hyp(nx, ny);
    if (s1 > 1e-6) {
      const c = (a.vx * nx + a.vy * ny) / (s0 * s1);
      const maxTurn = lim.omega * h;
      if (c < Math.cos(maxTurn)) {
        const cross = a.vx * ny - a.vy * nx;
        const ang = cross >= 0 ? maxTurn : -maxTurn;
        const cs = Math.cos(ang);
        const sn = Math.sin(ang);
        const ux = a.vx / s0;
        const uy = a.vy / s0;
        nx = (ux * cs - uy * sn) * s1;
        ny = (ux * sn + uy * cs) * s1;
      }
    }
  }
  const s2 = hyp(nx, ny);
  if (s2 > lim.vmax && s2 > 0) {
    nx *= lim.vmax / s2;
    ny *= lim.vmax / s2;
  }
  a.vx = nx;
  a.vy = ny;
  a.x += nx * h;
  a.y += ny * h;
}
