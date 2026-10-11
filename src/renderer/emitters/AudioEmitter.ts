/**
 * Ritmul Focului: the fire plays the music.
 *   - kick  → a fireball launched from the floor (impulse splat + sparks), ≤ 8/s;
 *   - snare → a shower of sparks from the floor;
 *   - drop  → a 1.2 s eruption (bursts across the floor, extra sparks), if enabled;
 *   - EQ (Pro) → the floor becomes a wall of fire columns following 32 bands
 *     (it replaces the screen-bottom fire while active, same splat budget).
 * Loudness/bass multipliers for glow and buoyancy are exposed for App.
 */
import { AUDIO_BANDS } from '../../shared/audio-contract';
import type { AudioState } from '../audio/AudioState';
import { flicker } from '../util/noise';
import type { BurstEmitter } from './BurstEmitter';
import type { Emitter, EmitterContext } from './EmitterContext';

const MIN_KICK_GAP_S = 0.125;
const ERUPTION_S = 1.2;
const MAX_COLUMNS = 56;
const MAX_FIREBALLS = 10;

/** A fireball shot up from the floor on a kick: a moving heat source with a trail. */
interface Fireball {
  x: number;
  y: number;
  vx: number;
  vy: number;
  size: number;
  heat: number;
  age: number;
  life: number;
}

export class AudioEmitter implements Emitter {
  readonly name = 'audio';
  active = false;
  /** EQ wall is drawing the floor this frame (App skips the screen-bottom fire). */
  wallActive = false;
  private lastKickAt = -Infinity;
  private eruption = 0;
  private eruptionBursts = 0;
  private readonly fireballs: Fireball[] = [];

  constructor(
    private readonly audio: AudioState,
    private readonly bursts: BurstEmitter,
  ) {}

  /** Glow multiplier for the composite (1 = unchanged). */
  glowBoost(sensitivity: number): number {
    return 1 + this.audio.loud * (0.6 + 1.2 * sensitivity) + this.eruption * 0.8;
  }

  /** Buoyancy multiplier for the simulation (bass lifts the flames). */
  buoyancyBoost(sensitivity: number): number {
    return 1 + this.audio.bass * (0.3 + 0.9 * sensitivity) + this.eruption * 0.6;
  }

