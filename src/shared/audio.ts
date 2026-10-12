/**
 * Ritmul Focului — audio analysis. Turns AnalyserNode spectra (dBFS bins from
 * getFloatFrequencyData) into AudioFrames: auto-gained log bands, bass / mid /
 * high, a loudness envelope and kick / snare / drop events. Pure module (no DOM,
 * no Electron) so the media host and the tests share it. Allocation-free per
 * frame apart from the returned frame; every time constant uses nowMs deltas, so
 * results do not depend on the frame rate.
 */
import { AUDIO_BANDS, type AudioFrame } from './audio-contract';

export interface AnalyzerOptions {
  sampleRate: number;
  fftSize: number;
  /** 0 = subtle … 1 = very reactive. */
  sensitivity: number;
}

const MIN_HZ = 30;
const MAX_HZ = 16_000;
/** Group boundaries (by band centre). */
const BASS_MAX_HZ = 150;
const MID_MAX_HZ = 2000;
const SNARE_MIN_HZ = 1500;
const SNARE_MAX_HZ = 6000;

/** Noise gate: band / total levels below this count as nothing. */
const GATE_DB = -70;
const GATE_POWER = 10 ** (GATE_DB / 10);
/** Auto-gain never amplifies past this peak, so near-gate hiss stays dark. */
const PEAK_FLOOR_DB = -60;
/** Lowest level we track (stands in for -Infinity / NaN / empty bins). */
const MIN_LEVEL_DB = -140;
/**
 * Highest bin level we trust. A full-scale sine reads about −14 dB in getFloatFrequencyData, so a
 * bin above this is garbage; counted, it would pin the auto-gain peak and darken the band for seconds.
 */
const MAX_BIN_DB = 20;
const PEAK_RELEASE_MS = 6000;
const BAND_RELEASE_MS = 80;
const LOUD_ATTACK_MS = 15;
const LOUD_RELEASE_MS = 250;
/** Release while silent; values under SNAP are set to exactly 0. */
const SILENT_RELEASE_MS = 40;
const SNAP = 1e-3;
const SILENT_AFTER_MS = 300;
/** Longest step fed to the time constants (a stalled host must not explode them). */
const MAX_DT_MS = 2000;
const NOMINAL_DT_MS = 1000 / 60;

/** Flux only sees this many dB under the band's running peak (and never under the gate). */
const FLUX_RANGE_DB = 40;
const ONSET_WINDOW_MS = 700;
/** Threshold = median + ONSET_K · mean absolute deviation, never under the per-detector minimum. */
const ONSET_K = 2;
/** Floors tuned with the 3-frame flux reference so raw (smoothingTimeConstant 0) noise stays quiet. */
const KICK_MIN_FLUX_DB = 6;
const SNARE_MIN_FLUX_DB = 4;
const KICK_REFRACTORY_MS = 90;
const SNARE_REFRACTORY_MS = 110;
/** Flux this far above the threshold gives strength 1. */
const ONSET_FULL_SCALE_DB = 12;
const ONSET_MIN_STRENGTH = 0.15;
const ONSET_CAPACITY = 256;

const DROP_SHORT_MS = 500;
const DROP_SHORT_CAPACITY = 512;
const DROP_LONG_SAMPLE_MS = 100;
const DROP_LONG_MS = 4000;
/** Room for 4 s of 100 ms samples plus timing jitter. */
const DROP_LONG_CAPACITY = 48;
const DROP_RATIO = 2.2;
/** The calm stretch (DROP_CALM_MS long, ending DROP_RISE_MS ago) must be this much quieter than now. */
const DROP_CALM_RATIO = 2.2;
const DROP_CALM_MS = 2000;
const DROP_RISE_MS = 300;
const DROP_CALM_MIN_SAMPLES = 15;
/** Mean positive flux over all bands that counts as the drop's "hit"… */
const DROP_FLUX_DB = 6;
/** …and how long ago it may have happened. */
const DROP_SPIKE_MS = 400;
const DROP_COOLDOWN_MS = 8000;

const clamp01 = (v: number): number => (v <= 0 ? 0 : v >= 1 ? 1 : v);

