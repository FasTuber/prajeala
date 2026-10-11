import { describe, expect, it } from 'vitest';

import { AudioAnalysis, bandAverage, emptyLevels } from '../src/renderer/audio/AudioAnalysis';
import { SimulatedAudio } from '../src/renderer/audio/SimulatedAudio';
import { parseOptions } from '../src/renderer/app/options';
import { audioStatusLabel } from '../src/main/tray';
import { DEFAULT_SETTINGS } from '../src/shared/settings';

const BIN_HZ = 48000 / 2048; // ≈ 23.4 Hz per bin, like a 2048-point FFT at 48 kHz
const BINS = 1024;

function spectrum(fill: (hz: number) => number): Uint8Array {
  const out = new Uint8Array(BINS);
  for (let i = 0; i < BINS; i++) out[i] = Math.max(0, Math.min(255, Math.round(fill(i * BIN_HZ) * 255)));
  return out;
}

const silence = spectrum(() => 0);
const bassHit = spectrum((hz) => (hz < 150 ? 0.9 : 0.05));
const hiss = spectrum((hz) => (hz > 3000 && hz < 8000 ? 0.7 : 0.02));

describe('bandAverage', () => {
  it('averages exactly the bins of the band, normalised to 0..1', () => {
    const s = new Uint8Array(100).fill(0);
    s[4] = 255;
    s[5] = 255;
    // binHz = 10: [40, 60) covers bins 4 and 5
    expect(bandAverage(s, 10, 40, 60)).toBe(1);
    expect(bandAverage(s, 10, 0, 40)).toBe(0);
    expect(bandAverage(s, 10, 40, 80)).toBeCloseTo(0.5, 10);
    expect(bandAverage(new Uint8Array(0), 10, 0, 100)).toBe(0);
    expect(bandAverage(s, 0, 0, 100)).toBe(0);
    // a band narrower than one bin still reads that bin
    expect(bandAverage(s, 10, 42, 44)).toBe(1);
  });
});

describe('AudioAnalysis', () => {
  it('starts inactive and stays silent on silence', () => {
    const a = new AudioAnalysis();
    expect(a.levels).toEqual(emptyLevels());
    for (let i = 0; i < 60; i++) a.update(silence, BIN_HZ, 1 / 60);
    expect(a.levels.active).toBe(true);
    expect(a.levels.level).toBe(0);
    expect(a.levels.bass).toBe(0);
    expect(a.levels.beat).toBe(0);
    expect(a.levels.bpm).toBe(0);
  });

  it('separates bass from highs and auto-levels loud input to ~1', () => {
    const a = new AudioAnalysis();
    for (let i = 0; i < 120; i++) a.update(bassHit, BIN_HZ, 1 / 60);
    expect(a.levels.bass).toBeGreaterThan(0.8);
    expect(a.levels.bass).toBeLessThanOrEqual(1.5);
    expect(a.levels.high).toBeLessThan(0.3);
    const b = new AudioAnalysis();
    for (let i = 0; i < 120; i++) b.update(hiss, BIN_HZ, 1 / 60);
    expect(b.levels.high).toBeGreaterThan(0.8);
    expect(b.levels.bass).toBeLessThan(0.3);
  });

  it('gain scales the output', () => {
    const quiet = spectrum((hz) => (hz < 150 ? 0.3 : 0.02));
    const lo = new AudioAnalysis({ gain: 0.5 });
    const hi = new AudioAnalysis({ gain: 2 });
    for (let i = 0; i < 120; i++) {
      lo.update(quiet, BIN_HZ, 1 / 60);
      hi.update(quiet, BIN_HZ, 1 / 60);
    }
    expect(hi.levels.level).toBeGreaterThan(lo.levels.level * 1.5);
    hi.setGain(0.5);
    for (let i = 0; i < 120; i++) hi.update(quiet, BIN_HZ, 1 / 60);
    expect(hi.levels.level).toBeCloseTo(lo.levels.level, 1);
  });

  it('detects beats on bass transients, with a refractory period, and estimates bpm', () => {
    const a = new AudioAnalysis();
    const dt = 1 / 60;
    const quiet = spectrum((hz) => (hz < 150 ? 0.15 : 0.03));
    let hits = 0;
    let frames = 0;
    // 0.5 s between kicks → 120 bpm; each kick lasts 3 frames.
    for (let beat = 0; beat < 8; beat++) {
      for (let i = 0; i < 30; i++) {
        const l = a.update(i < 3 ? bassHit : quiet, BIN_HZ, dt);
        frames++;
        if (l.beatHit) hits++;
        if (i === 10) expect(l.beat).toBeLessThan(1);
      }
    }
    expect(frames).toBe(240);
    expect(hits).toBeGreaterThanOrEqual(5);
    expect(hits).toBeLessThanOrEqual(8); // never more than one hit per kick
    expect(a.levels.bpm).toBeGreaterThanOrEqual(110);
    expect(a.levels.bpm).toBeLessThanOrEqual(130);
    // beat pulse decays after the hit
    a.update(quiet, BIN_HZ, 0.5);
    expect(a.levels.beat).toBe(0);
  });

  it('reset() returns to the initial state', () => {
    const a = new AudioAnalysis();
    for (let i = 0; i < 60; i++) a.update(bassHit, BIN_HZ, 1 / 60);
    a.reset();
    expect(a.levels).toEqual(emptyLevels());
  });

  it('never produces NaN for degenerate input', () => {
    const a = new AudioAnalysis();
    for (const [spec, binHz, dt] of [
      [new Uint8Array(0), BIN_HZ, 1 / 60],
      [bassHit, 0, 1 / 60],
      [bassHit, BIN_HZ, 0],
      [bassHit, BIN_HZ, 5],
    ] as const) {
      const l = a.update(spec, binHz, dt);
      for (const v of [l.level, l.bass, l.mid, l.high, l.beat, l.bpm]) expect(Number.isFinite(v)).toBe(true);
    }
  });
});