  update(ctx: EmitterContext): void {
    this.active = false;
    this.wallActive = false;
    const s = ctx.settings;
    if (s.audioSource === 'off') {
      this.eruption = 0;
      return;
    }
    const a = this.audio;
    const sens = s.audioSensitivity;
    const t = ctx.time;
    const W = ctx.width;
    const H = ctx.height;
    const floor = ctx.floor;
    const r = ctx.radius;
    const preset = ctx.preset;

    // ── drop eruption ──
    if (a.takeDrop() && s.audioDrops) {
      this.eruption = ERUPTION_S;
      this.eruptionBursts = 3;
    }
    if (this.eruption > 0) {
      this.eruption = Math.max(0, this.eruption - ctx.dt);
      const due = Math.ceil((this.eruption / ERUPTION_S) * 3);
      while (this.eruptionBursts > due && this.eruptionBursts > 0) {
        this.eruptionBursts--;
        const x = W * (0.2 + 0.6 * ctx.sparks.random.next());
        this.bursts.trigger(x, floor - r * 2, preset.burst * 1.4);
      }
      this.active = true;
    }

    // ── kick → fireball ──
    const kick = a.takeKick();
    if (kick > 0.05 && t - this.lastKickAt >= MIN_KICK_GAP_S) {
      this.lastKickAt = t;
      const k = Math.min(1, kick * (0.6 + 0.8 * sens));
      const rng = ctx.sparks.random;
      const x = W * (0.12 + 0.76 * rng.next());
      // launch flash at the floor + the fireball itself
      ctx.splat(x, floor - r, r * 1.6, preset.burst * 0.25 * k, 0.1 * k, 0, -H * 1.2 * k, H * 0.1 * k);
      if (this.fireballs.length >= MAX_FIREBALLS) this.fireballs.shift();
      this.fireballs.push({
        x,
        y: floor - r,
        vx: (rng.next() - 0.5) * H * 0.15,
        vy: -H * (0.9 + 0.9 * k),
        size: r * (0.9 + 0.7 * k),
        heat: 0.5 + 0.5 * k,
        age: 0,
        life: 0.55 + 0.35 * k,
      });
      if (s.sparks) ctx.sparks.burst(x, floor - r, Math.round(10 + 22 * k), 140, 420 + 300 * k, 0.4);
      this.active = true;
    }

    // ── fireballs in flight ──
    for (let i = this.fireballs.length - 1; i >= 0; i--) {
      const f = this.fireballs[i]!;
      f.age += ctx.dt;
      if (f.age >= f.life) {
        // pop at the top of the flight
        if (s.sparks) ctx.sparks.burst(f.x, f.y, 12, 80, 260, 0.2);
        this.fireballs.splice(i, 1);
        continue;
      }
      const k = 1 - f.age / f.life;
      const steps = 3;
      for (let j = 0; j < steps; j++) {
        f.x += (f.vx * ctx.dt) / steps;
        f.y += (f.vy * ctx.dt) / steps;
        ctx.splat(f.x, f.y, f.size * (0.7 + 0.3 * k), 0.22 * f.heat * k, 0.03, f.vx * 0.2, f.vy * 0.35);
      }
      f.vy *= Math.exp(-ctx.dt * 1.2); // slows as it climbs
      if (s.sparks && ctx.sparks.random.next() < 0.6) ctx.sparks.shed(f.x, f.y, f.vx, f.vy * 0.3, 1, 90);
      this.active = true;
    }

    // ── snare → spark shower ──
    const snare = a.takeSnare();
    if (snare > 0.05 && s.sparks) {
      const rng = ctx.sparks.random;
      for (let j = 0; j < 2; j++) {
        const x = W * (0.08 + 0.84 * rng.next());
        ctx.sparks.burst(x, floor - 2, Math.round(8 + 18 * snare * (0.5 + sens)), 60, 380 + 260 * snare, 0.25);
      }
      this.active = true;
    }

    // ── EQ wall (Pro; effectiveSettings already downgraded free installs) ──
    if (s.audioStyle === 'eq' && a.live()) {
      const count = Math.min(MAX_COLUMNS, Math.max(8, Math.ceil(W / (r * 1.25))));
      const step = W / count;
      const boost = 0.6 + 0.8 * sens + this.eruption;
      for (let i = 0; i < count; i++) {
        // mirror the spectrum around the centre: bass in the middle, highs at the edges
        const u = Math.abs((i + 0.5) / count - 0.5) * 2;
        const bf = u * (AUDIO_BANDS - 1);
        const b0 = Math.floor(bf);
        const level = Math.min(1, ((a.bands[b0] ?? 0) * (1 - (bf - b0)) + (a.bands[Math.min(AUDIO_BANDS - 1, b0 + 1)] ?? 0) * (bf - b0)) * boost);
        if (level < 0.04) continue;
        const fl = flicker(t * 2.2 + i * 0.37, 900 + i);
        const x = (i + 0.5) * step;
        ctx.splatSource(x, floor + r * 0.15, r * 1.5, Math.min(1, 0.35 + 0.65 * level) * (0.85 + 0.15 * fl), 0.05 * level, 0, -H * (0.3 + 2.4 * level));
        // a jet that makes tall columns for loud bands
        if (level > 0.25) ctx.splat(x, floor - r * 0.8, r * 1.1, 0.05 * level, 0, 0, -H * (0.6 + 2.6 * level) * ctx.dt * 8);
      }
      this.wallActive = true;
      this.active = true;
    }
  }
}
