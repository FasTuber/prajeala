/**
 * "Screen on fire": a flickering strip of steady sources along the bottom edge.
 */
import { flicker } from '../util/noise';
import type { Emitter, EmitterContext } from './EmitterContext';

const MAX_EMITTERS = 64;

export class ScreenBottomEmitter implements Emitter {
  readonly name = 'bottom';
  active = false;
  private sparkAccumulator = 0;

  update(ctx: EmitterContext): void {
    this.active = false;
    if (!ctx.settings.screenBottomFire) return;
    const preset = ctx.preset;
    const r = ctx.radius;
    const t = ctx.time;
    const H = ctx.height;
    const count = Math.min(MAX_EMITTERS, Math.max(4, Math.ceil(ctx.width / (r * 1.2))));
    const step = ctx.width / count;
    const radius = r * 1.6;
    const temperature = Math.min(1, 0.65 + preset.ambient * 0.5);
    const baseY = ctx.floor + r * 0.15;
    for (let i = 0; i < count; i++) {
      const fl = flicker(t * 1.5 + i * 0.37, 500 + i);
      const slow = flicker(t * 0.35 + i * 0.11, 600 + i); // slow-moving hot spots
      const px = (i + 0.5) * step + (fl - 0.5) * step * 0.8;
      const strength = (0.6 + 0.55 * fl) * (0.7 + 0.5 * slow);
      const ay = -H * (0.6 + 1.4 * fl);
      const ax = (flicker(t * 0.9 + i * 0.5, 700 + i) - 0.5) * H * 1.0;
      ctx.splatSource(px, baseY, radius, temperature * Math.min(1, strength), 0.07 * strength, ax, ay);
    }
    if (ctx.settings.sparks) {
      this.sparkAccumulator += (ctx.width / 160) * ctx.dt;
      const n = Math.floor(this.sparkAccumulator);
      if (n > 0) {
        this.sparkAccumulator -= n;
        const rng = ctx.sparks.random;
        for (let k = 0; k < n; k++) {
          ctx.sparks.emit(rng.next() * ctx.width, ctx.floor + 2, rng.range(-40, 40), rng.range(-260, -80), rng.range(0.7, 1.6));
        }
      }
    }
    this.active = true;
  }
}