/** count+1 log-spaced band edges in Hz: edge i = minHz · (maxHz/minHz)^(i/count). */
export function bandEdgesHz(count = AUDIO_BANDS, minHz = MIN_HZ, maxHz = MAX_HZ): number[] {
  const edges = new Array<number>(count + 1);
  const ratio = maxHz / minHz;
  for (let i = 0; i <= count; i++) edges[i] = minHz * ratio ** (i / count);
  edges[0] = minHz;
  edges[count] = maxHz;
  return edges;
}

/** Insertion sort of buf[0..n) then its median (n is small: ≤ a few hundred). */
function sortedMedian(buf: Float64Array, n: number): number {
  for (let i = 1; i < n; i++) {
    const v = buf[i]!;
    let j = i - 1;
    while (j >= 0 && buf[j]! > v) {
      buf[j + 1] = buf[j]!;
      j--;
    }
    buf[j + 1] = v;
  }
  if (n === 0) return 0;
  const h = n >> 1;
  return n & 1 ? buf[h]! : 0.5 * (buf[h - 1]! + buf[h]!);
}

/**
 * Spectral-flux onset picker. Each frame's flux is compared with the flux of
 * the last ONSET_WINDOW_MS (current frame excluded):
 *   threshold = max(minFlux, median + K · mean|flux − median|)
 * An onset fires when flux > threshold and the refractory time has passed.
 */
class OnsetDetector {
  private readonly values = new Float64Array(ONSET_CAPACITY);
  private readonly times = new Float64Array(ONSET_CAPACITY);
  private readonly scratch = new Float64Array(ONSET_CAPACITY);
  private head = 0;
  private count = 0;
  private lastOnsetMs = -Infinity;

  constructor(
    private readonly minFlux: number,
    private readonly refractoryMs: number,
  ) {}

  reset(): void {
    this.head = 0;
    this.count = 0;
    this.lastOnsetMs = -Infinity;
  }

  /** Onset strength 0..1 for this frame (0 = none); then records the flux. */
  update(flux: number, nowMs: number): number {
    // Gather the window, newest first (stops at the first entry that is too old).
    let n = 0;
    for (let i = 0; i < this.count; i++) {
      const idx = (this.head - 1 - i + ONSET_CAPACITY) % ONSET_CAPACITY;
      if (nowMs - this.times[idx]! > ONSET_WINDOW_MS) break;
      this.scratch[n++] = this.values[idx]!;
    }
    const median = sortedMedian(this.scratch, n);
    let dev = 0;
    for (let i = 0; i < n; i++) dev += Math.abs(this.scratch[i]! - median);
    if (n > 0) dev /= n;
    const threshold = Math.max(this.minFlux, median + ONSET_K * dev);

    let strength = 0;
    if (flux > threshold && nowMs - this.lastOnsetMs >= this.refractoryMs) {
      this.lastOnsetMs = nowMs;
      strength = ONSET_MIN_STRENGTH + (1 - ONSET_MIN_STRENGTH) * clamp01((flux - threshold) / ONSET_FULL_SCALE_DB);
    }

    this.values[this.head] = flux;
    this.times[this.head] = nowMs;
    this.head = (this.head + 1) % ONSET_CAPACITY;
    if (this.count < ONSET_CAPACITY) this.count++;
    return strength;
  }
}

/**
 * Drop detector. Short-term energy E = time-weighted mean of the frame power
 * over the last 0.5 s (a boxcar, so a steady beat gives a flat E); every 100 ms
 * E is sampled into a ring. With M = median of the samples from the last 4 s and
 * C = max of the samples taken 0.3 … 2.3 s ago (the "calm" stretch before the rise):
 *   drop ⇔ E > 2.2·M and E > 2.2·C (≥ 15 calm samples), a flux hit in the last
 *   0.4 s, M above the gate (silence → music is no drop), and none in the last 8 s.
 * Using the max of the calm stretch (not a running "calm" flag) keeps sparse hits
 * in a quiet intro, whose boxcar energy wobbles, from resetting the calm time.
 */
