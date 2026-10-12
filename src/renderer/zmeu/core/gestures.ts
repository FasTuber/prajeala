/**
 * Pointer gestures, read from a ring of the last 24 cursor samples: petting
 * (a wiggle over the body), resting, closing speed and click classification.
 * Pure and allocation-free; times are seconds in the caller's clock.
 */
import { radiusAt } from './spine';
import { ZMEU_JOINTS, ZMEU_TUNING as T } from './tuning';
import { hyp } from './vec';

export const CURSOR_RING_SIZE = 24;
/**
 * Minimum spacing between slots (s). Cursor events arrive at ~120 Hz, so 24
 * raw samples would cover only 0.2 s; decimating to 30 Hz makes the ring span
 * the 0.6–1.2 s windows the gestures need. Closer samples update the latest slot.
 */
export const CURSOR_RING_DT = 1 / 30;

export class CursorRing {
  readonly x = new Float64Array(CURSOR_RING_SIZE);
  readonly y = new Float64Array(CURSOR_RING_SIZE);
  readonly t = new Float64Array(CURSOR_RING_SIZE);
  count = 0;
  private head = 0;
  private openedAt = -Infinity;

  push(x: number, y: number, t: number): void {
    if (this.count > 0 && t >= this.openedAt && t - this.openedAt < CURSOR_RING_DT) {
      const k = this.slot(0);
      this.x[k] = x;
      this.y[k] = y;
      this.t[k] = t;
      return;
    }
    this.openedAt = t;
    this.x[this.head] = x;
    this.y[this.head] = y;
    this.t[this.head] = t;
    this.head = (this.head + 1) % CURSOR_RING_SIZE;
    if (this.count < CURSOR_RING_SIZE) this.count++;
  }

  clear(): void {
    this.count = 0;
    this.head = 0;
    this.openedAt = -Infinity;
  }

  /** Slot of the k-th most recent sample (0 = latest). */
  slot(k: number): number {
    return (this.head - 1 - k + CURSOR_RING_SIZE * 2) % CURSOR_RING_SIZE;
  }

  /** Time of the latest sample, or −Infinity. */
  latestT(): number {
    return this.count > 0 ? this.t[this.slot(0)]! : -Infinity;
  }
}

/** What hit tests need of the body: joints (display spine), R, L and the head direction. */
export interface ZmeuBodyShape {
  readonly bodyX: ArrayLike<number>;
  readonly bodyY: ArrayLike<number>;
  /** Base radius R and length L, CSS px. */
  readonly R: number;
  readonly L: number;
  readonly dirX: number;
  readonly dirY: number;
}

/** Joint radii in units of R. */
const JOINT_R = new Float64Array(ZMEU_JOINTS);
for (let i = 0; i < ZMEU_JOINTS; i++) JOINT_R[i] = radiusAt(i / (ZMEU_JOINTS - 1), 1);

/** Signed distance from (x, y) to the body: min over joints of (d − r_i), and to the head bulb. */
export function bodyDistance(b: ZmeuBodyShape, x: number, y: number): number {
  let best = Infinity;
  const n = ZMEU_JOINTS;
  const R = b.R;
  for (let i = 0; i < n; i++) {
    const dx = x - b.bodyX[i]!;
    const dy = y - b.bodyY[i]!;
    const d = Math.sqrt(dx * dx + dy * dy) - JOINT_R[i]! * R;
    if (d < best) best = d;
  }
  const hd = T.headFrac * b.L;
  const hx = b.bodyX[0]! + b.dirX * 0.3 * hd;
  const hy = b.bodyY[0]! + b.dirY * 0.3 * hd;
  const dh = hyp(x - hx, y - hy) - 0.45 * hd;
  return dh < best ? dh : best;
}

export function hitsBody(b: ZmeuBodyShape, x: number, y: number, pad: number): boolean {
  return bodyDistance(b, x, y) < pad;
}

