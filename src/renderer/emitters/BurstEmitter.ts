/**
 * Click bursts: a short-lived radial heat splat plus an outward velocity
 * impulse, and a spray of sparks. Also serves `onTestBurst`.
 */
import type { PointerButton } from '../../shared/ipc';
import type { Emitter, EmitterContext } from './EmitterContext';

const MAX_BURSTS = 16;
const DURATION = 0.2;

export class BurstEmitter implements Emitter {
  readonly name = 'burst';
  active = false;
  private readonly x = new Float32Array(MAX_BURSTS);
  private readonly y = new Float32Array(MAX_BURSTS);
  private readonly strength = new Float32Array(MAX_BURSTS);
  private readonly scale = new Float32Array(MAX_BURSTS);
  private readonly age = new Float32Array(MAX_BURSTS);
  private count = 0;
  /** Total bursts triggered (for the HUD). */
  total = 0;

  constructor(private readonly ctx: EmitterContext) {}

  trigger(x: number, y: number, strength: number, button: PointerButton = 'left'): void {
    const ctx = this.ctx;
    const scale = button === 'left' ? 1 : button === 'right' ? 0.82 : 0.68;
    if (this.count >= MAX_BURSTS) this.count = MAX_BURSTS - 1; // drop the oldest slot
    const i = this.count++;
    this.x[i] = x;
    this.y[i] = y;
    this.strength[i] = strength;
    this.scale[i] = scale;
    this.age[i] = 0;
    this.total++;
    if (ctx.settings.sparks) {
      const n = Math.round(18 * strength * scale);
      ctx.sparks.burst(x, y, n, 180 * scale, 520 * scale * Math.sqrt(strength), 0.35);
    }
  }

  update(ctx: EmitterContext): void {
    this.active = false;
    let i = 0;
    while (i < this.count) {
      const age = this.age[i] ?? 0;
      if (age >= DURATION) {
        this.remove(i);
        continue;
      }
      const k = 1 - age / DURATION;
      const s = this.strength[i] ?? 1;
      const sc = this.scale[i] ?? 1;
      const x = this.x[i] ?? 0;
      const y = this.y[i] ?? 0;
      const r = ctx.radius * sc * (2.4 + age * 10);
      const frame = 60 * ctx.dt; // impulses are spread over ~12 frames at 60 fps
      const heat = s * 0.5 * k * k * frame * 0.35;
      const radial = ctx.height * s * 0.12 * k * sc * frame;
      ctx.splat(x, y, r, heat, heat * 0.25, 0, ctx.lift(0.05 * s * frame), radial);
      // hot core
      ctx.splat(x, y, r * 0.45, heat * 1.4, 0, 0, 0, 0);
      this.age[i] = age + ctx.dt;
      this.active = true;
      i++;
    }
  }

  private remove(i: number): void {
    const last = this.count - 1;
    if (i !== last) {
      this.x[i] = this.x[last] ?? 0;
      this.y[i] = this.y[last] ?? 0;
      this.strength[i] = this.strength[last] ?? 0;
      this.scale[i] = this.scale[last] ?? 1;
      this.age[i] = this.age[last] ?? 0;
    }
    this.count = last;
  }
}