class DropDetector {
  private readonly shortPower = new Float64Array(DROP_SHORT_CAPACITY);
  private readonly shortWeight = new Float64Array(DROP_SHORT_CAPACITY);
  private readonly shortTimes = new Float64Array(DROP_SHORT_CAPACITY);
  private shortHead = 0;
  private shortCount = 0;
  private readonly longValues = new Float64Array(DROP_LONG_CAPACITY);
  private readonly longTimes = new Float64Array(DROP_LONG_CAPACITY);
  private readonly scratch = new Float64Array(DROP_LONG_CAPACITY);
  private longHead = 0;
  private longCount = 0;
  private lastSampleMs = -Infinity;
  private lastSpikeMs = -Infinity;
  private lastDropMs = -Infinity;

  reset(): void {
    this.shortHead = 0;
    this.shortCount = 0;
    this.longHead = 0;
    this.longCount = 0;
    this.lastSampleMs = -Infinity;
    this.lastSpikeMs = -Infinity;
    this.lastDropMs = -Infinity;
  }

  update(power: number, flux: number, dt: number, nowMs: number, silent: boolean): boolean {
    const cap = DROP_SHORT_CAPACITY;
    this.shortPower[this.shortHead] = power;
    this.shortWeight[this.shortHead] = dt > 0 ? dt : NOMINAL_DT_MS;
    this.shortTimes[this.shortHead] = nowMs;
    this.shortHead = (this.shortHead + 1) % cap;
    if (this.shortCount < cap) this.shortCount++;
    let sum = 0;
    let weight = 0;
    for (let i = 0; i < this.shortCount; i++) {
      const idx = (this.shortHead - 1 - i + cap) % cap;
      // Each frame stands for (t − dt, t]; only its overlap with (now − 0.5 s, now] counts,
      // so a hit leaving the window fades out instead of doubling E for a frame.
      const age = nowMs - this.shortTimes[idx]!;
      if (age >= DROP_SHORT_MS) break;
      const w = Math.min(this.shortWeight[idx]!, DROP_SHORT_MS - age);
      sum += this.shortPower[idx]! * w;
      weight += w;
    }
    const energy = weight > 0 ? sum / weight : power;

    // History *before* this frame, so the jump does not raise its own bar.
    let n = 0;
    let calmMax = 0;
    let calmCount = 0;
    for (let i = 0; i < this.longCount; i++) {
      const idx = (this.longHead - 1 - i + DROP_LONG_CAPACITY) % DROP_LONG_CAPACITY;
      const age = nowMs - this.longTimes[idx]!;
      if (age > DROP_LONG_MS) break;
      const v = this.longValues[idx]!;
      this.scratch[n++] = v;
      if (age >= DROP_RISE_MS && age <= DROP_RISE_MS + DROP_CALM_MS) {
        calmMax = Math.max(calmMax, v);
        calmCount++;
      }
    }
    const median = sortedMedian(this.scratch, n);
    if (nowMs - this.lastSampleMs >= DROP_LONG_SAMPLE_MS) {
      this.lastSampleMs = nowMs;
      this.longValues[this.longHead] = energy;
      this.longTimes[this.longHead] = nowMs;
      this.longHead = (this.longHead + 1) % DROP_LONG_CAPACITY;
      if (this.longCount < DROP_LONG_CAPACITY) this.longCount++;
    }

    if (flux >= DROP_FLUX_DB) this.lastSpikeMs = nowMs;
    const drop =
      !silent &&
      median >= GATE_POWER &&
      calmCount >= DROP_CALM_MIN_SAMPLES &&
      energy > DROP_RATIO * median &&
      energy > DROP_CALM_RATIO * calmMax &&
      nowMs - this.lastSpikeMs <= DROP_SPIKE_MS &&
      nowMs - this.lastDropMs >= DROP_COOLDOWN_MS;
    if (drop) this.lastDropMs = nowMs;
    return drop;
  }
}

