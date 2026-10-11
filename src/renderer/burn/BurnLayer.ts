/**
 * "Arde tot": burns a picture of the desktop (or of one window, or of an image)
 * like paper. A quarter-resolution cellular automaton (burnUpdate.frag) moves a
 * ragged front across the burn map; the map feeds heat and lift into the fluid
 * simulation (two-way: hot fluid also lights the paper) and is composited under
 * the fire, revealing the live desktop where the paper has turned to ash.
 *
 * A tiny readback (64×N, every 200 ms) finds where the front is — for embers —
 * and how much is left, so the burn ends when the paper is gone.
 */
import { toUvRect, type BurnStart, type UvRect } from '../../shared/burn';
import type { Device } from '../gl/Device';
import { DoubleFbo, Fbo, type FboOptions } from '../gl/Framebuffer';
import { Program } from '../gl/Program';
import commonGlsl from '../sim/shaders/common.glsl';
import quadVert from '../sim/shaders/quad.vert';
import noiseGlsl from '../render/shaders/noise.glsl';
import burnInitFrag from './shaders/burnInit.frag';
import burnUpdateFrag from './shaders/burnUpdate.frag';
import burnCompositeFrag from './shaders/burnComposite.frag';

const MAX_IGNITES = 8;
/** The automaton advances at a fixed rate (cells can move at most one cell per step), independent of fps. */
const STEP_HZ = 120;
const MAX_STEPS_PER_FRAME = 6;
const PROBE_W = 64;
const PROBE_INTERVAL_MS = 200;
const FADE_MS = 600;
const ABORT_FADE_MS = 250;

export interface BurnSourceRef {
  texture: WebGLTexture;
  strength: number;
}

export interface BurnFront {
  /** Local CSS px positions of currently burning cells (sampled). */
  points: Float32Array;
  count: number;
}

type Phase = 'idle' | 'burning' | 'fading';

export class BurnLayer {
  private readonly init: Program;
  private readonly step: Program;
  private readonly composite: Program;
  private readonly rgba8: FboOptions;
  private map: DoubleFbo | null = null;
  private probe: Fbo | null = null;
  private probePixels = new Uint8Array(0);
  private snapshot: WebGLTexture | null = null;

  private phase: Phase = 'idle';
  private startedAt = 0;
  /** Simulated seconds since the start (sum of frame dt): the burn's own clock. */
  private simElapsed = 0;
  private stepRemainder = 0;
  private fadeStartedAt = 0;
  private fadeMs = FADE_MS;
  private durationMs = 10_000;
  private imageRect: UvRect = [0, 0, 1, 1];
  private aborted = false;
  private seed = 0;
  private readonly ignites = new Float32Array(MAX_IGNITES * 4);
  private igniteCount = 0;
  private lastProbeAt = 0;
  private remaining = 1;
  /** Intact fraction at the first probe (window/image burns cover only part of the map). */
  private initialLeft = 0;
  private cssWidth = 1;
  private cssHeight = 1;
  /** Burning cells found by the last probe, local CSS px (x, y pairs). */
  readonly front: BurnFront = { points: new Float32Array(PROBE_W * 64 * 2), count: 0 };
  /** Called once when the burn is over. */
  onDone: ((aborted: boolean) => void) | null = null;

  constructor(private readonly device: Device) {
    const gl = device.gl;
    const defs = device.simDefines;
    this.init = new Program(gl, quadVert, [commonGlsl, noiseGlsl, burnInitFrag], defs);
    this.step = new Program(gl, quadVert, [commonGlsl, burnUpdateFrag], defs);
    this.composite = new Program(gl, quadVert, [commonGlsl, noiseGlsl, burnCompositeFrag], defs);
    this.rgba8 = {
      format: { internalFormat: gl.RGBA8, format: gl.RGBA, type: gl.UNSIGNED_BYTE },
      filter: gl.LINEAR,
    };
  }

  get active(): boolean {
    return this.phase !== 'idle';
  }

  /** Fraction of the paper that has not burnt yet (from the last probe). */
  get left(): number {
    return this.initialLeft > 0 ? this.remaining / this.initialLeft : 1;
  }

