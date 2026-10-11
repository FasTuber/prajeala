import { describe, expect, it } from 'vitest';

import { AudioAnalyzer, bandEdgesHz } from '../src/shared/audio';
import { AUDIO_BANDS, type AudioFrame } from '../src/shared/audio-contract';

// Synthetic spectra: 48 kHz, fftSize 2048 → 1024 bins of 23.4 Hz, ~60 fps.
const SAMPLE_RATE = 48_000;
const FFT_SIZE = 2048;
const BIN_COUNT = FFT_SIZE / 2;
const BIN_HZ = SAMPLE_RATE / FFT_SIZE;
const FRAME_MS = 1000 / 60;

/** Deterministic PRNG (mulberry32) so jitter is reproducible. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A sound occupying [lo, hi) Hz at a flat level (dBFS per bin). */
interface Part {
  lo: number;
  hi: number;
  db: number;
}

const BASS = { lo: 0, hi: 150 };
const MID = { lo: 150, hi: 1500 };
const SNARE = { lo: 1500, hi: 6000 };
const HATS = { lo: 7000, hi: 16_000 };

/**
 * Builds getFloatFrequencyData-style bins: power-sum of the parts, -Infinity where nothing plays.
 * jitterDb adds uniform ±dB; rayleigh adds what an unsmoothed analyser really shows on noise-like
 * sound (|X|² ~ Exp(1): ~5.6 dB spread per bin, independent from frame to frame).
 */
function spectrum(parts: readonly Part[], jitterDb = 0, rand: () => number = Math.random, rayleigh = false): Float32Array {
  const bins = new Float32Array(BIN_COUNT);
  for (let k = 0; k < BIN_COUNT; k++) {
    const hz = k * BIN_HZ;
    let power = 0;
    for (const p of parts) if (hz >= p.lo && hz < p.hi && Number.isFinite(p.db)) power += 10 ** (p.db / 10);
    if (power > 0 && rayleigh) power *= -Math.log(1 - rand());
    bins[k] = power > 0 ? 10 * Math.log10(power) + (rand() * 2 - 1) * jitterDb : -Infinity;
  }
  return bins;
}

/** Level of a decaying burst train: peak at each hit, exponential (τ) decay, never under floor. */
function burst(t: number, periodMs: number, offsetMs: number, peakDb: number, tauMs: number, floorDb = -Infinity): number {
  if (t < offsetMs) return floorDb;
  const since = (t - offsetMs) % periodMs;
  return Math.max(floorDb, peakDb - (8.686 * since) / tauMs);
}

/** Hit times of a burst train in [from, to). */
function hits(periodMs: number, offsetMs: number, from: number, to: number): number[] {
  const out: number[] = [];
  for (let t = offsetMs; t < to; t += periodMs) if (t >= from) out.push(t);
  return out;
}

interface Sim {
  frames: AudioFrame[];
  times: number[];
}

/** Runs the analyzer at ~60 fps (± jitterMs) over [startMs, endMs), appending to sim. */
function simulate(
  analyzer: AudioAnalyzer,
  scene: (t: number) => readonly Part[],
  endMs: number,
  opts: { startMs?: number; jitterMs?: number; jitterDb?: number; rayleigh?: boolean; seed?: number; sim?: Sim } = {},
): Sim {
  const sim = opts.sim ?? { frames: [], times: [] };
  const rand = rng(opts.seed ?? 1);
  const jitterMs = opts.jitterMs ?? 0;
  for (let i = 0; ; i++) {
    const nominal = (opts.startMs ?? 0) + i * FRAME_MS;
    if (nominal >= endMs) break;
    const t = nominal + (i === 0 ? 0 : (rand() * 2 - 1) * jitterMs);
    sim.frames.push(analyzer.process(spectrum(scene(t), opts.jitterDb ?? 0, rand, opts.rayleigh), t));
    sim.times.push(t);
  }
  return sim;
}

