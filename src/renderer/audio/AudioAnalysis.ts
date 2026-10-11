/**
 * Turns raw FFT magnitudes into a handful of smoothed, auto-levelled numbers the
 * emitters can use: overall level, bass / mid / high bands and a beat pulse.
 * Pure (no Web Audio objects), so the maths is unit-tested with synthetic spectra.
 */

export interface AudioLevels {
  /** True while a source is delivering data. */
  active: boolean;
  /** Overall loudness, auto-levelled, 0..1 (can briefly exceed 1 on peaks). */
  level: number;
  bass: number;
  mid: number;
  high: number;
  /** 1 right on a detected beat, decaying to 0 within ~0.3 s. */
  beat: number;
  /** Rising edge: true only on the frame a beat was detected. */
  beatHit: boolean;
  /** Beats per minute estimate (0 when unknown). */
  bpm: number;
}

export function emptyLevels(): AudioLevels {
  return { active: false, level: 0, bass: 0, mid: 0, high: 0, beat: 0, beatHit: false, bpm: 0 };
}

export interface AnalysisOptions {
  /** Sensitivity multiplier (settings.audioGain). */
  gain: number;
}

const BANDS = {
  bass: [30, 160],
  mid: [160, 2200],
  high: [2200, 9000],
} as const;

/** Minimum spacing between beats (s): 0.25 s = 240 bpm ceiling. */
const BEAT_MIN_INTERVAL = 0.25;
const BEAT_DECAY_PER_S = 3.6;
/** Energy history window for the beat threshold (s). */
const HISTORY_SECONDS = 1.2;
/** Floor below which the signal is treated as silence (auto-level does not amplify noise). */
const SILENCE_FLOOR = 0.02;

export class AudioAnalysis {
  readonly levels: AudioLevels = emptyLevels();
  private peak = 0.15; // running peak for auto-levelling (0..1 raw units)
  private readonly history = new Float32Array(90);
  private historyIndex = 0;
  private historyCount = 0;
  private historyAccum = 0;
  private lastBeatAt = -10;
  private time = 0;
  private readonly intervals: number[] = [];
  private smoothedBass = 0;
  private smoothedMid = 0;
  private smoothedHigh = 0;
  private smoothedLevel = 0;

  constructor(private options: AnalysisOptions = { gain: 1 }) {}

  setGain(gain: number): void {
    this.options = { ...this.options, gain };
  }

  reset(): void {
    Object.assign(this.levels, emptyLevels());
    this.peak = 0.15;
    this.historyCount = 0;
    this.historyIndex = 0;
    this.historyAccum = 0;
    this.lastBeatAt = -10;
    this.intervals.length = 0;
    this.smoothedBass = this.smoothedMid = this.smoothedHigh = this.smoothedLevel = 0;
  }

  /**
   * `spectrum`: byte magnitudes per FFT bin (0..255), `binHz`: Hz per bin,
   * `dt`: seconds since the previous call.
   */
  update(spectrum: Uint8Array, binHz: number, dt: number): AudioLevels {
    const L = this.levels;
    this.time += dt;
    const rawBass = bandAverage(spectrum, binHz, BANDS.bass[0], BANDS.bass[1]);
    const rawMid = bandAverage(spectrum, binHz, BANDS.mid[0], BANDS.mid[1]);
    const rawHigh = bandAverage(spectrum, binHz, BANDS.high[0], BANDS.high[1]);
    // Perceptual-ish mix: bass carries the "pulse", mids the body, highs the sparkle.
    const rawLevel = rawBass * 0.5 + rawMid * 0.35 + rawHigh * 0.15;

    // Auto-level: follow peaks quickly, release slowly (≈ 6 s to halve).
    if (rawLevel > this.peak) this.peak += (rawLevel - this.peak) * Math.min(1, dt * 12);
    else this.peak += (rawLevel - this.peak) * Math.min(1, dt * 0.12);
    this.peak = Math.max(0.08, this.peak);
    const norm = this.options.gain / this.peak;

    // Attack fast, release a bit slower so flames swell rather than flicker.
    const smooth = (prev: number, next: number): number => prev + (next - prev) * Math.min(1, dt * (next > prev ? 30 : 9));
    const silence = rawLevel < SILENCE_FLOOR;
    this.smoothedLevel = smooth(this.smoothedLevel, silence ? 0 : clamp(rawLevel * norm, 0, 1.5));
    this.smoothedBass = smooth(this.smoothedBass, silence ? 0 : clamp(rawBass * norm, 0, 1.5));
    this.smoothedMid = smooth(this.smoothedMid, silence ? 0 : clamp(rawMid * norm, 0, 1.5));
    this.smoothedHigh = smooth(this.smoothedHigh, silence ? 0 : clamp(rawHigh * norm * 1.3, 0, 1.5));

    // Beat: bass energy well above its recent average.
    const energy = rawBass * rawBass;
    const avg = this.historyCount > 0 ? this.historyAccum / this.historyCount : 0;
    this.pushHistory(energy, dt);
    let hit = false;
    const sinceBeat = this.time - this.lastBeatAt;
    if (!silence && this.historyCount >= 10 && sinceBeat >= BEAT_MIN_INTERVAL && energy > avg * 1.45 && energy > 0.004) {
      hit = true;
      if (sinceBeat < 2.5) {
        this.intervals.push(sinceBeat);
        if (this.intervals.length > 8) this.intervals.shift();
      }
      this.lastBeatAt = this.time;
    }
    L.beat = hit ? 1 : Math.max(0, L.beat - BEAT_DECAY_PER_S * dt);
    L.beatHit = hit;
    L.level = this.smoothedLevel;
    L.bass = this.smoothedBass;
    L.mid = this.smoothedMid;
    L.high = this.smoothedHigh;
    L.bpm = this.estimateBpm();
    L.active = true;
    return L;
  }

  private pushHistory(energy: number, dt: number): void {
    // History is sampled at most ~75 Hz; longer frames just count once.
    const cap = Math.max(10, Math.min(this.history.length, Math.round(HISTORY_SECONDS / Math.max(dt, 1 / 75))));
    if (this.historyCount >= cap) {
      const oldest = this.history[this.historyIndex] ?? 0;
      this.historyAccum -= oldest;
    } else {
      this.historyCount++;
    }
    this.history[this.historyIndex] = energy;
    this.historyAccum += energy;
    this.historyIndex = (this.historyIndex + 1) % cap;
  }

  private estimateBpm(): number {
    if (this.intervals.length < 3) return 0;
    const sorted = [...this.intervals].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)] ?? 0;
    if (median <= 0) return 0;
    const bpm = 60 / median;
    return bpm > 40 && bpm < 240 ? Math.round(bpm) : 0;
  }
}

/** Mean magnitude (0..1) of the bins covering [fromHz, toHz). */
export function bandAverage(spectrum: Uint8Array, binHz: number, fromHz: number, toHz: number): number {
  if (spectrum.length === 0 || binHz <= 0) return 0;
  const start = Math.max(0, Math.floor(fromHz / binHz));
  const end = Math.min(spectrum.length, Math.max(start + 1, Math.ceil(toHz / binHz)));
  let sum = 0;
  for (let i = start; i < end; i++) sum += spectrum[i] ?? 0;
  return sum / ((end - start) * 255);
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
