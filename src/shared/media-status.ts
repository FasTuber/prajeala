/**
 * Ritmul Focului — pure helpers of the media host (capture page + main-side
 * relay): capture error → status mapping, the silence/ok status tracker, the
 * page's 60 Hz tick grid, the frame-rate throttle and the onset carry-over for
 * throttled frames. No DOM or Electron imports, so they are unit-tested.
 */
import { AUDIO_FRAME_HZ, type AudioFrame, type AudioStatus } from './audio-contract';

export type MediaSource = 'system' | 'mic';

/** Continuous silence after which the page reports 'silent' (once). */
export const SILENCE_REPORT_MS = 10_000;

/** Delay between `stop()` and destroying the hidden window (frees its memory). */
export const MEDIA_HOST_IDLE_DESTROY_MS = 2_000;

export interface CaptureErrorStatus {
  status: AudioStatus;
  detail: string;
}

/**
 * Maps a getUserMedia / getDisplayMedia rejection to a status:
 * NotAllowedError / SecurityError → 'denied'; NotFound / NotSupported /
 * NotReadable / Overconstrained → 'unsupported'; anything else → 'error'.
 * `detail` is the error message (or its name when the message is empty).
 */
export function statusForCaptureError(err: unknown): CaptureErrorStatus {
  const name = err && typeof err === 'object' && typeof (err as { name?: unknown }).name === 'string' ? (err as { name: string }).name : '';
  const message =
    err && typeof err === 'object' && typeof (err as { message?: unknown }).message === 'string'
      ? (err as { message: string }).message
      : typeof err === 'string'
        ? err
        : '';
  const detail = (message || name || 'unknown error').slice(0, 300);
  switch (name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return { status: 'denied', detail };
    case 'NotFoundError':
    case 'NotSupportedError':
    case 'NotReadableError':
    case 'OverconstrainedError':
      return { status: 'unsupported', detail };
    default:
      return { status: 'error', detail };
  }
}

/**
 * Status after a live audio track ended on its own. macOS ends tracks when the
 * microphone / screen-recording permission is revoked, and a system capture
 * ends when the user stops sharing (Linux portal) — both count as 'denied'.
 * Anything else (mic unplugged, device error) is an 'error'.
 */
export function statusForEndedTrack(source: MediaSource, isMac: boolean): CaptureErrorStatus {
  if (isMac) return { status: 'denied', detail: 'audio access was revoked' };
  if (source === 'system') return { status: 'denied', detail: 'system audio capture was stopped' };
  return { status: 'error', detail: 'microphone disconnected' };
}

/**
 * 'starting' → 'ok' on the first frame; 'silent' (once) after
 * SILENCE_REPORT_MS of uninterrupted silent frames; back to 'ok' as soon as a
 * frame carries sound. `frame()` returns the new status on a change, else null.
 */
export class CaptureStatusTracker {
  private current: 'starting' | 'ok' | 'silent' = 'starting';
  private silentSince: number | null = null;

  constructor(private readonly silenceMs: number = SILENCE_REPORT_MS) {}

  get status(): 'starting' | 'ok' | 'silent' {
    return this.current;
  }

  frame(silent: boolean, nowMs: number): 'ok' | 'silent' | null {
    if (!silent) {
      this.silentSince = null;
      return this.set('ok');
    }
    if (this.silentSince === null) this.silentSince = nowMs;
    if (this.current !== 'silent' && nowMs - this.silentSince >= this.silenceMs) return this.set('silent');
    return this.current === 'starting' ? this.set('ok') : null;
  }

  reset(): void {
    this.current = 'starting';
    this.silentSince = null;
  }

  private set(next: 'ok' | 'silent'): 'ok' | 'silent' | null {
    if (this.current === next) return null;
    this.current = next;
    return next;
  }
}

/**
 * Lets through at most `hz` frames per second on average. Frames are matched
 * against a fixed grid (not "time since last frame"), so timer/IPC jitter of up
 * to `tolerance` of an interval does not drop frames while the long-term rate
 * still never exceeds `hz`. After a gap the grid restarts at the next frame.
 */
export class FrameThrottle {
  private nextDue = Number.NEGATIVE_INFINITY;
  private readonly interval: number;
  private readonly slack: number;

  constructor(hz: number = AUDIO_FRAME_HZ, tolerance = 0.25) {
    this.interval = 1000 / Math.max(1, hz);
    this.slack = this.interval * Math.min(0.9, Math.max(0, tolerance));
  }

  /** True when a frame arriving at `nowMs` may be relayed. */
  accept(nowMs: number): boolean {
    if (nowMs < this.nextDue - this.slack) return false;
    // Late by more than one interval → do not let the backlog become a burst.
    this.nextDue = nowMs - this.nextDue > this.interval ? nowMs + this.interval : this.nextDue + this.interval;
    return true;
  }

  reset(): void {
    this.nextDue = Number.NEGATIVE_INFINITY;
  }
}

/**
 * Drift-free tick grid for the capture page. `setTimeout`/`setInterval` take
 * whole milliseconds (1000/60 → 16 ms = 62.5 Hz, which the relay would then
 * have to thin out), so each delay is computed against a fixed 1/hz grid
 * instead: the average rate is exactly `hz`. A stall longer than one interval
 * restarts the grid rather than firing a catch-up burst.
 */
export class TickGrid {
  private due = Number.NaN;
  private readonly interval: number;

  constructor(hz: number = AUDIO_FRAME_HZ) {
    this.interval = 1000 / Math.max(1, hz);
  }

  /** Delay in ms from `nowMs` to the next tick. */
  next(nowMs: number): number {
    if (!Number.isFinite(nowMs)) return this.interval;
    this.due = Number.isFinite(this.due) ? this.due + this.interval : nowMs + this.interval;
    if (this.due - nowMs < -this.interval) this.due = nowMs + this.interval;
    return Math.max(0, this.due - nowMs);
  }

  reset(): void {
    this.due = Number.NaN;
  }
}

/**
 * kick / snare / drop exist on a single frame only, so a frame the throttle
 * drops must not take its onset with it: `hold()` keeps the strongest onsets of
 * dropped (raw, untrusted) frames and `release()` merges them into the next
 * relayed frame.
 */
export class PendingOnsets {
  private kick = 0;
  private snare = 0;
  private drop = false;

  hold(raw: unknown): void {
    if (!raw || typeof raw !== 'object') return;
    const f = raw as Record<string, unknown>;
    this.kick = Math.max(this.kick, unit(f.kick));
    this.snare = Math.max(this.snare, unit(f.snare));
    this.drop ||= f.drop === true;
  }

  /** Merges the held onsets into `frame` (mutated and returned) and clears them. */
  release(frame: AudioFrame): AudioFrame {
    if (this.kick > frame.kick) frame.kick = this.kick;
    if (this.snare > frame.snare) frame.snare = this.snare;
    if (this.drop) frame.drop = true;
    this.reset();
    return frame;
  }

  reset(): void {
    this.kick = 0;
    this.snare = 0;
    this.drop = false;
  }
}

function unit(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0;
}

/** Clamps an untrusted sensitivity to 0..1 (default 0.5). */
export function clampSensitivity(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0.5;
}