/** Matches onset frames to hit times: a hit counts when detected on its first frame or the next. */
function score(sim: Sim, key: 'kick' | 'snare', hitTimes: readonly number[], from = 0, to = Infinity) {
  const expected = new Set<number>();
  let detected = 0;
  for (const h of hitTimes) {
    const first = sim.times.findIndex((t) => t >= h);
    if (first < 0) continue;
    expected.add(first).add(first + 1);
    if ((sim.frames[first]?.[key] ?? 0) > 0 || (sim.frames[first + 1]?.[key] ?? 0) > 0) detected++;
  }
  let falses = 0;
  sim.frames.forEach((f, i) => {
    const t = sim.times[i]!;
    if (t >= from && t < to && f[key] > 0 && !expected.has(i)) falses++;
  });
  return { detected, falses };
}

const make = (sensitivity = 0.5): AudioAnalyzer => new AudioAnalyzer({ sampleRate: SAMPLE_RATE, fftSize: FFT_SIZE, sensitivity });

/** A 120 BPM groove: kick every 500 ms, steady pad, off-beat hats; `gain` shifts everything (dB). */
const groove =
  (gain = 0, kickOffset = 100) =>
  (t: number): Part[] => [
    { ...BASS, db: burst(t, 500, kickOffset, gain, 120, gain - 36) },
    { ...MID, db: gain - 24 },
    { ...HATS, db: burst(t, 250, kickOffset + 125, gain - 24, 30, gain - 60) },
  ];

describe('bandEdgesHz', () => {
  it('returns 33 increasing log-spaced edges from 30 Hz to 16 kHz', () => {
    const edges = bandEdgesHz();
    expect(edges).toHaveLength(AUDIO_BANDS + 1);
    expect(edges[0]).toBe(30);
    expect(edges[AUDIO_BANDS]).toBe(16_000);
    for (let i = 1; i < edges.length; i++) expect(edges[i]!).toBeGreaterThan(edges[i - 1]!);
    // log spacing: constant ratio
    const r = edges[1]! / edges[0]!;
    expect(edges[20]! / edges[19]!).toBeCloseTo(r, 9);
    expect(bandEdgesHz(4, 100, 1600)).toEqual([100, 200, 400, 800, 1600].map((v) => expect.closeTo(v, 9) as unknown as number));
  });
});