/**
 * Per-frame pipeline:
 * 1. Bins: magnitude = 10^(dB/20) (non-finite → 0); band level L = 20·log10(mean
 *    magnitude over the band's bins). Bands narrower than a bin read the bin
 *    nearest their (geometric) centre.
 * 2. Auto-gain per band: running peak P (instant attack; released towards L in
 *    the dB domain with τ = 6 s; never below −60 dBFS; held while silent).
 *    Normalised x = (L − lo) / (P − lo) with lo = max(gate, P − range), 0 under
 *    the gate. Output y = ceiling · x^γ where sensitivity s sets
 *      range = 30 + 18·s dB, γ = 1.6 − 0.9·s, ceiling = 0.7 + 0.3·s,
 *    so a higher s lifts every level (monotonic). Bands then get an instant
 *    attack / 80 ms release envelope.
 * 3. bass / mid / high: means of the band outputs by band centre (< 150 Hz,
 *    150 Hz–2 kHz, > 2 kHz). loud: the mean band power gets the same auto-gain,
 *    then a 15 ms attack / 250 ms release envelope.
 * 4. Flux per band = max(0, L′ₜ − max(L′ₜ₋₁, L′ₜ₋₂, L′ₜ₋₃)) in dB with L′ = max(L,
 *    gate, P − 40 dB): loudness independent and blind to sub-gate noise; diffing
 *    against the max of the three previous frames (~50 ms) ignores the bounce out
 *    of a one- or two-frame dip (unsmoothed analyser noise is Rayleigh, ~5.6 dB
 *    spread per bin, and the bass bands are ~1 bin each) while a real hit still
 *    shows on its first frame.
 *    Kick uses the mean flux of the bass bands, snare that of the 1.5–6 kHz
 *    bands, drop that of all.
 * 5. Silent when the mean band power stays under the gate for > 300 ms: no
 *    onsets / drops, outputs fall with a 40 ms release and snap to 0.
 */
export class AudioAnalyzer {
  private readonly binCount: number;
  private readonly binStart = new Int32Array(AUDIO_BANDS);
  private readonly binEnd = new Int32Array(AUDIO_BANDS);
  private readonly isBass = new Uint8Array(AUDIO_BANDS);
  private readonly isMid = new Uint8Array(AUDIO_BANDS);
  private readonly isHigh = new Uint8Array(AUDIO_BANDS);
  private readonly isSnare = new Uint8Array(AUDIO_BANDS);
  /** Bands with at least one bin under Nyquist (a 16 kHz Bluetooth mic has none above 8 kHz). */
  private readonly isLive = new Uint8Array(AUDIO_BANDS);
  private readonly counts = { live: 0, bass: 0, mid: 0, high: 0, snare: 0 };

  private readonly level = new Float64Array(AUDIO_BANDS);
  private readonly prevLevel = new Float64Array(AUDIO_BANDS);
  private readonly prevLevel2 = new Float64Array(AUDIO_BANDS);
  private readonly prevLevel3 = new Float64Array(AUDIO_BANDS);
  private readonly peak = new Float64Array(AUDIO_BANDS);
  private readonly out = new Float64Array(AUDIO_BANDS);
  private totalPeak = PEAK_FLOOR_DB;
  private loud = 0;
  /** Last finite nowMs passed in, and the monotonic clock derived from it (never steps back). */
  private lastInputMs = Number.NaN;
  private clockMs = Number.NaN;
  private primed = false;
  private belowGateMs = 0;

  private range = 0;
  private gamma = 1;
  private ceiling = 1;

  private readonly kick = new OnsetDetector(KICK_MIN_FLUX_DB, KICK_REFRACTORY_MS);
  private readonly snare = new OnsetDetector(SNARE_MIN_FLUX_DB, SNARE_REFRACTORY_MS);
  private readonly drop = new DropDetector();