  /**
   * Starts a burn. `bitmap` is the decoded picture; sizes are the canvas in
   * device pixels and CSS pixels.
   */
  start(payload: BurnStart, bitmap: ImageBitmap, canvasW: number, canvasH: number, cssW: number, cssH: number): void {
    const gl = this.device.gl;
    this.disposeTargets();
    this.cssWidth = cssW;
    this.cssHeight = cssH;
    // Map size follows the CSS size (capped), so a burn looks and lasts the same at any DPI/resolution.
    const mw = Math.round(Math.min(480, Math.max(160, cssW / 4)));
    const mh = Math.max(32, Math.round((mw * canvasH) / Math.max(1, canvasW)));
    this.map = new DoubleFbo(gl, mw, mh, this.rgba8);
    const ph = Math.max(8, Math.round((PROBE_W * mh) / mw));
    this.probe = new Fbo(gl, PROBE_W, ph, this.rgba8);
    this.probePixels = new Uint8Array(PROBE_W * ph * 4);
    if (this.front.points.length < PROBE_W * ph * 2) this.front.points = new Float32Array(PROBE_W * ph * 2);

    const tex = gl.createTexture();
    if (!tex) throw new Error('could not allocate the burn snapshot');
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, bitmap);
    gl.bindTexture(gl.TEXTURE_2D, null);
    this.snapshot = tex;

    this.imageRect = toUvRect(payload.imageRect, cssW, cssH);
    const burnRect = toUvRect(payload.burnRect, cssW, cssH);
    this.seed = (Math.random() * 1000) % 1000;
    this.init.use();
    this.init.uniform4f('uRect', burnRect[0], burnRect[1], burnRect[2], burnRect[3]);
    this.init.uniform1f('uAspect', cssW / Math.max(1, cssH));
    this.init.uniform1f('uSeed', this.seed);
    gl.disable(gl.BLEND);
    this.device.blit(this.map.write);
    this.map.swap();
    this.device.copy(this.map.texture, this.map.write);

