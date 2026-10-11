/**
 * Fake "music" for the mock page, screenshots and smoke runs: a 4/4 kick at
 * ~124 bpm, a bass line, a pad in the mids and hi-hats, written as byte
 * magnitudes into a spectrum buffer exactly like an AnalyserNode would.
 */
import { noise1 } from '../util/noise';

export class SimulatedAudio {
  readonly sampleRate = 48000;
  readonly fftSize = 2048;
  private readonly bins: Uint8Array;
  private t = 0;

  constructor(private readonly bpm = 124) {
    this.bins = new Uint8Array(this.fftSize / 2);
  }

  get binHz(): number {
    return this.sampleRate / this.fftSize;
  }

  /** Advances the fake track by `dt` seconds and returns the spectrum. */
  sample(dt: number): Uint8Array {
    this.t += dt;
    const beatLen = 60 / this.bpm;
    const beatPhase = (this.t % beatLen) / beatLen;
    const bar = Math.floor(this.t / (beatLen * 4));
    const kick = Math.exp(-beatPhase * 9) * (bar % 8 === 7 && beatPhase > 0.5 ? 0.3 : 1);
    const hat = Math.exp(-((this.t % (beatLen / 2)) / (beatLen / 2)) * 14) * 0.6;
    const pad = 0.35 + 0.25 * Math.sin(this.t * 0.7) + 0.15 * noise1(this.t * 1.3, 5);
    const bassNote = 0.5 + 0.5 * Math.sin(this.t * 2.1);
    const bins = this.bins;
    const binHz = this.binHz;
    for (let i = 0; i < bins.length; i++) {
      const f = i * binHz;
      let v = 0;
      if (f < 160) v += kick * (1 - f / 180) * 0.95 + bassNote * 0.35 * Math.exp(-((f - 70) * (f - 70)) / 900);
      if (f >= 120 && f < 2500) v += pad * 0.55 * Math.exp(-((Math.log(f) - Math.log(440)) ** 2) * 1.1);
      if (f >= 2500) v += hat * 0.7 * Math.exp(-(f - 6000) * (f - 6000) / 1.2e7);
      v += 0.03 * noise1(this.t * 40 + i * 0.37, 77);
      bins[i] = Math.max(0, Math.min(255, Math.round(v * 255)));
    }
    return bins;
  }
}
