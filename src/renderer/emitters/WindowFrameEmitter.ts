/**
 * Burns the frame of the focused application window: flames rising from the
 * top edge, weaker licks up the sides, embers along the bottom. Bounds are
 * interpolated when the window moves/resizes and faded out when it goes away.
 */
import type { ActiveWindowEvent, Rect } from '../../shared/ipc';
import { damp, lerp } from '../util/math';
import { flicker } from '../util/noise';
import type { Emitter, EmitterContext } from './EmitterContext';

const MAX_TOP = 48;
const MAX_SIDE = 14;
const MAX_BOTTOM = 24;

export class WindowFrameEmitter implements Emitter {
  readonly name = 'window';
  active = false;
  /** Current (smoothed) rectangle. */
  readonly rect: Rect = { x: 0, y: 0, width: 0, height: 0 };
  private target: Rect | null = null;
  private fade = 0;
  private hasRect = false;
  private emberAccumulator = 0;
  title = '';

  setTarget(e: ActiveWindowEvent | null): void {
    if (!e || e.isSelf || !e.intersects || e.bounds.width <= 0 || e.bounds.height <= 0) {
      this.target = null;
      return;
    }
    this.target = e.bounds;
    this.title = e.title;
    if (!this.hasRect) {
      Object.assign(this.rect, e.bounds);
      this.hasRect = true;
    }
  }

  get visible(): boolean {
    return this.fade > 0.01;
  }

  update(ctx: EmitterContext): void {
    this.active = false;
    const wantFade = ctx.settings.burnActiveWindow && this.target ? 1 : 0;
    this.fade = lerp(this.fade, wantFade, damp(wantFade ? 6 : 3, ctx.dt));
    if (this.target) {
      const k = damp(14, ctx.dt);
      this.rect.x = lerp(this.rect.x, this.target.x, k);
      this.rect.y = lerp(this.rect.y, this.target.y, k);
      this.rect.width = lerp(this.rect.width, this.target.width, k);
      this.rect.height = lerp(this.rect.height, this.target.height, k);
    }
    if (this.fade < 0.02 || !this.hasRect) return;

    const preset = ctx.preset;
    const r = ctx.radius;
    const t = ctx.time;
    const H = ctx.height;
    const fade = this.fade;
    const ambient = preset.ambient;
    const { x, y, width, height } = this.rect;
    const right = x + width;
    const bottom = y + height;
    const margin = r * 2.5;
    const topTemp = Math.min(1, (0.6 + ambient * 0.5) * ctx.audioBoost) * fade;

    // Top edge: the main blaze rising from the title bar.
    const topCount = Math.min(MAX_TOP, Math.max(2, Math.ceil(width / (r * 1.15))));
    const topStep = width / topCount;
    const topRadius = r * 1.3;
    for (let i = 0; i < topCount; i++) {
      const fl = flicker(t * 1.6 + i * 0.41, 100 + i);
      const px = x + (i + 0.5) * topStep + (fl - 0.5) * topStep * 0.6;
      const py = y - r * 0.1;
      if (!ctx.inView(px, py, margin)) continue;
      const ay = -H * (0.6 + 1.4 * fl);
      const ax = (flicker(t * 1.1 + i * 0.9, 200 + i) - 0.5) * H * 0.8;
      ctx.splatSource(px, py, topRadius, topTemp * (0.55 + 0.55 * fl), 0.06 * fade, ax, ay);
    }

    // Left / right edges: thinner flames licking upwards along the frame.
    const sideCount = Math.min(MAX_SIDE, Math.max(1, Math.ceil(height / (r * 2.6))));
    const sideStep = height / sideCount;
    const sideRadius = r * 0.9;
    for (let i = 0; i < sideCount; i++) {
      const py = y + (i + 0.5) * sideStep;
      for (let side = 0; side < 2; side++) {
        const fl = flicker(t * 2.1 + i * 0.63 + side * 3.3, 300 + i + side * 50);
        if (fl < 0.2) continue; // sides burn intermittently
        const px = side === 0 ? x : right;
        if (!ctx.inView(px, py, margin)) continue;
        const ax = (side === 0 ? -1 : 1) * H * 0.25;
        const ay = -H * (0.8 + 1.0 * fl);
        ctx.splatSource(px, py, sideRadius, topTemp * Math.min(1, 0.35 + fl), 0.03 * fade, ax, ay);
      }
    }

    // Bottom edge: glowing embers and the occasional spark.
    const bottomCount = Math.min(MAX_BOTTOM, Math.max(2, Math.ceil(width / (r * 2.2))));
    const bottomStep = width / bottomCount;
    const emberRadius = r * 0.7;
    for (let i = 0; i < bottomCount; i++) {
      const fl = flicker(t * 2.6 + i * 1.3, 400 + i);
      const px = x + (i + 0.5) * bottomStep;
      const py = bottom + r * 0.1;
      if (!ctx.inView(px, py, margin)) continue;
      ctx.splatSource(px, py, emberRadius, topTemp * (0.3 + 0.7 * fl), 0.02 * fade, 0, -H * 0.5);
    }
    if (ctx.settings.sparks) {
      this.emberAccumulator += 6 * fade * ctx.dt;
      const n = Math.floor(this.emberAccumulator);
      if (n > 0) {
        this.emberAccumulator -= n;
        const rng = ctx.sparks.random;
        for (let k = 0; k < n; k++) {
          const px = x + rng.next() * width;
          if (!ctx.inView(px, bottom, margin)) continue;
          ctx.sparks.emit(px, bottom, rng.range(-30, 30), rng.range(-160, -40), rng.range(0.6, 1.5));
        }
      }
    }
    this.active = true;
  }
}
