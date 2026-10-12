/**
 * The dragon's 24-joint physics spine: follow-the-leader from the head, bend
 * limits, pose blending with length restore, and the roll chain that makes a
 * facing flip ripple from head to tail. Joint 0 is the head, 23 the tail tip.
 */
import { damp } from '../../util/math';
import { ZMEU_JOINTS, ZMEU_TUNING as T } from './tuning';
import { hyp } from './vec';

const RU = T.radiusU;
const RR = T.radiusR;
const COS_NECK = Math.cos(T.bendNeck);
const SIN_NECK = Math.sin(T.bendNeck);
const COS_TAIL = Math.cos(T.bendTail);
const SIN_TAIL = Math.sin(T.bendTail);

/** Body radius at u (0 = neck, 1 = tail tip): smoothstep between the profile stops. */
export function radiusAt(u: number, R: number): number {
  const x = u < 0 ? 0 : u > 1 ? 1 : u;
  for (let i = 1; i < RU.length; i++) {
    const u1 = RU[i]!;
    if (x <= u1) {
      const u0 = RU[i - 1]!;
      const t = (x - u0) / (u1 - u0);
      const s = t * t * (3 - 2 * t);
      return (RR[i - 1]! + (RR[i]! - RR[i - 1]!) * s) * R;
    }
  }
  return RR[RR.length - 1]! * R;
}

/** Bend limit (rad) at joint i. */
export function bendLimitAt(i: number): number {
  return i <= 6 ? T.bendNeck : T.bendTail;
}

export class Spine {
  readonly n = ZMEU_JOINTS;
  readonly x = new Float64Array(ZMEU_JOINTS);
  readonly y = new Float64Array(ZMEU_JOINTS);
  readonly roll = new Float32Array(ZMEU_JOINTS);
  seg = 10;
  /** Last good tangent (tail-ward), reused for degenerate segments. */
  private tdx = -1;
  private tdy = 0;

  constructor() {
    this.roll.fill(1);
  }

  /** Lays the spine out straight, head at (cx, cy), tail opposite (dx, dy). */
  reset(cx: number, cy: number, dx: number, dy: number, seg: number): void {
    let l = hyp(dx, dy);
    if (!(l > 1e-9)) {
      dx = 1;
      dy = 0;
      l = 1;
    }
    const ux = dx / l;
    const uy = dy / l;
    this.seg = seg;
    for (let i = 0; i < this.n; i++) {
      this.x[i] = cx - ux * seg * i;
      this.y[i] = cy - uy * seg * i;
    }
    this.tdx = -ux;
    this.tdy = -uy;
  }

  translate(dx: number, dy: number): void {
    for (let i = 0; i < this.n; i++) {
      this.x[i] = this.x[i]! + dx;
      this.y[i] = this.y[i]! + dy;
    }
  }

  scale(sx: number, sy: number): void {
    for (let i = 0; i < this.n; i++) {
      this.x[i] = this.x[i]! * sx;
      this.y[i] = this.y[i]! * sy;
    }
  }

  /** Follow-the-leader: the head goes to (hx, hy), each joint is dragged to `seg` behind its leader. */
  follow(hx: number, hy: number, seg: number): void {
    this.seg = seg;
    this.x[0] = hx;
    this.y[0] = hy;
    this.restoreFrom(1);
  }

  /** Keeps every bend within its limit, walking from the head. */
  bendLimit(): void {
    const x = this.x;
    const y = this.y;
    for (let i = 1; i < this.n - 1; i++) {
      const ax = x[i]! - x[i - 1]!;
      const ay = y[i]! - y[i - 1]!;
      const bx = x[i + 1]! - x[i]!;
      const by = y[i + 1]! - y[i]!;
      const la = Math.sqrt(ax * ax + ay * ay);
      const lb = Math.sqrt(bx * bx + by * by);
      if (!(la > 1e-9) || !(lb > 1e-9)) continue;
      const cl = i <= 6 ? COS_NECK : COS_TAIL;
      const c = (ax * bx + ay * by) / (la * lb);
      if (c >= cl) continue;
      const sgn = ax * by - ay * bx >= 0 ? 1 : -1;
      const sl = (i <= 6 ? SIN_NECK : SIN_TAIL) * sgn;
      const ux = ax / la;
      const uy = ay / la;
      const nx = (ux * cl - uy * sl) * lb;
      const ny = (ux * sl + uy * cl) * lb;
      const ox = x[i]! + nx - x[i + 1]!;
      const oy = y[i]! + ny - y[i + 1]!;
      // Move the rest of the tail rigidly with the corrected joint.
      for (let j = i + 1; j < this.n; j++) {
        x[j] = x[j]! + ox;
        y[j] = y[j]! + oy;
      }
    }
  }