/** Counts direction reversals (moves larger than `minStep` px) on one axis over samples newer than `t0`. */
function reversals(ring: CursorRing, axis: Float64Array, t0: number, minStep: number): number {
  let count = 0;
  let lastSign = 0;
  let acc = 0;
  for (let k = ring.count - 1; k >= 1; k--) {
    const a = ring.slot(k);
    const b = ring.slot(k - 1);
    if (ring.t[b]! < t0) continue;
    acc += axis[b]! - axis[a]!;
    if (Math.abs(acc) > minStep) {
      const sg = acc > 0 ? 1 : -1;
      if (lastSign !== 0 && sg !== lastSign) count++;
      lastSign = sg;
      acc = 0;
    }
  }
  return count;
}

/**
 * Petting: over the last 0.6 s the cursor was on the body (pad 0.1·L) for at
 * least 0.35 s, it reversed direction ≥ 3 times (|Δ| > 6 px) on x or y within
 * 1.2 s, and its mean speed is within 60–1400 px/s.
 */
export function isPetting(ring: CursorRing, now: number, b: ZmeuBodyShape): boolean {
  if (ring.count < 4) return false;
  const latest = ring.latestT();
  if (now - latest > 0.25) return false;
  // Cheap tests first: reversals, then the mean speed, then time on the body.
  const t1 = now - 1.2;
  if (reversals(ring, ring.x, t1, 6) < 3 && reversals(ring, ring.y, t1, 6) < 3) return false;
  const t0 = now - 0.6;
  let path = 0;
  let span = 0;
  for (let k = ring.count - 1; k >= 1; k--) {
    const a = ring.slot(k);
    const ta = ring.t[a]!;
    if (ta < t0) continue;
    const bb = ring.slot(k - 1);
    const dx = ring.x[bb]! - ring.x[a]!;
    const dy = ring.y[bb]! - ring.y[a]!;
    path += Math.sqrt(dx * dx + dy * dy);
    span += ring.t[bb]! - ta;
  }
  const mean = span > 0 ? path / span : 0;
  if (mean < 60 || mean > 1400) return false;
  const pad = T.petPad * b.L;
  let onBody = 0;
  for (let k = ring.count - 1; k >= 0; k--) {
    const a = ring.slot(k);
    const ta = ring.t[a]!;
    const tb = k > 0 ? ring.t[ring.slot(k - 1)]! : now;
    if (tb <= t0) continue;
    const dt = tb - Math.max(ta, t0);
    if (dt > 0 && hitsBody(b, ring.x[a]!, ring.y[a]!, pad)) onBody += dt;
  }
  return onBody >= 0.35;
}

/** The pointer has stayed within `maxSpeed·dur` px of its latest position for at least `dur` seconds. */
export function isResting(ring: CursorRing, now: number, dur = T.restS, maxSpeed = T.restSpeed): boolean {
  if (ring.count === 0) return false;
  const l = ring.slot(0);
  const lx = ring.x[l]!;
  const ly = ring.y[l]!;
  const tol = Math.max(T.restPad, maxSpeed * dur);
  let since = ring.t[l]!;
  for (let k = 1; k < ring.count; k++) {
    const s = ring.slot(k);
    if (hyp(ring.x[s]! - lx, ring.y[s]! - ly) > tol) break;
    since = ring.t[s]!;
  }
  // Without older samples the pointer has been still at least since its latest event.
  return now - since >= dur;
}

/** Speed (px/s) at which the cursor approaches the head; negative when moving away. */
export function closingSpeed(hx: number, hy: number, cx: number, cy: number, cvx: number, cvy: number): number {
  const dx = hx - cx;
  const dy = hy - cy;
  const d = hyp(dx, dy);
  if (!(d > 1e-6)) return hyp(cvx, cvy);
  return (cvx * dx + cvy * dy) / d;
}

export type ZmeuClick = 'poke' | 'notice' | 'drag' | 'none';

/**
 * A finished down/up sequence: moved more than 6 px → drag (never a poke);
 * down on the body → poke; within 0.6·L of it → notice (a glance).
 */
export function classifyClick(hit: boolean, dist: number, moved: number, L: number): ZmeuClick {
  if (moved > T.dragPx) return 'drag';
  if (hit) return 'poke';
  if (dist < T.noticeRange * L) return 'notice';
  return 'none';
}