    this.durationMs = Math.max(2000, payload.durationMs);
    this.startedAt = performance.now();
    this.simElapsed = 0;
    this.stepRemainder = 0;
    this.lastProbeAt = 0;
    this.remaining = 1;
    this.initialLeft = 0;
    this.front.count = 0;
    this.aborted = false;
    this.phase = 'burning';
    this.igniteCount = 0;
    this.ignite(payload.ignite.x, payload.ignite.y, 1.4);
  }

  /** Adds an ignition point (local CSS px). `size` scales the initial spot. */
  ignite(x: number, y: number, size = 1): void {
    if (this.phase !== 'burning' || this.igniteCount >= MAX_IGNITES) return;
    const i = this.igniteCount++ * 4;
    this.ignites[i] = x / Math.max(1, this.cssWidth);
    this.ignites[i + 1] = 1 - y / Math.max(1, this.cssHeight);
    this.ignites[i + 2] = 0.012 * size;
    this.ignites[i + 3] = 0;
  }

  abort(): void {
    if (this.phase !== 'burning') return;
    this.aborted = true;
    this.beginFade(ABORT_FADE_MS);
  }

  /** Advances the automaton. Call once per frame before the fluid step. */
  update(dt: number, temperature: WebGLTexture, now: number): void {
    const map = this.map;
    if (!map || this.phase === 'idle') return;
    const gl = this.device.gl;
    this.simElapsed += dt;
    // The burn runs on simulated time (the front moves per step), but a slow machine
    // must still finish in reasonable wall time: take whichever clock is further along.
    const elapsed = Math.max(this.simElapsed * 1000, (now - this.startedAt) * 0.75);
    if (this.phase === 'burning') {
      const sweep = Math.min(1, Math.max(0, (elapsed - this.durationMs * 0.55) / (this.durationMs * 0.35)));
      this.stepRemainder += dt * STEP_HZ;
      const steps = Math.min(MAX_STEPS_PER_FRAME, Math.floor(this.stepRemainder));
      this.stepRemainder -= steps;
      if (this.stepRemainder > 1) this.stepRemainder = 0; // dropped steps on a very slow frame
      gl.disable(gl.BLEND);
      this.step.use();
      this.step.uniform2f('uTexel', 1 / map.width, 1 / map.height);
      this.step.uniform1f('uDt', 1 / STEP_HZ);
      // ~95 cells/s upwards, ~55 sideways, ~30 down (see burnUpdate.frag weights).
      this.step.uniform1f('uSpread', 110);
      this.step.uniform1f('uBurnTime', 0.9);
      this.step.uniform1f('uSweep', sweep);
      this.step.uniform1f('uHeatIgnite', 0.8);
      this.step.uniform1f('uAspect', this.cssWidth / Math.max(1, this.cssHeight));
      this.step.texture('uTemperature', temperature, 1);
      for (let i = 0; i < steps; i++) {
        this.step.uniform1f('uTime', ((now / 1000) % 1000) + i * 0.0137);
        this.step.uniform4fv('uIgnite', this.ignites, 0, MAX_IGNITES * 4);
        this.step.uniform1i('uIgniteCount', i === 0 ? this.igniteCount : 0);
        this.step.texture('uBurn', map.texture, 0);
        this.device.blit(map.write);
        map.swap();
      }
      if (steps > 0) this.igniteCount = 0;

      if (now - this.lastProbeAt >= PROBE_INTERVAL_MS) {
        this.lastProbeAt = now;
        this.readProbe();
        if (this.initialLeft === 0) this.initialLeft = Math.max(this.remaining, 1e-4);
        const leftRatio = this.remaining / this.initialLeft;
        if ((leftRatio < 0.02 && elapsed > 1500) || elapsed > this.durationMs + 2500) this.beginFade(FADE_MS);
      }
    }
    if (this.phase === 'fading' && now - this.fadeStartedAt >= this.fadeMs) this.finish();
  }

  /** Heat source for the fluid step (null when nothing burns). */
  source(now: number): BurnSourceRef | null {
    if (!this.map || this.phase === 'idle') return null;
    return { texture: this.map.texture, strength: this.fade(now) };
  }

  /** Draws the burning picture onto the bound canvas (premultiplied, blending already on). */
  draw(canvasW: number, canvasH: number, temperature: WebGLTexture, simW: number, simH: number, lut: WebGLTexture, time: number, now: number): void {
    const map = this.map;
    if (!map || !this.snapshot || this.phase === 'idle') return;
    const gl = this.device.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, canvasW, canvasH);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    this.composite.use();
    this.composite.uniform2f('uTexel', 1 / simW, 1 / simH);
    this.composite.uniform4f('uImageRect', this.imageRect[0], this.imageRect[1], this.imageRect[2], this.imageRect[3]);
    this.composite.uniform1f('uTime', time);
    this.composite.uniform1f('uFade', this.fade(now));
    this.composite.uniform1f('uAspect', canvasW / Math.max(1, canvasH));
    this.composite.texture('uBurn', map.texture, 0);
    this.composite.texture('uSnapshot', this.snapshot, 1);
    this.composite.texture('uTemperature', temperature, 2);
    this.composite.texture('uLut', lut, 3);
    this.device.drawQuad();
  }

  dispose(): void {
    this.disposeTargets();
    this.init.dispose();
    this.step.dispose();
    this.composite.dispose();
  }

  /** Drops GPU state without reporting (context loss). */
  reset(): void {
    this.phase = 'idle';
    this.disposeTargets();
  }

  // ── internals ──────────────────────────────────────────────────────────

  private fade(now: number): number {
    if (this.phase === 'burning') return 1;
    if (this.phase === 'fading') return Math.max(0, 1 - (now - this.fadeStartedAt) / this.fadeMs);
    return 0;
  }

  private beginFade(ms: number): void {
    if (this.phase !== 'burning') return;
    this.phase = 'fading';
    this.fadeMs = ms;
    this.fadeStartedAt = performance.now();
  }

  private finish(): void {
    const aborted = this.aborted;
    this.phase = 'idle';
    this.front.count = 0;
    this.disposeTargets();
    this.onDone?.(aborted);
  }

  /** Downsamples the burn map and finds the front + what is left. */
  private readProbe(): void {
    const map = this.map;
    const probe = this.probe;
    if (!map || !probe) return;
    const gl = this.device.gl;
    this.device.copy(map.texture, probe);
    probe.bind();
    gl.readPixels(0, 0, probe.width, probe.height, gl.RGBA, gl.UNSIGNED_BYTE, this.probePixels);
    let left = 0;
    let n = 0;
    const px = this.probePixels;
    const pts = this.front.points;
    for (let y = 0; y < probe.height; y++) {
      for (let x = 0; x < probe.width; x++) {
        const r = px[(y * probe.width + x) * 4] ?? 255;
        if (r < 120) left++;
        else if (r < 175 && n * 2 + 1 < pts.length) {
          pts[n * 2] = ((x + 0.5) / probe.width) * this.cssWidth;
          pts[n * 2 + 1] = (1 - (y + 0.5) / probe.height) * this.cssHeight;
          n++;
        }
      }
    }
    this.front.count = n;
    this.remaining = left / (probe.width * probe.height);
  }

  private disposeTargets(): void {
    const gl = this.device.gl;
    this.map?.dispose();
    this.probe?.dispose();
    if (this.snapshot) gl.deleteTexture(this.snapshot);
    this.map = null;
    this.probe = null;
    this.snapshot = null;
  }
}
