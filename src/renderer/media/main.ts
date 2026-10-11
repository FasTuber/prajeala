/**
 * Media host page (hidden window, src/main/media-host.ts): captures system
 * audio (getDisplayMedia + loopback supplied by main) or the microphone, runs
 * it through an AnalyserNode and AudioAnalyzer, and sends one AudioFrame per
 * 1/AUDIO_FRAME_HZ s to main (paced on a TickGrid: setInterval would round
 * 16.67 ms down to 16 ms). Nothing is ever connected to the destination,
 * so the captured sound is never played back.
 */
import type { AudioStatus } from '../../shared/audio-contract';
import { AudioAnalyzer } from '../../shared/audio';
import type { MediaStartRequest } from '../../shared/ipc';
import {
  CaptureStatusTracker,
  clampSensitivity,
  statusForCaptureError,
  statusForEndedTrack,
  TickGrid,
  type MediaSource,
} from '../../shared/media-status';

const FFT_SIZE = 2048;
const IS_MAC = /Macintosh|Mac OS X/.test(navigator.userAgent);

interface Capture {
  source: MediaSource;
  stream: MediaStream;
  ctx: AudioContext;
  node: MediaStreamAudioSourceNode;
  analyser: AnalyserNode;
  analyzer: AudioAnalyzer;
  bins: Float32Array<ArrayBuffer>;
  tracker: CaptureStatusTracker;
  grid: TickGrid;
  timer: ReturnType<typeof setTimeout> | null;
}

const media = window.prajealaMedia;
let capture: Capture | null = null;
/** Bumped on every start/stop so a late async step of an older start backs off. */
let generation = 0;
let sensitivity = 0.5;
let lastReport = '';

function report(status: AudioStatus, source: MediaSource | null, detail?: string): void {
  const key = `${status}|${source ?? ''}|${detail ?? ''}`;
  if (key === lastReport) return;
  lastReport = key;
  media.sendStatus(detail ? { status, source, detail } : { status, source });
}

function stopStream(stream: MediaStream): void {
  for (const track of stream.getTracks()) {
    try {
      track.stop();
    } catch {
      /* already stopped */
    }
  }
}

function openStream(source: MediaSource): Promise<MediaStream> {
  if (source === 'mic') {
    return navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      video: false,
    });
  }
  // Main's display-media handler answers with the first screen + loopback audio.
  return navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
}

function teardown(): void {
  const c = capture;
  if (!c) return;
  capture = null;
  if (c.timer !== null) clearTimeout(c.timer);
  c.timer = null;
  try {
    c.node.disconnect();
  } catch {
    /* not connected */
  }
  stopStream(c.stream);
  c.analyzer.reset();
  void c.ctx.close().catch(() => undefined);
}

function schedule(c: Capture): void {
  c.timer = setTimeout(() => tick(c), c.grid.next(performance.now()));
}

function tick(c: Capture): void {
  c.timer = null;
  if (capture !== c) return;
  c.analyser.getFloatFrequencyData(c.bins);
  const now = performance.now();
  const frame = c.analyzer.process(c.bins, now);
  media.sendFrame(frame);
  const change = c.tracker.frame(frame.silent, now);
  if (change) report(change, c.source);
  schedule(c);
}

async function start(req: MediaStartRequest): Promise<void> {
  const gen = ++generation;
  teardown();
  const source: MediaSource = req.source === 'mic' ? 'mic' : 'system';
  sensitivity = clampSensitivity(req.sensitivity);
  report('starting', source);

  let stream: MediaStream;
  try {
    stream = await openStream(source);
  } catch (err) {
    if (gen !== generation) return;
    const s = statusForCaptureError(err);
    report(s.status, source, s.detail);
    return;
  }
  if (gen !== generation) {
    stopStream(stream);
    return;
  }

  // Only the audio is wanted: drop the screen video right away.
  for (const track of stream.getVideoTracks()) {
    track.stop();
    stream.removeTrack(track);
  }
  const audioTracks = stream.getAudioTracks();
  if (audioTracks.length === 0) {
    stopStream(stream);
    report(
      'unsupported',
      source,
      source === 'system' ? 'system audio capture is not available on this system' : 'no audio track',
    );
    return;
  }

  // A track that ends by itself (permission revoked, sharing stopped, device gone).
  for (const track of audioTracks) {
    track.addEventListener('ended', () => {
      if (gen !== generation) return;
      generation++;
      teardown();
      stopStream(stream);
      const s = statusForEndedTrack(source, IS_MAC);
      report(s.status, source, s.detail);
    });
  }

  let ctx: AudioContext | null = null;
  try {
    ctx = new AudioContext();
    await ctx.resume();
    if (gen !== generation) {
      stopStream(stream);
      void ctx.close().catch(() => undefined);
      return;
    }
    const node = ctx.createMediaStreamSource(stream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = FFT_SIZE;
    analyser.smoothingTimeConstant = 0;
    node.connect(analyser); // never to ctx.destination: no echo
    const c: Capture = {
      source,
      stream,
      ctx,
      node,
      analyser,
      analyzer: new AudioAnalyzer({ sampleRate: ctx.sampleRate, fftSize: FFT_SIZE, sensitivity }),
      bins: new Float32Array(analyser.frequencyBinCount),
      tracker: new CaptureStatusTracker(),
      grid: new TickGrid(),
      timer: null,
    };
    capture = c;
    schedule(c);
  } catch (err) {
    stopStream(stream);
    if (ctx) void ctx.close().catch(() => undefined);
    if (gen !== generation) return;
    report('error', source, err instanceof Error ? err.message : String(err));
    return;
  }
}

function stop(): void {
  generation++;
  teardown();
  report('off', null);
}

media.onStart((req) => {
  void start(req).catch((err: unknown) => {
    report('error', req.source === 'mic' ? 'mic' : 'system', err instanceof Error ? err.message : String(err));
  });
});
media.onStop(stop);
media.onSensitivity((value) => {
  sensitivity = clampSensitivity(value);
  capture?.analyzer.setSensitivity(sensitivity);
});
window.addEventListener('pagehide', () => {
  generation++;
  teardown();
});
