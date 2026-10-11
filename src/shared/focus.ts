/**
 * "Termen limită": a focus timer drawn by the fire. A fuse burns along the
 * bottom of the screen; the last minute heats up, the last ten seconds are
 * counted down in flames and zero ends in a blaze.
 *
 * Pure logic shared by main (FocusClock owns the session) and the overlay
 * renderer (curves for the fuse). No Electron or DOM imports.
 */

export const FOCUS_PRESETS_MIN = [5, 15, 25, 50] as const;
export const FOCUS_MIN_MINUTES = 1;
export const FOCUS_MAX_MINUTES = 180;
export const FOCUS_DEFAULT_MINUTES = 25;
/** How long the blaze at zero lasts before the timer returns to idle. */
export const FOCUS_BLAZE_MS = 6000;
/** Flames count the last seconds down. */
export const FOCUS_COUNTDOWN_S = 10;
/** The fuse starts to heat up during the last minute. */
export const FOCUS_URGENT_MS = 60_000;

export type FocusPhase = 'idle' | 'running' | 'paused' | 'blaze';

/** main → overlays: the timer state at `sentAt` (renderer extrapolates from its receive time). */
export interface FocusFrame {
  phase: FocusPhase;
  /** Session id: changes for every new session so the renderer can reset. */
  id: number;
  durationMs: number;
  /** Remaining time when the frame was sent (0 during the blaze). */
  remainingMs: number;
  /** Elapsed blaze time when the frame was sent (0 outside the blaze). */
  blazeMs: number;
  /** True when the last session was stopped by the user (fuse is snuffed out). */
  cancelled: boolean;
  /** Word written in flames at zero ("GATA!"), already localised by main. */
  doneText: string;
}

export const IDLE_FOCUS: FocusFrame = { phase: 'idle', id: 0, durationMs: 0, remainingMs: 0, blazeMs: 0, cancelled: false, doneText: '' };
export const FOCUS_DONE_TEXT_MAX = 12;

export function clampFocusMinutes(value: unknown, fallback = FOCUS_DEFAULT_MINUTES): number {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  if (!Number.isFinite(n)) return fallback;
  return Math.min(FOCUS_MAX_MINUTES, Math.max(FOCUS_MIN_MINUTES, Math.round(n)));
}

