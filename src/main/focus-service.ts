/**
 * "Termen limită" in the main process: owns the focus session (FocusClock),
 * ticks it, tells the overlays where the fuse is and notifies when time is up.
 * Sessions live in memory only; quitting the app ends them.
 */
import { EventEmitter } from 'node:events';
import { FocusClock, type FocusFrame } from '../shared/focus';

/** Overlays extrapolate between frames; this only corrects drift. */
const RESYNC_MS = 5000;
const TICK_MS = 250;

export interface FocusServiceEvents {
  /** Every state change and every resync. */
  frame: [FocusFrame];
  /** The time ran out (the blaze starts now). */
  finished: [{ durationMs: number }];
}

export class FocusService extends EventEmitter<FocusServiceEvents> {
  private readonly clock = new FocusClock();
  private timer: NodeJS.Timeout | null = null;
  private lastSync = 0;

  constructor(
    private readonly doneText: () => string,
    private readonly now: () => number = () => performance.now(),
  ) {
    super();
  }

  get phase(): FocusFrame['phase'] {
    return this.clock.phase;
  }

  get frame(): FocusFrame {
    return this.clock.frame(this.now(), this.doneText());
  }

  /** Remaining time (ms) of a running or paused session, else 0. */
  get remainingMs(): number {
    return this.clock.remaining(this.now());
  }

  get durationMs(): number {
    return this.clock.durationMs;
  }

  start(minutes: number): void {
    this.clock.start(minutes * 60_000, this.now());
    this.changed();
  }

  pause(): void {
    if (this.clock.pause(this.now())) this.changed();
  }

  resume(): void {
    if (this.clock.resume(this.now())) this.changed();
  }

  togglePause(): void {
    if (this.clock.phase === 'paused') this.resume();
    else this.pause();
  }

  cancel(): void {
    if (this.clock.cancel()) this.changed();
  }

  destroy(): void {
    this.stopTimer();
    this.removeAllListeners();
  }

  // ── internals ──────────────────────────────────────────────────────────

  private changed(): void {
    this.publish();
    if (this.clock.phase === 'running' || this.clock.phase === 'blaze') this.startTimer();
    else this.stopTimer();
  }

  private publish(): void {
    this.lastSync = this.now();
    this.emit('frame', this.frame);
  }

  private startTimer(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), TICK_MS);
    this.timer.unref?.();
  }

  private stopTimer(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  private tick(): void {
    const now = this.now();
    const event = this.clock.tick(now);
    if (event === 'finished') this.emit('finished', { durationMs: this.clock.durationMs });
    if (event) this.changed();
    else if (now - this.lastSync >= RESYNC_MS) this.publish();
  }
}
