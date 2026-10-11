/**
 * Owns the audio capture (microphone, or system loopback where the host
 * provides it) and feeds an AnalyserNode into AudioAnalysis every frame.
 * Nothing here throws into the frame loop: failures become an AudioStatus.
 */
import type { AudioSource, AudioStatus } from '../../shared/ipc';
import { AudioAnalysis, emptyLevels, type AudioLevels } from './AudioAnalysis';
import { SimulatedAudio } from './SimulatedAudio';

export type AudioStatusListener = (status: AudioStatus) => void;

export interface AudioReactorOptions {
  /** `?audio=sim`: never touch real devices, play the fake track. */
  simulate: boolean;
  /** The host can deliver system audio through getDisplayMedia (Windows loopback). */
  loopbackAvailable: boolean;
  onStatus: AudioStatusListener;
}

export class AudioReactor {
  readonly levels: AudioLevels = emptyLevels();
  private readonly analysis = new AudioAnalysis({ gain: 1 });
  private context: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private stream: MediaStream | null = null;
  private spectrum: Uint8Array<ArrayBuffer> = new Uint8Array(0);
  private simulated: SimulatedAudio | null = null;
  private source: AudioSource = 'microphone';
  private generation = 0;
  private status: AudioStatus = { state: 'off', source: 'microphone' };
  private starting = false;

  constructor(private readonly options: AudioReactorOptions) {}

  get running(): boolean {
    return this.status.state === 'active';
  }

  get currentStatus(): AudioStatus {
    return this.status;
  }

  setGain(gain: number): void {
    this.analysis.setGain(gain);
  }

  /** Starts (or restarts) capture from `source`. Safe to call repeatedly. */
  async start(source: AudioSource): Promise<void> {
    if (this.starting && this.source === source) return;
    const gen = ++this.generation;
    this.source = source;
    this.stopInternal();
    this.starting = true;
    this.setStatus({ state: 'starting', source });
    try {
      if (this.options.simulate) {
        this.simulated = new SimulatedAudio();
        this.setStatus({ state: 'active', source, message: 'simulated audio' });
        return;
      }
      const stream = await this.openStream(source);
      if (gen !== this.generation) {
        stopStream(stream);
        return;
      }
      const context = new AudioContext({ latencyHint: 'interactive' });
      const analyser = context.createAnalyser();
      analyser.fftSize = 2048;
      analyser.smoothingTimeConstant = 0.55;
      const node = context.createMediaStreamSource(stream);
      node.connect(analyser); // analyser is not connected to the destination: nothing is played back
      this.context = context;
      this.analyser = analyser;
      this.stream = stream;
      this.spectrum = new Uint8Array(analyser.frequencyBinCount);
      if (context.state === 'suspended') await context.resume().catch(() => undefined);
      const track = stream.getAudioTracks()[0];
      track?.addEventListener('ended', () => {
        if (this.stream === stream) this.setStatus({ state: 'error', source, message: 'audio device disconnected' });
      });
      const label = track?.label ? ` (${track.label})` : '';
      this.setStatus({ state: 'active', source: this.status.source, message: `listening${label}` });
    } catch (err) {
      if (gen !== this.generation) return;
      const { state, message } = describeFailure(err);
      this.setStatus({ state, source, message });
    } finally {
      if (gen === this.generation) this.starting = false;
    }
  }

  stop(): void {
    this.generation++;
    this.starting = false;
    this.stopInternal();
    this.setStatus({ state: 'off', source: this.source });
  }

  /** Per frame: refreshes `levels`. Cheap when nothing is running. */
  update(dt: number): AudioLevels {
    if (this.simulated) {
      const spectrum = this.simulated.sample(dt);
      Object.assign(this.levels, this.analysis.update(spectrum, this.simulated.binHz, dt));
      return this.levels;
    }
    const analyser = this.analyser;
    const context = this.context;
    if (!analyser || !context || this.status.state !== 'active') {
      if (this.levels.active) Object.assign(this.levels, emptyLevels());
      return this.levels;
    }
    analyser.getByteFrequencyData(this.spectrum);
    const binHz = context.sampleRate / analyser.fftSize;
    Object.assign(this.levels, this.analysis.update(this.spectrum, binHz, dt));
    return this.levels;
  }

  private async openStream(source: AudioSource): Promise<MediaStream> {
    const md = navigator.mediaDevices;
    if (!md?.getUserMedia) throw new Error('mediaDevices unavailable');
    if (source === 'system') {
      if (this.options.loopbackAvailable && typeof md.getDisplayMedia === 'function') {
        try {
          // Chromium insists on a video track; the host's display-media handler supplies a
          // dummy screen source plus loopback audio, and we drop the video right away.
          const stream = await md.getDisplayMedia({ audio: true, video: true });
          for (const t of stream.getVideoTracks()) {
            t.stop();
            stream.removeTrack(t);
          }
          if (stream.getAudioTracks().length > 0) return stream;
          stopStream(stream);
        } catch (err) {
          console.warn('[prajeala] system audio capture failed, falling back to the microphone:', err);
        }
      }
      // Fallback: a loopback-ish input device (PulseAudio "Monitor of …") when one is exposed, else the mic.
      const monitor = await findMonitorDevice(md);
      if (monitor) {
        const stream = await md.getUserMedia({ audio: { deviceId: { exact: monitor }, ...RAW_AUDIO } });
        this.status = { ...this.status, source: 'system' };
        return stream;
      }
      this.status = { ...this.status, source: 'microphone', message: 'system audio unavailable here; using the microphone' };
    }
    return md.getUserMedia({ audio: RAW_AUDIO });
  }

  private stopInternal(): void {
    this.simulated = null;
    if (this.stream) stopStream(this.stream);
    this.stream = null;
    this.analyser = null;
    const ctx = this.context;
    this.context = null;
    if (ctx) void ctx.close().catch(() => undefined);
    this.analysis.reset();
    Object.assign(this.levels, emptyLevels());
  }

  private setStatus(status: AudioStatus): void {
    this.status = status;
    try {
      this.options.onStatus(status);
    } catch {
      /* ignore */
    }
  }
}

const RAW_AUDIO: MediaTrackConstraints = { echoCancellation: false, noiseSuppression: false, autoGainControl: false };

function stopStream(stream: MediaStream): void {
  for (const t of stream.getTracks()) {
    try {
      t.stop();
    } catch {
      /* ignore */
    }
  }
}

async function findMonitorDevice(md: MediaDevices): Promise<string | null> {
  try {
    const devices = await md.enumerateDevices();
    const monitor = devices.find((d) => d.kind === 'audioinput' && /monitor of|loopback|stereo mix|what u hear/i.test(d.label));
    return monitor?.deviceId ?? null;
  } catch {
    return null;
  }
}

function describeFailure(err: unknown): { state: AudioStatus['state']; message: string } {
  const name = err instanceof Error ? err.name : '';
  const message = err instanceof Error ? err.message : String(err);
  if (name === 'NotAllowedError' || name === 'SecurityError' || name === 'PermissionDeniedError') {
    return { state: 'denied', message: 'microphone access denied' };
  }
  if (name === 'NotFoundError' || name === 'OverconstrainedError' || name === 'DevicesNotFoundError') {
    return { state: 'unavailable', message: 'no audio input device found' };
  }
  if (name === 'NotReadableError' || name === 'AbortError') {
    return { state: 'error', message: `audio device busy or unreadable (${message})` };
  }
  return { state: 'error', message: message || 'audio capture failed' };
}