/** "4:05", "25:00", "1:02:03". Rounds up so the display reaches 0:00 exactly at zero. */
export function formatClock(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

/** Burnt part of the fuse, 0 (fresh) .. 1 (gone). */
export function fuseProgress(remainingMs: number, durationMs: number): number {
  if (!(durationMs > 0)) return 1;
  return Math.min(1, Math.max(0, 1 - remainingMs / durationMs));
}

/**
 * How hard the fuse burns, 0.35 (calm) .. 1 (final seconds). Rises slowly over
 * the last fifth of the session and steeply during the last minute.
 */
export function focusHeat(remainingMs: number, durationMs: number): number {
  const p = fuseProgress(remainingMs, durationMs);
  const late = Math.max(0, (p - 0.8) / 0.2); // 0..1 over the last 20 %
  const urgent = remainingMs < FOCUS_URGENT_MS ? 1 - Math.max(0, remainingMs) / FOCUS_URGENT_MS : 0;
  return Math.min(1, 0.35 + 0.2 * late * late + 0.45 * urgent * urgent);
}

/** The second to draw in flames (10..1), or null outside the countdown. */
export function countdownDigit(remainingMs: number): number | null {
  if (!(remainingMs > 0) || remainingMs > FOCUS_COUNTDOWN_S * 1000) return null;
  return Math.ceil(remainingMs / 1000);
}

/**
 * Where the renderer is now, extrapolated from the last frame. `elapsed` is the
 * time since the frame arrived (ms).
 */
export function extrapolate(frame: FocusFrame, elapsed: number): { remainingMs: number; blazeMs: number } {
  const e = Math.max(0, elapsed);
  if (frame.phase === 'running') return { remainingMs: Math.max(0, frame.remainingMs - e), blazeMs: 0 };
  if (frame.phase === 'blaze') return { remainingMs: 0, blazeMs: frame.blazeMs + e };
  return { remainingMs: frame.remainingMs, blazeMs: 0 };
}

/**
 * The session state machine (main process). Time is passed in so it is
 * testable; FocusService drives it with a timer.
 */
export class FocusClock {
  private phaseValue: FocusPhase = 'idle';
  private idValue = 0;
  private duration = 0;
  /** Running: when the session ends. Paused: the remaining time. */
  private endsAt = 0;
  private pausedRemaining = 0;
  private blazeStart = 0;
  private cancelledValue = false;

  get phase(): FocusPhase {
    return this.phaseValue;
  }

  get id(): number {
    return this.idValue;
  }

  get durationMs(): number {
    return this.duration;
  }

  start(durationMs: number, now: number): void {
    this.idValue++;
    this.duration = Math.max(1000, durationMs);
    this.endsAt = now + this.duration;
    this.pausedRemaining = 0;
    this.blazeStart = 0;
    this.cancelledValue = false;
    this.phaseValue = 'running';
  }

  pause(now: number): boolean {
    if (this.phaseValue !== 'running') return false;
    this.pausedRemaining = Math.max(0, this.endsAt - now);
    this.phaseValue = 'paused';
    return true;
  }

  resume(now: number): boolean {
    if (this.phaseValue !== 'paused') return false;
    this.endsAt = now + this.pausedRemaining;
    this.phaseValue = 'running';
    return true;
  }

  /** Stops a running/paused session (the fuse is snuffed out). */
  cancel(): boolean {
    if (this.phaseValue === 'idle') return false;
    this.cancelledValue = this.phaseValue !== 'blaze';
    this.phaseValue = 'idle';
    this.pausedRemaining = 0;
    return true;
  }

  remaining(now: number): number {
    if (this.phaseValue === 'running') return Math.max(0, this.endsAt - now);
    if (this.phaseValue === 'paused') return this.pausedRemaining;
    return 0;
  }

  /**
   * Advances the phases; returns 'finished' when the time ran out on this call
   * and 'ended' when the blaze is over.
   */
  tick(now: number): 'finished' | 'ended' | null {
    if (this.phaseValue === 'running' && now >= this.endsAt) {
      this.phaseValue = 'blaze';
      this.blazeStart = this.endsAt;
      // A late tick (the machine slept) still shows the whole blaze.
      if (now - this.blazeStart >= FOCUS_BLAZE_MS) this.blazeStart = now;
      return 'finished';
    }
    if (this.phaseValue === 'blaze' && now - this.blazeStart >= FOCUS_BLAZE_MS) {
      this.phaseValue = 'idle';
      this.cancelledValue = false;
      return 'ended';
    }
    return null;
  }

  frame(now: number, doneText = ''): FocusFrame {
    return {
      phase: this.phaseValue,
      id: this.idValue,
      durationMs: this.duration,
      remainingMs: this.remaining(now),
      blazeMs: this.phaseValue === 'blaze' ? Math.max(0, now - this.blazeStart) : 0,
      cancelled: this.cancelledValue,
      doneText: doneText.slice(0, FOCUS_DONE_TEXT_MAX),
    };
  }
}

/** Validates a frame that crossed IPC. */
export function sanitizeFocusFrame(value: unknown): FocusFrame {
  if (!value || typeof value !== 'object') return IDLE_FOCUS;
  const v = value as Record<string, unknown>;
  const phase = v.phase === 'running' || v.phase === 'paused' || v.phase === 'blaze' ? v.phase : 'idle';
  const num = (x: unknown): number => (typeof x === 'number' && Number.isFinite(x) ? Math.max(0, x) : 0);
  return {
    phase,
    id: num(v.id),
    durationMs: num(v.durationMs),
    remainingMs: num(v.remainingMs),
    blazeMs: num(v.blazeMs),
    cancelled: v.cancelled === true,
    doneText: typeof v.doneText === 'string' ? v.doneText.slice(0, FOCUS_DONE_TEXT_MAX) : '',
  };
}
