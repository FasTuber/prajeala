/**
 * "Termen limită": the focus timer drawn by the fire.
 *
 *   running — a glowing fuse lies along the floor; its burning tip walks from
 *             left to right as time passes and grows hotter near the end;
 *             during the last minute the burnt trail catches fire too;
 *   last 10 s — the seconds are written in flames in the middle of the screen;
 *   zero    — the whole floor erupts and the done word burns for a moment;
 *   stopped — the tip is snuffed out with a puff of smoke.
 */
import { countdownDigit, extrapolate, focusHeat, fuseProgress, FOCUS_BLAZE_MS, IDLE_FOCUS, type FocusFrame } from '../../shared/focus';
import { FireText } from '../focus/FireText';
import { flicker } from '../util/noise';
import type { BurstEmitter } from './BurstEmitter';
import type { Emitter, EmitterContext } from './EmitterContext';

const MAX_FUSE_SOURCES = 80;
const MAX_TRAIL_SOURCES = 24;
const MAX_EMBERS = 48;
const BLAZE_COLUMNS = 24;

export class FocusEmitter implements Emitter {
  readonly name = 'focus';
  active = false;
  private frame: FocusFrame = IDLE_FOCUS;
  private receivedAt = 0;
  private readonly text = new FireText(150);
  private sparkAccumulator = 0;
  /** Session ids whose start / end effects already played. */
  private blazedId = -1;
  private snuffedId = -1;
  /** Last tip position (CSS px) for the snuff-out puff. */
  private tipX = -1;

  constructor(private readonly bursts: BurstEmitter) {}

  /** True while a session is running, paused or blazing. */
  get busy(): boolean {
    return this.frame.phase !== 'idle';
  }

  set(frame: FocusFrame, nowMs: number): void {
    if (frame.id !== this.frame.id) this.tipX = -1;
    this.frame = frame;
    this.receivedAt = nowMs;
  }

  update(ctx: EmitterContext): void {
    this.active = false;
    const f = this.frame;
    const { remainingMs, blazeMs } = extrapolate(f, performance.now() - this.receivedAt);
    if (f.phase === 'running' || f.phase === 'paused') {
      this.drawFuse(ctx, remainingMs, f.durationMs, f.phase === 'paused');
      const digit = f.phase === 'running' ? countdownDigit(remainingMs) : null;
      if (digit !== null) this.drawText(ctx, String(digit), 1 - ((remainingMs / 1000) % 1 || 1), 0.36);
      this.active = true;
    } else if (f.phase === 'blaze') {
      this.drawBlaze(ctx, blazeMs, f);
      this.active = blazeMs < FOCUS_BLAZE_MS;
    } else if (f.cancelled && f.id !== this.snuffedId) {
      this.snuffedId = f.id;
      if (this.tipX >= 0) {
        const h = ctx.height;
        ctx.splat(this.tipX, ctx.floor - 4, ctx.radius * 2.2, 0, 0.55, 0, -h * 0.25, h * 0.08);
      }
    }
  }

  // ── internals ──────────────────────────────────────────────────────────

