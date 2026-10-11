/**
 * Synthetic "music" for the mock renderer (?audio=demo): a 120 BPM loop with
 * kicks on every beat, a snare on 2 and 4, hats on the off-beats, an 8-bar
 * quiet break every 24 s and a drop after it. Produces AudioFrames directly so
 * Ritmul Focului's visuals can be tuned (and filmed) in a plain browser.
 */
import { AUDIO_BANDS, AUDIO_FRAME_HZ, type AudioFrame } from '../../shared/audio-contract';

const BEAT_MS = 500;
const CYCLE_MS = 24_000;
const BREAK_FROM = 16_000;

export function startAudioDemo(emit: (frame: AudioFrame) => void): () => void {
  const start = performance.now();
  let lastBeat = -1;
  let lastHalf = -1;
  let loud = 0;
  let dropFired = -1;
  const timer = window.setInterval(() => {
    const now = performance.now();
    const t = now - start;
    const inCycle = t % CYCLE_MS;
    const cycle = Math.floor(t / CYCLE_MS);
    const inBreak = inCycle >= BREAK_FROM;
    const beat = Math.floor(t / BEAT_MS);
    const half = Math.floor(t / (BEAT_MS / 2));
    const sinceBeat = t - beat * BEAT_MS;
    const level = inBreak ? 0.25 : 1;
    const kick = !inBreak && beat !== lastBeat ? 0.85 + 0.15 * Math.random() : 0;
    const snare = !inBreak && beat !== lastBeat && beat % 2 === 1 ? 0.8 : 0;
    const hat = half !== lastHalf && half % 2 === 1 ? 1 : 0;
    lastBeat = beat;
    lastHalf = half;
    const drop = !inBreak && inCycle < 200 && cycle > 0 && dropFired !== cycle;
    if (drop) dropFired = cycle;
    const decay = Math.exp(-sinceBeat / 140);
    const bass = (inBreak ? 0.1 : 0.35 + 0.6 * decay) * level;
    const mid = (0.35 + 0.25 * Math.sin(t / 900)) * level;
    const high = Math.min(1, (0.25 + (hat ? 0.6 : 0) + snare * 0.5) * (inBreak ? 0.8 : 1));
    loud = Math.max(loud * 0.92, (bass + mid + high) / 2.4);
    const bands = new Array<number>(AUDIO_BANDS);
    for (let i = 0; i < AUDIO_BANDS; i++) {
      const x = i / (AUDIO_BANDS - 1);
      const base = x < 0.25 ? bass * (1 - x) : x < 0.65 ? mid * (0.8 + 0.4 * Math.sin(t / 300 + i)) : high * (1.1 - x * 0.5);
      bands[i] = Math.max(0, Math.min(1, base + (Math.random() - 0.5) * 0.08));
    }
    emit({ t: now, loud: Math.min(1, loud), bass, mid, high, bands, kick, snare, drop, silent: false });
  }, 1000 / AUDIO_FRAME_HZ);
  return () => window.clearInterval(timer);
}
