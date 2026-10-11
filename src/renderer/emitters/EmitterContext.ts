/**
 * Shared per-frame state handed to every emitter, plus the CSS-pixel → simulation
 * unit conversion for splats. Emitters never touch the GPU directly.
 */
import type { Settings, IntensityPreset } from '../../shared/settings';
import { DEFAULT_SETTINGS, INTENSITY_PRESETS } from '../../shared/settings';
import { emptyLevels, type AudioLevels } from '../audio/AudioAnalysis';
import type { SplatQueue } from '../sim/SplatQueue';
import type { Sparks } from '../sparks/Sparks';

export interface Emitter {
  readonly name: string;
  /** True when the emitter contributed something during the last update. */
  readonly active: boolean;
  update(ctx: EmitterContext): void;
}

export class EmitterContext {
  /** Canvas size in CSS px. */
  width = 1;
  height = 1;
  /** Frame delta (s) and wrapped wall time (s). */
  dt = 1 / 60;
  time = 0;
  settings: Settings = DEFAULT_SETTINGS;
  preset: IntensityPreset = INTENSITY_PRESETS[DEFAULT_SETTINGS.intensity];
  /** Sound levels for this frame (all zero / inactive when sound reactivity is off). */
  audio: AudioLevels = emptyLevels();
  /** Theme flow: multiplier for the emitters' vertical push (1 fire rises, -1 water sinks). */
  flow = 1;

  constructor(
    readonly queue: SplatQueue,
    readonly sparks: Sparks,
  ) {}

  /** Base splat radius in CSS px (preset radius × short side), swelling with the bass. */
  get radius(): number {
    return this.preset.radius * Math.min(this.width, this.height) * (1 + 0.35 * this.audio.bass);
  }

  /** Multiplier for emitter temperature/strength driven by the music (1 when inactive). */
  get audioBoost(): number {
    const a = this.audio;
    return a.active ? 0.75 + 0.6 * a.level + 0.35 * a.beat : 1;
  }

  /** Converts an amount per second into an amount for this frame. */
  perFrame(perSecond: number): number {
    return perSecond * this.dt;
  }

  inView(x: number, y: number, margin: number): boolean {
    return x >= -margin && x <= this.width + margin && y >= -margin && y <= this.height + margin;
  }

  /**
   * Vertical push (CSS px/s or px/s²) of `k` screen heights "along the flow":
   * negative (upward on screen) for fire, downward when the theme sinks.
   */
  lift(k: number): number {
    return -this.height * k * this.flow;
  }

  /**
   * Queues an impulse splat (discrete events: trail segments, bursts).
   * Positions/radius in CSS px (y down); `vx`, `vy` and `radial` are velocity
   * impulses in CSS px/s added once.
   */
  splat(x: number, y: number, radius: number, heat: number, smoke: number, vx = 0, vy = 0, radial = 0): void {
    const h = this.height;
    this.queue.push(x / this.width, 1 - y / h, radius / h, radial / h, Math.max(0, heat), smoke, vx / h, -vy / h);
  }

  /**
   * Queues a steady source (called every frame): the field is raised to at
   * least `temperature` (0..1) at the centre, and `ax`, `ay` are accelerations
   * in CSS px/s² applied for this frame only.
   */
  splatSource(x: number, y: number, radius: number, temperature: number, smoke: number, ax = 0, ay = 0): void {
    const h = this.height;
    const dt = this.dt;
    this.queue.push(x / this.width, 1 - y / h, radius / h, 0, -Math.max(0, temperature), smoke, (ax * dt) / h, (-ay * dt) / h);
  }
}
