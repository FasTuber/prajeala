/**
 * Fixed-capacity queue of splats consumed by FireSimulation.step(). Values are
 * already in simulation units: uv position (y up), radius and velocities in
 * screen heights (per second). No allocation after construction.
 */

export const MAX_SPLATS_PER_PASS = 32;
export const SPLAT_QUEUE_CAPACITY = 480;

export class SplatQueue {
  /** x, y, radius, radial impulse */
  readonly a = new Float32Array(SPLAT_QUEUE_CAPACITY * 4);
  /** heat, smoke, vx, vy */
  readonly b = new Float32Array(SPLAT_QUEUE_CAPACITY * 4);
  count = 0;
  /** Splats dropped since the last clear() because the queue was full. */
  dropped = 0;

  push(x: number, y: number, radius: number, radial: number, heat: number, smoke: number, vx: number, vy: number): void {
    if (this.count >= SPLAT_QUEUE_CAPACITY) {
      this.dropped++;
      return;
    }
    if (!(radius > 0)) return;
    const i = this.count * 4;
    this.a[i] = x;
    this.a[i + 1] = y;
    this.a[i + 2] = radius;
    this.a[i + 3] = radial;
    this.b[i] = heat;
    this.b[i + 1] = smoke;
    this.b[i + 2] = vx;
    this.b[i + 3] = vy;
    this.count++;
  }

  clear(): void {
    this.count = 0;
    this.dropped = 0;
  }
}