  constructor(options: AnalyzerOptions) {
    const fftSize = Number.isFinite(options.fftSize) && options.fftSize >= 2 ? Math.floor(options.fftSize) : 2048;
    const sampleRate = Number.isFinite(options.sampleRate) && options.sampleRate > 0 ? options.sampleRate : 48_000;
    this.binCount = fftSize >> 1;
    const binHz = sampleRate / fftSize;
    const edges = bandEdgesHz();
    for (let b = 0; b < AUDIO_BANDS; b++) {
      const lo = edges[b]!;
      const hi = edges[b + 1]!;
      // Bins whose centre frequency k·binHz lies in [lo, hi).
      let start = Math.ceil(lo / binHz);
      let end = Math.ceil(hi / binHz);
      if (end <= start) {
        // Never the DC bin (offset / rumble), even for a coarse FFT.
        start = Math.max(1, Math.round(Math.sqrt(lo * hi) / binHz));
        end = start + 1;
      }
      this.binStart[b] = Math.min(start, this.binCount);
      this.binEnd[b] = Math.min(end, this.binCount);
      if (this.binEnd[b]! <= this.binStart[b]!) continue; // above Nyquist: always 0, left out of every mean
      this.isLive[b] = 1;
      this.counts.live++;
      const centre = Math.sqrt(lo * hi);
      if (centre < BASS_MAX_HZ) this.isBass[b] = 1;
      else if (centre < MID_MAX_HZ) this.isMid[b] = 1;
      else this.isHigh[b] = 1;
      if (centre >= SNARE_MIN_HZ && centre <= SNARE_MAX_HZ) this.isSnare[b] = 1;
      this.counts.bass += this.isBass[b]!;
      this.counts.mid += this.isMid[b]!;
      this.counts.high += this.isHigh[b]!;
      this.counts.snare += this.isSnare[b]!;
    }
    this.setSensitivity(options.sensitivity);
    this.reset();
  }

  setSensitivity(value: number): void {
    const s = Number.isFinite(value) ? clamp01(value) : 0.5;
    this.range = 30 + 18 * s;
    this.gamma = 1.6 - 0.9 * s;
    this.ceiling = 0.7 + 0.3 * s;
  }

  reset(): void {
    this.level.fill(MIN_LEVEL_DB);
    this.prevLevel.fill(MIN_LEVEL_DB);
    this.prevLevel2.fill(MIN_LEVEL_DB);
    this.prevLevel3.fill(MIN_LEVEL_DB);
    this.peak.fill(PEAK_FLOOR_DB);
    this.out.fill(0);
    this.totalPeak = PEAK_FLOOR_DB;
    this.loud = 0;
    this.lastInputMs = Number.NaN;
    this.clockMs = Number.NaN;
    this.primed = false;
    this.belowGateMs = 0;
    this.kick.reset();
    this.snare.reset();
    this.drop.reset();
  }

