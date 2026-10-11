/**
 * Ritmul Focului — data shared by the media host (capture + analysis), main
 * (relay) and the overlays (visuals). Pure types and constants.
 */

export const AUDIO_BANDS = 32;
/** Rate at which the media host sends frames to main. */
export const AUDIO_FRAME_HZ = 60;

/** One analysis frame. All levels are auto-gained to 0..1. */
export interface AudioFrame {
  /** Monotonic ms (media host clock) — only differences matter. */
  t: number;
  /** Overall loudness envelope (fast attack, slower release). */
  loud: number;
  bass: number;
  mid: number;
  high: number;
  /** AUDIO_BANDS log-spaced bands, 30 Hz … 16 kHz. */
  bands: number[];
  /** Onset strengths 0..1 on this frame (0 = none): kick drum, snare/clap. */
  kick: number;
  snare: number;
  /** True on the frame a drop (sudden loud section after a quieter one) is detected. */
  drop: boolean;
  /** True when there is effectively no sound. */
  silent: boolean;
}

export type AudioStatus = 'off' | 'starting' | 'ok' | 'silent' | 'unsupported' | 'denied' | 'error';

/** Media host → main: capture state. */
export interface AudioStatusReport {
  status: AudioStatus;
  /** Which source is actually running. */
  source: 'system' | 'mic' | null;
  detail?: string;
}

export const SILENT_FRAME: Readonly<AudioFrame> = Object.freeze({
  t: 0,
  loud: 0,
  bass: 0,
  mid: 0,
  high: 0,
  bands: Object.freeze(new Array(AUDIO_BANDS).fill(0)) as number[],
  kick: 0,
  snare: 0,
  drop: false,
  silent: true,
});

/** Clamps an untrusted frame (from another process) into a valid one. */
export function sanitizeAudioFrame(input: unknown): AudioFrame | null {
  if (!input || typeof input !== 'object') return null;
  const f = input as Record<string, unknown>;
  const n = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0);
  const rawBands = Array.isArray(f.bands) ? f.bands : [];
  const bands = new Array<number>(AUDIO_BANDS);
  for (let i = 0; i < AUDIO_BANDS; i++) bands[i] = n(rawBands[i]);
  return {
    t: typeof f.t === 'number' && Number.isFinite(f.t) ? f.t : 0,
    loud: n(f.loud),
    bass: n(f.bass),
    mid: n(f.mid),
    high: n(f.high),
    bands,
    kick: n(f.kick),
    snare: n(f.snare),
    drop: f.drop === true,
    silent: f.silent === true,
  };
}
