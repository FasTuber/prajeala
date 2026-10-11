/**
 * Typing fire: every keystroke throws a few sparks and a small puff of heat
 * at the cursor (or, when the mouse is away, at the focused window's bottom
 * edge / the screen bottom). Fast typing builds a "combo" that makes the
 * puffs bigger and hotter; Enter is a small burst, Backspace a cold, smoky
 * puff. Keys are queued and spent on the next update so bursts of events
 * cost one splat pass.
 */
import type { KeyKind, Rect } from '../../shared/ipc';
import type { CursorState } from '../input/CursorState';
import { clamp01 } from '../util/math';
import type { Emitter, EmitterContext } from './EmitterContext';

const MAX_QUEUED = 24;
/** Combo grows per key and decays with this half-life-ish rate (per second). */
const COMBO_PER_KEY = 0.18;
const COMBO_DECAY = 1.4;

export interface KeyAnchor {
  /** Rectangle of the focused window in CSS px, when known and visible. */
  windowRect: Rect | null;
}

export class KeyEmitter implements Emitter {
  readonly name = 'keys';
  active = false;
  /** Total keys consumed (HUD). */
  total = 0;
  /** 0..1 typing-speed heat. */
  combo = 0;
  private readonly queue: KeyKind[] = [];
  private readonly anchor: KeyAnchor = { windowRect: null };

  constructor(private readonly cursor: CursorState) {}

  /** Where to emit when the cursor is outside the display. */
  setWindowRect(rect: Rect | null): void {
    this.anchor.windowRect = rect;
  }

  push(kind: KeyKind): void {
    if (kind === 'modifier') return; // Shift/Ctrl alone do nothing
    if (this.queue.length >= MAX_QUEUED) this.queue.shift();
    this.queue.push(kind);
  }

  update(ctx: EmitterContext): void {
    this.active = false;
    this.combo = Math.max(0, this.combo - COMBO_DECAY * ctx.dt * (0.5 + this.combo));
    if (!ctx.settings.typingFire) {
      this.queue.length = 0;
      return;
    }
    if (this.queue.length === 0) return;
    const { x, y } = this.origin(ctx);
    const rng = ctx.sparks.random;
    const r = ctx.radius;
    const preset = ctx.preset;
    let n = 0;
    while (this.queue.length > 0 && n < 8) {
      const kind = this.queue.shift()!;
      n++;
      this.total++;
      this.combo = clamp01(this.combo + COMBO_PER_KEY);
      const k = 0.6 + this.combo * 0.9; // 0.6 … 1.5
      const jx = rng.range(-r * 0.6, r * 0.6);
      const jy = rng.range(-r * 0.2, r * 0.2);
      switch (kind) {
        case 'enter':
          ctx.splat(x + jx, y + jy, r * 2.2 * k, preset.heat * 0.9 * k, 0.1, 0, ctx.lift(0.25 * k), ctx.height * 0.06 * k);
          if (ctx.settings.sparks) ctx.sparks.burst(x + jx, y + jy, Math.round(14 * k), 120, 360 * k, 0.5);
          break;
        case 'backspace':
          // A cool, smoky puff: mostly smoke, a little dark heat.
          ctx.splat(x + jx, y + jy, r * 1.4, preset.heat * 0.12, 0.35, 0, ctx.lift(0.12));
          if (ctx.settings.sparks) ctx.sparks.burst(x + jx, y + jy, 2, 40, 90, 0.2);
          break;
        case 'space':
          ctx.splat(x + jx, y + jy, r * 1.6 * k, preset.heat * 0.45 * k, 0.06, 0, ctx.lift(0.35 * k));
          if (ctx.settings.sparks) ctx.sparks.burst(x + jx, y + jy, Math.round(7 * k), 90, 260 * k, 0.6);
          break;
        case 'navigation':
          ctx.splat(x + jx, y + jy, r * 0.9, preset.heat * 0.2, 0.03, rng.range(-1, 1) * ctx.height * 0.3, ctx.lift(0.1));
          if (ctx.settings.sparks) ctx.sparks.burst(x + jx, y + jy, 3, 80, 200, 0.3);
          break;
        case 'other':
          ctx.splat(x + jx, y + jy, r * 0.9, preset.heat * 0.15, 0.03, 0, ctx.lift(0.15));
          break;
        default: // 'char'
          ctx.splat(x + jx, y + jy, r * (1.0 + 0.4 * this.combo), preset.heat * 0.35 * k, 0.04, 0, ctx.lift(0.3 * k));
          if (ctx.settings.sparks) ctx.sparks.burst(x + jx, y + jy, Math.round(4 + 5 * this.combo), 70, 220 * k, 0.65);
          break;
      }
    }
    this.active = n > 0;
  }

  /** Cursor when it is on this display, else the focused window's bottom edge, else the screen bottom. */
  private origin(ctx: EmitterContext): { x: number; y: number } {
    const c = this.cursor;
    if (c.hasPosition && c.inside) return { x: c.x, y: c.y };
    const w = this.anchor.windowRect;
    if (w && w.width > 0 && ctx.inView(w.x + w.width / 2, w.y + w.height, ctx.radius * 4)) {
      return { x: w.x + w.width / 2, y: w.y + w.height - ctx.radius * 0.5 };
    }
    return { x: ctx.width / 2, y: ctx.height - ctx.radius };
  }
}