  /**
   * dbBins = AnalyserNode.getFloatFrequencyData output: fftSize/2 bins in dBFS (may contain -Infinity).
   * nowMs = monotonic ms. A step back (or NaN) advances the internal clock by 0, so frame.t stays
   * monotonic and the onset / drop windows are not stuck in the "future" after a clock reset.
   */
  process(dbBins: Float32Array, nowMs: number): AudioFrame {
    const step = Number.isFinite(nowMs) && Number.isFinite(this.lastInputMs) ? nowMs - this.lastInputMs : 0;
    if (Number.isFinite(nowMs)) this.lastInputMs = nowMs;
    const advance = step > 0 ? step : 0;
    this.clockMs = Number.isFinite(this.clockMs) ? this.clockMs + advance : Number.isFinite(nowMs) ? nowMs : 0;
    const now = this.clockMs;
    const dt = Math.min(advance, MAX_DT_MS);

    // 1. Band levels and the mean band power.
    const n = Math.min(this.binCount, dbBins.length);
    let power = 0;
    for (let b = 0; b < AUDIO_BANDS; b++) {
      const start = this.binStart[b]!;
      const end = Math.min(this.binEnd[b]!, n);
      let sum = 0;
      for (let k = start; k < end; k++) {
        const db = dbBins[k]!;
        // NaN, ±Infinity and impossible levels count as silence.
        if (db > -200 && db <= MAX_BIN_DB) sum += 10 ** (db * 0.05);
      }
      const mean = end > start ? sum / (end - start) : 0;
      const level = mean > 0 ? Math.max(MIN_LEVEL_DB, 20 * Math.log10(mean)) : MIN_LEVEL_DB;
      this.level[b] = level;
      power += mean * mean;
    }
    power /= Math.max(1, this.counts.live);

    // 5. Silence (decided first so the auto-gain can hold through it).
    if (power < GATE_POWER) this.belowGateMs += dt;
    else this.belowGateMs = 0;
    const silent = this.belowGateMs > SILENT_AFTER_MS;

    // 2–4. Auto-gain, outputs and flux.
    const peakRelease = silent ? 0 : 1 - Math.exp(-dt / PEAK_RELEASE_MS);
    const release = 1 - Math.exp(-dt / (silent ? SILENT_RELEASE_MS : BAND_RELEASE_MS));
    let bassSum = 0;
    let midSum = 0;
    let highSum = 0;
    let bassFlux = 0;
    let snareFlux = 0;
    let allFlux = 0;
    for (let b = 0; b < AUDIO_BANDS; b++) {
      const level = this.level[b]!;
      let peak = this.peak[b]!;
      if (level > peak) peak = level;
      else peak = Math.max(PEAK_FLOOR_DB, peak - (peak - Math.max(level, GATE_DB)) * peakRelease);
      this.peak[b] = peak;

      const target = silent ? 0 : this.gained(level, peak);
      let y = this.out[b]!;
      y = target >= y ? target : y + (target - y) * release;
      if (y < SNAP && target === 0) y = 0;
      this.out[b] = y;
      if (this.isBass[b]) bassSum += y;
      else if (this.isMid[b]) midSum += y;
      else if (this.isHigh[b]) highSum += y;

      const floor = Math.max(GATE_DB, peak - FLUX_RANGE_DB);
      const prev = Math.max(this.prevLevel[b]!, this.prevLevel2[b]!, this.prevLevel3[b]!, floor);
      const flux = Math.max(0, Math.max(level, floor) - prev);
      this.prevLevel3[b] = this.prevLevel2[b]!;
      this.prevLevel2[b] = this.prevLevel[b]!;
      this.prevLevel[b] = level;
      if (this.isLive[b]) allFlux += flux;
      if (this.isBass[b]) bassFlux += flux;
      if (this.isSnare[b]) snareFlux += flux;
    }
    bassFlux /= Math.max(1, this.counts.bass);
    snareFlux /= Math.max(1, this.counts.snare);
    allFlux /= Math.max(1, this.counts.live);
    const first = !this.primed;
    if (first) {
      // No previous frame to diff against.
      bassFlux = snareFlux = allFlux = 0;
      this.primed = true;
    }

    // Loudness: same auto-gain on the mean band power, then the envelope.
    const totalDb = power > 0 ? Math.max(MIN_LEVEL_DB, 10 * Math.log10(power)) : MIN_LEVEL_DB;
    if (totalDb > this.totalPeak) this.totalPeak = totalDb;
    else this.totalPeak = Math.max(PEAK_FLOOR_DB, this.totalPeak - (this.totalPeak - Math.max(totalDb, GATE_DB)) * peakRelease);
    const loudTarget = silent ? 0 : this.gained(totalDb, this.totalPeak);
    const loudTau = silent ? SILENT_RELEASE_MS : loudTarget > this.loud ? LOUD_ATTACK_MS : LOUD_RELEASE_MS;
    this.loud += (loudTarget - this.loud) * (1 - Math.exp(-dt / loudTau));
    if (first) this.loud = loudTarget;
    if (this.loud < SNAP && loudTarget === 0) this.loud = 0;

    // Onsets (history is frozen while silent, so the threshold is sane when music resumes).
    const kick = silent ? 0 : this.kick.update(bassFlux, now);
    const snare = silent ? 0 : this.snare.update(snareFlux, now);
    const drop = this.drop.update(power, allFlux, dt, now, silent);

    const bands = new Array<number>(AUDIO_BANDS);
    for (let b = 0; b < AUDIO_BANDS; b++) bands[b] = this.out[b]!;
    return {
      t: now,
      loud: clamp01(this.loud),
      bass: clamp01(bassSum / Math.max(1, this.counts.bass)),
      mid: clamp01(midSum / Math.max(1, this.counts.mid)),
      high: clamp01(highSum / Math.max(1, this.counts.high)),
      bands,
      kick,
      snare,
      drop,
      silent,
    };
  }

  /** Auto-gain curve: level (dB) against its running peak → 0..ceiling. */
  private gained(level: number, peak: number): number {
    if (level < GATE_DB) return 0;
    const lo = Math.max(GATE_DB, peak - this.range);
    const x = peak > lo ? clamp01((level - lo) / (peak - lo)) : 0;
    return this.ceiling * x ** this.gamma;
  }
}