  private drawFuse(ctx: EmitterContext, remainingMs: number, durationMs: number, paused: boolean): void {
    const W = ctx.width;
    const H = ctx.height;
    const r = ctx.radius;
    const t = ctx.time;
    const y = ctx.floor - Math.max(2, r * 0.25);
    const p = fuseProgress(remainingMs, durationMs);
    const heat = paused ? 0.3 : focusHeat(remainingMs, durationMs);
    const tip = p * W;
    this.tipX = tip;

    // The unburnt fuse: a dim, slightly breathing ember line.
    const rest = W - tip;
    if (rest > 2) {
      const n = Math.min(MAX_FUSE_SOURCES, Math.max(1, Math.ceil(rest / 18)));
      const step = rest / n;
      for (let i = 0; i < n; i++) {
        const x = tip + (i + 0.5) * step;
        const glow = 0.46 + 0.08 * flicker(t * 0.6 + i * 0.21, 900 + (i % 64));
        // At least ~1.5 simulation cells wide, or the line vanishes at low quality settings.
        ctx.splatSource(x, y, Math.max(r * 0.5, 6), glow, 0, 0, 0);
      }
    }

    // The burnt part smoulders: a trail of embers that shows how far the session got.
    if (tip > 8) {
      const n = Math.min(MAX_EMBERS, Math.max(1, Math.ceil(tip / 34)));
      const step = tip / n;
      for (let i = 0; i < n; i++) {
        const fl = flicker(t * 0.45 + i * 0.37, 930 + (i % 64));
        ctx.splatSource((i + 0.5) * step, y, Math.max(r * 0.55, 6), 0.52 + 0.3 * fl * fl, 0.01, 0, -H * 0.05);
      }
    }

    // The tip: a lively flame that grows with the heat curve.
    const fl = flicker(t * 2.2, 950);
    const tipBlink = paused ? 0.55 + 0.45 * Math.sin(t * 4) : 1;
    ctx.splatSource(
      tip,
      y,
      r * (0.7 + 1.3 * heat) * (0.85 + 0.3 * fl),
      Math.min(1, (0.55 + 0.45 * heat) * tipBlink),
      0.04,
      (flicker(t * 1.3, 951) - 0.5) * H * 0.6,
      -H * (0.7 + 2.2 * heat) * tipBlink,
    );

    // The last minute: the burnt trail catches fire, more and more.
    const urgent = remainingMs < 60_000 && !paused ? 1 - remainingMs / 60_000 : 0;
    if (urgent > 0 && tip > 4) {
      const n = Math.min(MAX_TRAIL_SOURCES, Math.max(2, Math.ceil(tip / (r * 1.4))));
      const step = tip / n;
      for (let i = 0; i < n; i++) {
        const f1 = flicker(t * 1.5 + i * 0.41, 960 + i);
        const x = (i + 0.5) * step + (f1 - 0.5) * step * 0.6;
        ctx.splatSource(x, ctx.floor + r * 0.15, r * 1.4, Math.min(1, urgent * (0.5 + 0.6 * f1)), 0.06 * urgent, 0, -H * (0.5 + 1.8 * urgent * f1));
      }
    }

    // Sparks fly off the tip.
    if (ctx.settings.sparks && !paused) {
      this.sparkAccumulator += (6 + 30 * heat * heat) * ctx.dt;
      const n = Math.floor(this.sparkAccumulator);
      this.sparkAccumulator -= n;
      const rng = ctx.sparks.random;
      for (let k = 0; k < n; k++) {
        ctx.sparks.emit(tip, y, rng.range(20, 160) * (rng.next() < 0.7 ? 1 : -1), rng.range(-320, -90) * (0.6 + heat), rng.range(0.5, 1.3));
      }
    }
  }

  /**
   * Writes `text` in flames. `age` (0..1) is how far into its second the text
   * is: it flashes hot when it appears and settles.
   */
  private drawText(ctx: EmitterContext, text: string, age: number, size: number): void {
    const glyphs = this.text.get(text);
    if (glyphs.count === 0) return;
    const H = ctx.height;
    const W = ctx.width;
    const scale = Math.min(H * size, (W * 0.8) / Math.max(0.5, glyphs.aspect));
    const cx = W / 2;
    const cy = ctx.floor * 0.45;
    const hot = Math.min(1, 0.65 + 0.45 * (1 - age) * (1 - age));
    const radius = Math.max(3, glyphs.step * scale * 0.62);
    const pts = glyphs.points;
    for (let i = 0; i < glyphs.count; i++) {
      const x = cx + (pts[i * 2] ?? 0) * scale;
      const y = cy + (pts[i * 2 + 1] ?? 0) * scale;
      const fl = flicker(ctx.time * 2 + i * 0.13, 1000 + (i % 97));
      ctx.splatSource(x, y, radius, hot * (0.75 + 0.25 * fl), 0.02, 0, -H * 0.08 * fl);
    }
  }

  private drawBlaze(ctx: EmitterContext, blazeMs: number, f: FocusFrame): void {
    const W = ctx.width;
    const H = ctx.height;
    const r = ctx.radius;
    const t = ctx.time;
    const k = Math.max(0, 1 - blazeMs / FOCUS_BLAZE_MS);
    if (f.id !== this.blazedId) {
      this.blazedId = f.id;
      for (let i = 0; i < 7; i++) this.bursts.trigger(((i + 0.5) / 7) * W, ctx.floor - H * 0.06, 2.4);
      if (ctx.settings.sparks) ctx.sparks.burst(W / 2, ctx.floor - H * 0.1, 160, 300, 1100, 0.85);
    }
    if (k <= 0) return;
    const step = W / BLAZE_COLUMNS;
    for (let i = 0; i < BLAZE_COLUMNS; i++) {
      const fl = flicker(t * 1.8 + i * 0.37, 1100 + i);
      const x = (i + 0.5) * step + (fl - 0.5) * step * 0.7;
      ctx.splatSource(x, ctx.floor + r * 0.15, r * 2.1, Math.min(1, Math.sqrt(k) * (0.7 + 0.4 * fl)), 0.08 * k, 0, -H * (1.2 + 2.6 * k * fl));
    }
    if (f.doneText && blazeMs > 250 && blazeMs < FOCUS_BLAZE_MS * 0.6) this.drawText(ctx, f.doneText, Math.min(1, (blazeMs - 250) / 1500), 0.3);
  }
}
