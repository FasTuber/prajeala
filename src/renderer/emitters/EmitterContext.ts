/**
 * Shared per-frame state handed to every emitter, plus the CSS-pixel → simulation
 * unit conversion for splats. Emitters never touch the GPU directly.
 */
import type { Settings, IntensityPreset } from '../../shared/settings';
import { DEFAULT_SETTINGS, INTENSITY_PRESETS } from '../../shared/settings';
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
  /** Local y (CSS px) of the edge the bottom fire stands on: the top of the taskbar, or the screen bottom. */
  floor = 1;
  /** Frame delta (s) and wrapped wall time (s). */
  dt = 1 / 60;
  time = 0;
  settings: Settings = DEFAULT_SETTINGS;
  preset: IntensityPreset = INTENSITY_PRESETS[DEFAULT_SETTINGS.intensity];

  constructor(
    readonly queue: SplatQueue,
    readonly sparks: Sparks,
  ) {}

  /** Base splat radius in CSS px (preset radius × short side). */
  get radius(): number {
    return this.preset.radius * Math.min(this.width, this.height);
  }

  /** Converts an amount per second into an amount for this frame. */
  perFrame(perSecond: number): number {
    return perSecond * this.dt;
  }

  inView(x: number, y: number, margin: number): boolean {
    return x >= -margin && x <= this.width + margin && y >= -margin && y <= this.height + margin;
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
