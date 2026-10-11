/**
 * Latest cursor position plus a smoothed velocity estimate (CSS px/s) built
 * from the main-process timestamps of the incoming events.
 */
import type { CursorEvent } from '../../shared/ipc';

export class CursorState {
  x = -10000;
  y = -10000;
  inside = false;
  hasPosition = false;
  /** Smoothed velocity, CSS px/s. */
  vx = 0;
  vy = 0;
  /** Smoothed speed, CSS px/s. */
  speed = 0;
  /** Unit direction of travel (valid when speed > 0). */
  dirX = 0;
  dirY = 0;
  /** Seconds since the last event (grows between frames). */
  idle = 0;

  private lastT = 0;

  push(e: CursorEvent): void {
    if (this.hasPosition && e.t > this.lastT) {
      const dt = Math.min(0.1, Math.max(0.002, (e.t - this.lastT) / 1000));
      const ivx = (e.x - this.x) / dt;
      const ivy = (e.y - this.y) / dt;
      // Light smoothing: events arrive at ~120 Hz, so react quickly.
      const k = 0.55;
      this.vx += (ivx - this.vx) * k;
      this.vy += (ivy - this.vy) * k;
    }
    this.x = e.x;
    this.y = e.y;
    this.inside = e.inside;
    this.hasPosition = true;
    this.lastT = e.t;
    this.idle = 0;
    this.refresh();
  }

  /** Per-frame: decays the velocity when no events arrive. */
  tick(dt: number): void {
    this.idle += dt;
    if (this.idle > 0.05) {
      const f = Math.exp(-dt * 18);
      this.vx *= f;
      this.vy *= f;
      if (this.speed < 2) {
        this.vx = 0;
        this.vy = 0;
      }
      this.refresh();
    }
  }

  private refresh(): void {
    this.speed = Math.hypot(this.vx, this.vy);
    if (this.speed > 1e-3) {
      this.dirX = this.vx / this.speed;
      this.dirY = this.vy / this.speed;
    }
  }
}