describe('AudioAnalyzer', () => {
  it('detects a 120 BPM kick within a frame, with few false kicks', () => {
    const sim = simulate(make(), groove(-6), 20_000, { jitterMs: 2, jitterDb: 0.5 });
    const kicks = hits(500, 100, 0, 20_000);
    const { detected, falses } = score(sim, 'kick', kicks);
    expect(detected / kicks.length).toBeGreaterThanOrEqual(0.9);
    expect(falses).toBeLessThanOrEqual(2);
    // hats are not snares, kicks are not snares
    expect(sim.frames.filter((f) => f.snare > 0).length).toBeLessThanOrEqual(2);
    for (const f of sim.frames) {
      expect(f.kick).toBeGreaterThanOrEqual(0);
      expect(f.kick).toBeLessThanOrEqual(1);
    }
    expect(Math.max(...sim.frames.map((f) => f.bass))).toBeGreaterThan(0.5);
    expect(sim.frames.some((f) => f.drop)).toBe(false);
  });

  it('detects snare/clap bursts as snare, not kick', () => {
    const snareOnly = (t: number): Part[] => [
      { ...MID, db: -30 },
      { ...SNARE, db: burst(t, 500, 350, -10, 60, -60) },
    ];
    const sim = simulate(make(), snareOnly, 12_000, { jitterMs: 2, seed: 7 });
    const snares = hits(500, 350, 0, 12_000);
    expect(score(sim, 'snare', snares).detected / snares.length).toBeGreaterThanOrEqual(0.9);
    expect(sim.frames.filter((f) => f.kick > 0)).toHaveLength(0);

    // Backbeat: kicks on 1 and 3, claps on 2 and 4 — each lands in its own detector.
    const backbeat = (t: number): Part[] => [...groove(-6, 100)(t), { ...SNARE, db: burst(t, 1000, 600, -10, 60, -60) }];
    const both = simulate(make(), backbeat, 12_000, { jitterMs: 2, seed: 9 });
    const kickScore = score(both, 'kick', hits(500, 100, 0, 12_000));
    const snareScore = score(both, 'snare', hits(1000, 600, 0, 12_000));
    expect(kickScore.detected / 24).toBeGreaterThanOrEqual(0.9);
    expect(snareScore.detected / 12).toBeGreaterThanOrEqual(0.9);
    expect(kickScore.falses).toBeLessThanOrEqual(1);
    expect(snareScore.falses).toBeLessThanOrEqual(1);
  });

  it('finds no onsets in steady pink-ish noise after the first 2 s', () => {
    // -3 dB/octave, built per bin once (a Part per bin made this test take seconds and risk the timeout).
    const base = new Float32Array(BIN_COUNT);
    for (let k = 0; k < BIN_COUNT; k++) base[k] = -24 - 10 * Math.log10(Math.max(k * BIN_HZ, 20) / 1000);
    const a = make();
    const rand = rng(3);
    const bins = new Float32Array(BIN_COUNT);
    const late: AudioFrame[] = [];
    for (let i = 0; i * FRAME_MS < 15_000; i++) {
      const t = i * FRAME_MS + (i === 0 ? 0 : (rand() * 2 - 1) * 3);
      for (let k = 0; k < BIN_COUNT; k++) bins[k] = base[k]! + (rand() * 2 - 1) * 1.5;
      const f = a.process(bins, t);
      if (t >= 2000) late.push(f);
    }
    expect(late.filter((f) => f.kick > 0 || f.snare > 0)).toHaveLength(0);
    expect(late.some((f) => f.drop)).toBe(false);
    expect(late.every((f) => !f.silent)).toBe(true);
  });

  it('stays quiet on unsmoothed (Rayleigh) fan / rain noise and still catches kicks through it', () => {
    // -3 dB/octave noise, built per bin directly (a Part per bin is too slow for 60 s of frames).
    for (const seed of [1, 2, 3]) {
      const a = make();
      const rand = rng(seed);
      const bins = new Float32Array(BIN_COUNT);
      let onsets = 0;
      for (let t = 0; t < 20_000; t += FRAME_MS) {
        for (let k = 0; k < BIN_COUNT; k++) bins[k] = -30 - 10 * Math.log10(Math.max(k * BIN_HZ, 20) / 1000) + 10 * Math.log10(-Math.log(1 - rand()));
        const f = a.process(bins, t);
        if (t >= 2000 && (f.kick > 0 || f.snare > 0 || f.drop)) onsets++;
      }
      expect(onsets).toBe(0);
    }
    const kicks = hits(500, 100, 0, 15_000);
    for (const seed of [1, 2, 3]) {
      const sim = simulate(make(), groove(-6), 15_000, { jitterMs: 2, rayleigh: true, seed });
      const { detected, falses } = score(sim, 'kick', kicks);
      expect(detected / kicks.length).toBeGreaterThanOrEqual(0.9);
      expect(falses).toBeLessThanOrEqual(2);
    }
  });

  it('goes silent on -Infinity bins and picks the beat up again', () => {
    const a = make();
    const sim = simulate(a, groove(-12), 5000);
    simulate(a, () => [], 8000, { startMs: 5000, sim });
    simulate(a, groove(-12, 8100), 13_000, { startMs: 8000, sim });

    sim.frames.forEach((f, i) => {
      const t = sim.times[i]!;
      if (t < 6000 || t >= 8000) return;
      expect(f.silent).toBe(true);
      expect(f.kick + f.snare + f.loud + f.bass + f.mid + f.high).toBe(0);
      expect(f.bands.every((v) => v === 0)).toBe(true);
      expect(f.drop).toBe(false);
    });
    // silent only after ~300 ms of nothing
    expect(sim.frames[sim.times.findIndex((t) => t >= 5150)]!.silent).toBe(false);

    const resumed = sim.frames.findIndex((f, i) => sim.times[i]! >= 8000 && f.kick > 0);
    expect(resumed).toBeGreaterThan(0);
    expect(sim.times[resumed]!).toBeLessThan(10_000);
    expect(sim.frames[resumed]!.silent).toBe(false);
    expect(score(sim, 'kick', hits(500, 8100, 8000, 13_000), 8000).detected).toBeGreaterThanOrEqual(9);
    expect(sim.frames.some((f) => f.drop)).toBe(false);
  });

  it('auto-gains quiet (-40 dB) and loud (-6 dB) versions alike', () => {
    const kicks = hits(500, 100, 0, 10_000);
    for (const gain of [-40, -6]) {
      const sim = simulate(make(), groove(gain), 10_000, { jitterMs: 2, seed: 11 });
      expect(score(sim, 'kick', kicks).detected / kicks.length).toBeGreaterThanOrEqual(0.9);
      const late = sim.frames.slice(60);
      expect(Math.max(...late.map((f) => Math.max(...f.bands)))).toBeGreaterThan(0.5);
      expect(Math.max(...late.map((f) => f.bass))).toBeGreaterThan(0.5);
      expect(Math.max(...late.map((f) => f.loud))).toBeGreaterThan(0.5);
    }
  });

  it('flags exactly one drop when a loud full-band section follows quiet hats', () => {
    const scene = (t: number): Part[] =>
      t < 10_000
        ? [{ ...HATS, db: burst(t, 250, 0, -45, 30, -80) }]
        : [
            { ...BASS, db: burst(t, 500, 10_000, -8, 120, -44) },
            { ...MID, db: -24 },
            { ...SNARE, db: burst(t, 1000, 10_500, -14, 60, -60) },
            { ...HATS, db: burst(t, 250, 10_125, -20, 30, -60) },
          ];
    const sim = simulate(make(), scene, 25_000, { jitterMs: 2, jitterDb: 0.5, seed: 5 });
    const drops = sim.times.filter((_, i) => sim.frames[i]!.drop);
    expect(drops).toHaveLength(1);
    expect(drops[0]!).toBeGreaterThanOrEqual(10_000);
    expect(drops[0]!).toBeLessThanOrEqual(10_600);
  });

  it('flags a quiet verse jumping into a loud chorus, but not a gradual build-up', () => {
    const jump = simulate(make(), (t) => groove(t < 10_000 ? -28 : -6)(t), 22_000, { jitterMs: 2, jitterDb: 0.5, seed: 6 });
    const drops = jump.times.filter((_, i) => jump.frames[i]!.drop);
    expect(drops).toHaveLength(1);
    expect(drops[0]!).toBeGreaterThanOrEqual(10_000);
    expect(drops[0]!).toBeLessThanOrEqual(10_600);

    // +20 dB over 10 s
    const build = (t: number): Part[] => groove(-30 + Math.min(20, (20 * Math.max(0, t - 4000)) / 10_000))(t);
    const sim = simulate(make(), build, 20_000, { jitterMs: 2, jitterDb: 0.5, seed: 6 });
    expect(sim.frames.some((f) => f.drop)).toBe(false);
  });

  it('raises levels monotonically with sensitivity', () => {
    const means = [0, 0.5, 1].map((s) => {
      const sim = simulate(make(s), groove(-12), 6000, { seed: 2 });
      let sum = 0;
      for (const f of sim.frames.slice(60)) sum += f.bands.reduce((a, v) => a + v, 0) / AUDIO_BANDS;
      return sum;
    });
    expect(means[1]!).toBeGreaterThan(means[0]!);
    expect(means[2]!).toBeGreaterThan(means[1]!);

    // setSensitivity changes a running analyzer the same way
    const a = make(0);
    simulate(a, groove(-12), 3000, { seed: 2 });
    const before = a.process(spectrum(groove(-12)(3050)), 3050).bands.reduce((x, v) => x + v, 0);
    a.setSensitivity(1);
    const after = a.process(spectrum(groove(-12)(3050)), 3066).bands.reduce((x, v) => x + v, 0);
    expect(after).toBeGreaterThan(before);
  });

  it('does not let a +Infinity or garbage bin pin the auto-gain', () => {
    for (const bad of [Infinity, 1e30]) {
      const a = make();
      const sim = simulate(a, groove(-12), 5000);
      const peakBefore = Math.max(...sim.frames.slice(-60).map((f) => f.bass));
      const bins = spectrum(groove(-12)(5000));
      bins[3] = bad;
      bins[100] = bad;
      a.process(bins, 5000);
      const after = simulate(a, groove(-12), 7000, { startMs: 5000 + FRAME_MS });
      expect(Math.max(...after.frames.map((f) => f.bass))).toBeGreaterThan(peakBefore - 0.05);
      expect(Math.max(...after.frames.map((f) => f.loud))).toBeGreaterThan(0.75);
    }
  });

  it('keeps t monotonic and keeps detecting when the clock steps back', () => {
    const a = make();
    const sim = simulate(a, groove(-12), 15_000, { startMs: 10_000 });
    // The host clock restarts at 0: the beat must carry on, not wait 15 s to "catch up".
    simulate(a, groove(-12), 4000, { sim });
    for (let i = 1; i < sim.frames.length; i++) expect(sim.frames[i]!.t).toBeGreaterThanOrEqual(sim.frames[i - 1]!.t);
    const restart = sim.times.findIndex((t, i) => i > 0 && t < sim.times[i - 1]!);
    const kicksAfter = sim.frames.slice(restart).filter((f) => f.kick > 0).length;
    expect(kicksAfter).toBeGreaterThanOrEqual(6);
  });

  it('leaves bands above Nyquist out of the means (16 kHz Bluetooth mic)', () => {
    const flat = (rate: number): AudioFrame => {
      const a = new AudioAnalyzer({ sampleRate: rate, fftSize: FFT_SIZE, sensitivity: 0.5 });
      const bins = new Float32Array(BIN_COUNT).fill(-40);
      let f = a.process(bins, 0);
      for (let i = 1; i < 30; i++) f = a.process(bins, i * FRAME_MS);
      return f;
    };
    const wide = flat(48_000);
    const narrow = flat(16_000);
    expect(narrow.bands[AUDIO_BANDS - 1]).toBe(0);
    expect(narrow.high).toBeCloseTo(wide.high, 2);
    expect(narrow.loud).toBeCloseTo(wide.loud, 2);
  });

  it('tolerates NaN / -Infinity bins, short arrays and irregular time steps', () => {
    const a = make();
    const rand = rng(4);
    const steps = [16.7, 16.7, 0, 500, 3, 33, -5, 16.7, 2500, 16.7];
    let t = 1000;
    for (let i = 0; i < 300; i++) {
      t += steps[i % steps.length]!;
      const bins = spectrum(groove(-10)(t), 1, rand);
      if (i % 3 === 0) bins[(i * 37) % BIN_COUNT] = Number.NaN;
      if (i % 5 === 0) bins[(i * 11) % BIN_COUNT] = Infinity;
      const input = i % 7 === 0 ? bins.subarray(0, 300) : bins;
      const f = a.process(input, i === 150 ? Number.NaN : t);
      for (const v of [f.loud, f.bass, f.mid, f.high, f.kick, f.snare, ...f.bands]) {
        expect(Number.isFinite(v)).toBe(true);
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(1);
      }
      expect(f.bands).toHaveLength(AUDIO_BANDS);
    }
    a.reset();
    const f = a.process(new Float32Array(BIN_COUNT).fill(-Infinity), 0);
    expect(f.kick + f.loud).toBe(0);
  });
});
