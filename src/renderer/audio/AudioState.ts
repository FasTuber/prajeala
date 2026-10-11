/**
 * The latest Ritmul Focului frame plus smoothed envelopes for the visuals.
 * Onsets (kick/snare/drop) are latched until an emitter consumes them, so a
 * frame that arrives between two render frames is never lost. Everything
 * decays to silence if frames stop arriving (source turned off, host gone).
 */
import { AUDIO_BANDS, type AudioFrame } from '../../shared/audio-contract';

const STALE_MS = 250;

export class AudioState {
  readonly bands = new Float32Array(AUDIO_BANDS);
  loud = 0;
  bass = 0;
  mid = 0;
  high = 0;
  /** Pending onsets (strength 0..1) and drop flag, cleared by take*(). */
  private kick = 0;
  private snare = 0;
  private drop = false;
  private lastFrameAt = -Infinity;
  private silent = true;

  push(frame: AudioFrame, now = performance.now()): void {
    this.lastFrameAt = now;
    this.silent = frame.silent;
    // Short smoothing on top of the analyser's own envelopes: steadier columns, no flicker.
    this.loud = frame.loud;
    this.bass = frame.bass;
    this.mid = frame.mid;
    this.high = frame.high;
    for (let i = 0; i < AUDIO_BANDS; i++) {
      const v = frame.bands[i] ?? 0;
      const cur = this.bands[i] ?? 0;
      this.bands[i] = v > cur ? v : cur * 0.6 + v * 0.4;
    }
    this.kick = Math.max(this.kick, frame.kick);
    this.snare = Math.max(this.snare, frame.snare);
    this.drop = this.drop || frame.drop;
  }

  /** True while frames with sound keep arriving. */
  live(now = performance.now()): boolean {
    return now - this.lastFrameAt < STALE_MS && !this.silent;
  }

  /** Lets everything fade when frames stop. Call once per render frame. */
  tick(dt: number, now = performance.now()): void {
    if (now - this.lastFrameAt < STALE_MS) return;
    const k = Math.exp(-dt * 6);
    this.loud *= k;
    this.bass *= k;
    this.mid *= k;
    this.high *= k;
    for (let i = 0; i < AUDIO_BANDS; i++) this.bands[i] = (this.bands[i] ?? 0) * k;
    this.kick = 0;
    this.snare = 0;
    this.drop = false;
  }

  takeKick(): number {
    const v = this.kick;
    this.kick = 0;
    return v;
  }

  takeSnare(): number {
    const v = this.snare;
    this.snare = 0;
    return v;
  }

  takeDrop(): boolean {
    const v = this.drop;
    this.drop = false;
    return v;
  }

  reset(): void {
    this.bands.fill(0);
    this.loud = this.bass = this.mid = this.high = 0;
    this.kick = this.snare = 0;
    this.drop = false;
    this.lastFrameAt = -Infinity;
    this.silent = true;
  }
}