  /** Pulls every joint toward its pose target: P += (T − P)·(1 − e^(−k·h))·w. */
  blendToward(tx: ArrayLike<number>, ty: ArrayLike<number>, k: number, w: number, h: number): void {
    const a = damp(k, h) * (w < 0 ? 0 : w > 1 ? 1 : w);
    if (a <= 0) return;
    for (let i = 0; i < this.n; i++) {
      this.x[i] = this.x[i]! + (tx[i]! - this.x[i]!) * a;
      this.y[i] = this.y[i]! + (ty[i]! - this.y[i]!) * a;
    }
  }

  /** Re-imposes the segment length, walking from the head (exact, so one pass suffices). */
  restoreLengths(passes: number): void {
    for (let p = 0; p < passes; p++) this.restoreFrom(1);
  }

  /** roll_0 → facing at 6/s; roll_i → roll_{i−1} at 18/s, so a flip ripples tailward. */
  updateRoll(facing: number, h: number): void {
    const r = this.roll;
    r[0] = r[0]! + (facing - r[0]!) * damp(6, h);
    const k = damp(18, h);
    for (let i = 1; i < this.n; i++) r[i] = r[i]! + (r[i - 1]! - r[i]!) * k;
  }

  /** Largest relative segment-length error. */
  lengthError(): number {
    let e = 0;
    for (let i = 1; i < this.n; i++) {
      const l = hyp(this.x[i]! - this.x[i - 1]!, this.y[i]! - this.y[i - 1]!);
      e = Math.max(e, Math.abs(l - this.seg) / this.seg);
    }
    return e;
  }

  /** Bend angle (rad) at joint i (1..n−2). */
  bendAt(i: number): number {
    const ax = this.x[i]! - this.x[i - 1]!;
    const ay = this.y[i]! - this.y[i - 1]!;
    const bx = this.x[i + 1]! - this.x[i]!;
    const by = this.y[i + 1]! - this.y[i]!;
    return Math.abs(Math.atan2(ax * by - ay * bx, ax * bx + ay * by));
  }

  /** Worst bend relative to its limit (rad); ≤ 0 when every joint is within its limit. */
  maxBend(): number {
    let m = -Infinity;
    for (let i = 1; i < this.n - 1; i++) m = Math.max(m, this.bendAt(i) - bendLimitAt(i));
    return m;
  }

  /** Cheap finiteness probe: NaN/∞ anywhere propagates tailward through follow/restore/roll. */
  tailFinite(): boolean {
    const k = this.n - 1;
    return Number.isFinite(this.x[0]! + this.y[0]! + this.x[k]! + this.y[k]! + this.roll[k]!);
  }

  /** True when every coordinate is finite. */
  finite(): boolean {
    for (let i = 0; i < this.n; i++) {
      if (!Number.isFinite(this.x[i]!) || !Number.isFinite(this.y[i]!) || !Number.isFinite(this.roll[i]!)) return false;
    }
    return true;
  }

  private restoreFrom(start: number): void {
    const x = this.x;
    const y = this.y;
    const seg = this.seg;
    let tdx = this.tdx;
    let tdy = this.tdy;
    for (let i = start; i < this.n; i++) {
      const dx = x[i]! - x[i - 1]!;
      const dy = y[i]! - y[i - 1]!;
      const l = Math.sqrt(dx * dx + dy * dy);
      if (l > 1e-6) {
        tdx = dx / l;
        tdy = dy / l;
      }
      x[i] = x[i - 1]! + tdx * seg;
      y[i] = y[i - 1]! + tdy * seg;
      if (i === 1) {
        this.tdx = tdx;
        this.tdy = tdy;
      }
    }
  }
}
