/**
 * CPU spark particles in structure-of-arrays Float32Array pools. No per-frame
 * allocation: dead particles are swapped out with the last live one.
 * Positions are in canvas CSS pixels (y down).
 */
import { Random } from '../util/math';

export const SPARK_CAPACITY = 1200;

const GRAVITY = 420; // px/s² downward
const UPDRAFT = 170; // px/s² upward (hot air)
const DRAG = 1.1; // per second
const TURBULENCE = 260; // px/s² lateral

export class Sparks {
  readonly capacity: number;
  count = 0;
  /** Live particle budget; particles above it are culled on update(). */
  budget: number;

  private readonly x: Float32Array;
  private readonly y: Float32Array;
  private readonly px: Float32Array;
  private readonly py: Float32Array;
  private readonly vx: Float32Array;
  private readonly vy: Float32Array;
  private readonly life: Float32Array;
  private readonly maxLife: Float32Array;
  private readonly phase: Float32Array;
  private readonly rng = new Random(0xc0ffee);

  constructor(capacity = SPARK_CAPACITY) {
    this.capacity = capacity;
    this.budget = capacity;
    this.x = new Float32Array(capacity);
    this.y = new Float32Array(capacity);
    this.px = new Float32Array(capacity);
    this.py = new Float32Array(capacity);
    this.vx = new Float32Array(capacity);
    this.vy = new Float32Array(capacity);
    this.life = new Float32Array(capacity);
    this.maxLife = new Float32Array(capacity);
    this.phase = new Float32Array(capacity);
  }

  get random(): Random {
    return this.rng;
  }

  /** Spawns one spark. Returns false when the budget is exhausted. */
  emit(x: number, y: number, vx: number, vy: number, lifetime: number): boolean {
    const limit = Math.min(this.capacity, this.budget);
    if (this.count >= limit) return false;
    const i = this.count++;
    this.x[i] = x;
    this.y[i] = y;
    this.px[i] = x;
    this.py[i] = y;
    this.vx[i] = vx;
    this.vy[i] = vy;
    this.life[i] = lifetime;
    this.maxLife[i] = lifetime;
    this.phase[i] = this.rng.next() * 6.283;
    return true;
  }

  /** Radial burst of `n` sparks. */
  burst(x: number, y: number, n: number, speedMin: number, speedMax: number, upwardBias = 0.4): void {
    for (let k = 0; k < n; k++) {
      const ang = this.rng.next() * Math.PI * 2;
      const sp = this.rng.range(speedMin, speedMax);
      const vx = Math.cos(ang) * sp;
      const vy = Math.sin(ang) * sp - sp * upwardBias;
      if (!this.emit(x, y, vx, vy, this.rng.range(0.5, 1.4))) break;
    }
  }

  /** Sparks shed by a moving emitter (cursor): inherit part of its velocity. */
  shed(x: number, y: number, vx: number, vy: number, n: number, spread: number): void {
    for (let k = 0; k < n; k++) {
      const ang = this.rng.next() * Math.PI * 2;
      const sp = this.rng.range(0.2, 1) * spread;
      if (
        !this.emit(
          x + this.rng.range(-4, 4),
          y + this.rng.range(-4, 4),
          vx * 0.35 + Math.cos(ang) * sp,
          vy * 0.35 + Math.sin(ang) * sp - spread * 0.5,
          this.rng.range(0.35, 1.1),
        )
      ) {
        break;
      }
    }
  }

  clear(): void {
    this.count = 0;
  }

  update(dt: number, width: number, height: number, time: number): void {
    if (this.count > this.budget) this.count = Math.max(0, this.budget);
    const drag = Math.max(0, 1 - DRAG * dt);
    const x = this.x;
    const y = this.y;
    const vx = this.vx;
    const vy = this.vy;
    const life = this.life;
    const phase = this.phase;
    const margin = 40;
    let i = 0;
    while (i < this.count) {
      const l = (life[i] ?? 0) - dt;
      const nx = x[i] ?? 0;
      const ny = y[i] ?? 0;
      if (l <= 0 || nx < -margin || nx > width + margin || ny > height + margin || ny < -margin * 4) {
        this.kill(i);
        continue;
      }
      life[i] = l;
      this.px[i] = nx;
      this.py[i] = ny;
      const ph = phase[i] ?? 0;
      const turb = Math.sin(time * 9 + ph) * Math.cos(time * 3.1 + ph * 1.7);
      const cvx = (vx[i] ?? 0) * drag + turb * TURBULENCE * dt;
      const cvy = (vy[i] ?? 0) * drag + (GRAVITY - UPDRAFT) * dt;
      vx[i] = cvx;
      vy[i] = cvy;
      x[i] = nx + cvx * dt;
      y[i] = ny + cvy * dt;
      i++;
    }
  }

  private kill(i: number): void {
    const last = this.count - 1;
    if (i !== last) {
      this.x[i] = this.x[last] ?? 0;
      this.y[i] = this.y[last] ?? 0;
      this.px[i] = this.px[last] ?? 0;
      this.py[i] = this.py[last] ?? 0;
      this.vx[i] = this.vx[last] ?? 0;
      this.vy[i] = this.vy[last] ?? 0;
      this.life[i] = this.life[last] ?? 0;
      this.maxLife[i] = this.maxLife[last] ?? 0;
      this.phase[i] = this.phase[last] ?? 0;
    }
    this.count = last;
  }

  /**
   * Writes [tailX, tailY, life, 0, headX, headY, life, 1] per particle into `out`.
   * Returns the number of floats written.
   */
  writeVertices(out: Float32Array): number {
    const n = Math.min(this.count, Math.floor(out.length / 8));
    let o = 0;
    for (let i = 0; i < n; i++) {
      const ml = this.maxLife[i] ?? 1;
      const l = (this.life[i] ?? 0) / (ml > 0 ? ml : 1);
      const hx = this.x[i] ?? 0;
      const hy = this.y[i] ?? 0;
      // Tail: extend backwards along the velocity for a visible streak.
      const tx = hx - (this.vx[i] ?? 0) * 0.045;
      const ty = hy - (this.vy[i] ?? 0) * 0.045;
      out[o++] = tx;
      out[o++] = ty;
      out[o++] = l;
      out[o++] = 0;
      out[o++] = hx;
      out[o++] = hy;
      out[o++] = l;
      out[o++] = 1;
    }
    return o;
  }
}
