/**
 * Cursor emitter: halo (steady ring), trail (heat along the mouse path) or
 * comet (trail + velocity injection + bright, speed-scaled head). Also sheds
 * sparks proportionally to the cursor speed.
 */
import type { CursorEvent } from '../../shared/ipc';
import type { CursorState } from '../input/CursorState';
import { clamp01, lerp } from '../util/math';
import { flicker } from '../util/noise';
import type { Emitter, EmitterContext } from './EmitterContext';

const MAX_TRAIL_SPLATS = 24;
/** Velocity impulse per unit of mouse travel: moving one screen height adds this many heights/s. */
const IMPULSE_PER_HEIGHT = 40;

export class CursorEmitter implements Emitter {
  readonly name = 'cursor';
  active = false;
  private lastX = 0;
  private lastY = 0;
  private hasLast = false;
  private sparkAccumulator = 0;

  constructor(
    private readonly cursor: CursorState,
    private readonly ctx: EmitterContext,
  ) {}

  /** Per-event: lays heat along the segment from the previous position (trail/comet). */
  onMove(e: CursorEvent): void {
    const ctx = this.ctx;
    const mode = ctx.settings.cursorMode;
    if (!ctx.settings.enabled || mode === 'off' || mode === 'halo' || !this.hasLast) {
      this.lastX = e.x;
      this.lastY = e.y;
      this.hasLast = true;
      return;
    }
    const dx = e.x - this.lastX;
    const dy = e.y - this.lastY;
    const dist = Math.hypot(dx, dy);
    const preset = ctx.preset;
    const speedK = clamp01(this.cursor.speed / 1600);
    const comet = mode === 'comet';
    const radius = ctx.radius * (comet ? lerp(1.0, 2.0, speedK) : 1.0);
    const spacing = radius * 0.4;
    if (dist < spacing * 0.35) return;
    if (dist > ctx.height * 0.6) {
      // Teleport (multi-monitor jump): do not draw a line across the screen.
      this.lastX = e.x;
      this.lastY = e.y;
      return;
    }
    const n = Math.min(MAX_TRAIL_SPLATS, Math.max(1, Math.ceil(dist / spacing)));
    const heat = preset.heat * (comet ? 0.6 : 0.55);
    const smoke = heat * 0.1;
    // Impulse proportional to the mouse delta, shared between the sub-splats.
    const impulse = ((dist / ctx.height) * IMPULSE_PER_HEIGHT * preset.velocity * (comet ? 1 : 0.2)) / n;
    const ux = dx / dist;
    const uy = dy / dist;
    const vx = ux * impulse * ctx.height;
    const vy = uy * impulse * ctx.height - ctx.height * 0.02;
    for (let i = 1; i <= n; i++) {
      const t = i / n;
      const x = this.lastX + dx * t;
      const y = this.lastY + dy * t;
      if (!ctx.inView(x, y, radius * 2)) continue;
      ctx.splat(x, y, radius, heat, smoke, vx, vy);
    }
    this.lastX = e.x;
    this.lastY = e.y;
    this.active = true;
  }

  update(ctx: EmitterContext): void {
    const mode = ctx.settings.cursorMode;
    const c = this.cursor;
    this.active = false;
    if (mode === 'off' || !c.hasPosition || !c.inside) return;
    const preset = ctx.preset;
    const r = ctx.radius;
    const t = ctx.time;
    const H = ctx.height;
    const speedK = clamp01(c.speed / 1600);
    const temp = Math.min(1, 0.6 + preset.heat * 0.4);

    if (mode === 'halo') {
      // Steady ring: a few flickering sources around the cursor, pushed upward.
      const count = 5;
      for (let i = 0; i < count; i++) {
        const ang = t * 1.4 + (i / count) * Math.PI * 2;
        const fl = flicker(t * 1.3 + i * 0.7, 40 + i);
        const ox = Math.cos(ang) * r * 0.75;
        const oy = Math.sin(ang) * r * 0.5 + r * 0.25;
        ctx.splatSource(c.x + ox, c.y + oy, r * 0.9, temp * (0.6 + 0.45 * fl), 0.05, 0, -H * (0.5 + 0.8 * fl));
      }
      this.active = true;
    } else if (mode === 'comet') {
      // Bright head that grows with speed; the fluid is dragged along with the cursor.
      const fl = flicker(t * 2.0, 7);
      const headR = r * lerp(0.9, 1.5, speedK);
      ctx.splatSource(c.x, c.y + r * 0.15, headR, temp * (0.75 + 0.35 * fl), 0.06, c.vx * 2.0, c.vy * 2.0 - H * 0.8);
      this.active = true;
    } else {
      // trail: a small idle flame so the cursor never goes fully cold.
      const fl = flicker(t * 2.0, 9);
      ctx.splatSource(c.x, c.y + r * 0.15, r * 0.8, temp * (0.6 + 0.4 * fl), 0.04, 0, -H * 0.7);
      this.active = true;
    }

    if (ctx.settings.sparks) {
      const rate = (mode === 'comet' ? 70 : 35) * speedK + (mode === 'halo' ? 4 : 2);
      this.sparkAccumulator += rate * ctx.dt;
      const n = Math.floor(this.sparkAccumulator);
      if (n > 0) {
        this.sparkAccumulator -= n;
        ctx.sparks.shed(c.x, c.y, c.vx, c.vy, n, 90 + 220 * speedK);
      }
    }
  }
}