describe('SimulatedAudio', () => {
  it('produces a spectrum with energy in every band and a steady beat', () => {
    const sim = new SimulatedAudio(124);
    const a = new AudioAnalysis();
    let hits = 0;
    const dt = 1 / 60;
    const total = Math.round(8 / dt); // 8 seconds ≈ 16.5 beats at 124 bpm
    for (let i = 0; i < total; i++) {
      const s = sim.sample(dt);
      expect(s.length).toBe(1024);
      if (a.update(s, sim.binHz, dt).beatHit) hits++;
    }
    expect(hits).toBeGreaterThanOrEqual(10);
    expect(hits).toBeLessThanOrEqual(20);
    expect(a.levels.bass).toBeGreaterThan(0.05);
    expect(a.levels.mid).toBeGreaterThan(0.05);
    expect(a.levels.high).toBeGreaterThan(0.02);
    expect(a.levels.bpm).toBeGreaterThanOrEqual(115);
    expect(a.levels.bpm).toBeLessThanOrEqual(135);
  });
});

describe('renderer options: ?audio=', () => {
  it('maps the url flag onto settings overrides', () => {
    expect(parseOptions('').audioSim).toBe(false);
    expect(parseOptions('').settingsOverrides.audioReactive).toBeUndefined();
    const sim = parseOptions('?audio=sim');
    expect(sim.audioSim).toBe(true);
    expect(sim.settingsOverrides.audioReactive).toBe(true);
    expect(parseOptions('?audio=system').settingsOverrides).toMatchObject({ audioReactive: true, audioSource: 'system' });
    expect(parseOptions('?audio=mic').settingsOverrides).toMatchObject({ audioReactive: true, audioSource: 'microphone' });
    expect(parseOptions('?audio=0').settingsOverrides.audioReactive).toBe(false);
    expect(parseOptions('?gain=2').settingsOverrides.audioGain).toBe(2);
  });
});

describe('audioStatusLabel', () => {
  it('describes every state', () => {
    const on = { ...DEFAULT_SETTINGS, audioReactive: true };
    expect(audioStatusLabel(DEFAULT_SETTINGS, null)).toMatch(/off/);
    expect(audioStatusLabel(on, null)).toMatch(/starting/);
    expect(audioStatusLabel(on, { state: 'active', source: 'microphone' })).toMatch(/listening to the microphone/);
    expect(audioStatusLabel(on, { state: 'active', source: 'system', message: 'simulated audio' })).toMatch(/system audio.*simulated/);
    expect(audioStatusLabel(on, { state: 'denied', source: 'microphone' })).toMatch(/denied/);
    expect(audioStatusLabel(on, { state: 'unavailable', source: 'microphone' })).toMatch(/no audio input/);
    expect(audioStatusLabel(on, { state: 'error', source: 'microphone', message: 'busy' })).toMatch(/error — busy/);
  });
});
