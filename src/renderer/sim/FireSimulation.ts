/**
 * Stable-fluids style GPU simulation driving the flames.
 *
 * Per step: splats → curl → vorticity confinement + buoyancy → divergence →
 * Jacobi pressure → gradient subtraction → advect velocity → advect temperature
 * (with dissipation + cooling). Every field lives in a ping-pong framebuffer at
 * the (reduced) simulation resolution.
 */
import type { Device } from '../gl/Device';
import { DoubleFbo, Fbo } from '../gl/Framebuffer';
import { Program } from '../gl/Program';
import { retentionPerFrame } from '../util/math';
import { MAX_SPLATS_PER_PASS, SplatQueue } from './SplatQueue';
import quadVert from './shaders/quad.vert';
import commonGlsl from './shaders/common.glsl';
import noiseGlsl from '../render/shaders/noise.glsl';
import splatFrag from './shaders/splat.frag';
import curlFrag from './shaders/curl.frag';
import forcesFrag from './shaders/forces.frag';
import divergenceFrag from './shaders/divergence.frag';
import pressureFrag from './shaders/pressure.frag';
import gradientFrag from './shaders/gradient.frag';
import advectFrag from './shaders/advect.frag';
import burnSourceFrag from '../burn/shaders/burnSource.frag';

export interface SimParams {
  /** Per-second retention of heat (0..1). */
  heatDissipation: number;
  /** Per-second retention of smoke (0..1). */
  smokeDissipation: number;
  /** Per-second retention of velocity (0..1). */
  velocityDissipation: number;
  /** Linear cooling of the heat field, units per second. */
  cooling: number;
  /** Upward acceleration per unit of heat (heights/s²). */
  buoyancy: number;
  /** Vorticity confinement strength. */
  curl: number;
  /** Soft speed limit (heights/s). */
  maxSpeed: number;
  pressureIterations: number;
}

export const SIM_MIN_SIDE = 64;
export const SIM_MAX_SIDE = 1024;

/** 8-bit textures round tiny decays away; force at least ~1 LSB of decay per frame. */
const BYTE_EPS = 0.6 / 255;

export class FireSimulation {
  readonly queue: SplatQueue;
  private velocity: DoubleFbo;
  private temperature: DoubleFbo;
  private pressure: DoubleFbo;
  private divergence: Fbo;
  private curl: Fbo;

  private readonly splatVelocity: Program;
  private readonly splatTemperature: Program;
  private readonly curlProgram: Program;
  private readonly forcesProgram: Program;
  private readonly divergenceProgram: Program;
  private readonly pressureProgram: Program;
  private readonly gradientProgram: Program;
  private readonly advectVelocity: Program;
  private readonly advectTemperature: Program;
  private readonly burnVelocity: Program;
  private readonly burnTemperature: Program;

  private time = 0;

  constructor(
    private readonly device: Device,
    width: number,
    height: number,
    queue: SplatQueue = new SplatQueue(),
  ) {
    this.queue = queue;
    const gl = device.gl;
    const f = device.caps.formats;
    const filter = device.filter;
    const w = FireSimulation.clampSide(width);
    const h = FireSimulation.clampSide(height);
    this.velocity = new DoubleFbo(gl, w, h, { format: f.rg, filter });
    this.temperature = new DoubleFbo(gl, w, h, { format: f.rg, filter });
    this.pressure = new DoubleFbo(gl, w, h, { format: f.r, filter: gl.NEAREST });
    this.divergence = new Fbo(gl, w, h, { format: f.r, filter: gl.NEAREST });
    this.curl = new Fbo(gl, w, h, { format: f.r, filter: gl.NEAREST });

    const defs = device.simDefines;
    const splatDefs = [...defs, `MAX_SPLATS ${MAX_SPLATS_PER_PASS}`];
    this.splatVelocity = new Program(gl, quadVert, [commonGlsl, splatFrag], [...splatDefs, 'SPLAT_VELOCITY']);
    this.splatTemperature = new Program(gl, quadVert, [commonGlsl, splatFrag], splatDefs);
    this.curlProgram = new Program(gl, quadVert, [commonGlsl, curlFrag], defs);
    this.forcesProgram = new Program(gl, quadVert, [commonGlsl, forcesFrag], defs);
    this.divergenceProgram = new Program(gl, quadVert, [commonGlsl, divergenceFrag], defs);
    this.pressureProgram = new Program(gl, quadVert, [commonGlsl, pressureFrag], defs);
    this.gradientProgram = new Program(gl, quadVert, [commonGlsl, gradientFrag], defs);
    this.advectVelocity = new Program(gl, quadVert, [commonGlsl, noiseGlsl, advectFrag], [...defs, 'ADVECT_VELOCITY']);
    this.advectTemperature = new Program(gl, quadVert, [commonGlsl, noiseGlsl, advectFrag], defs);
    this.burnVelocity = new Program(gl, quadVert, [commonGlsl, burnSourceFrag], [...defs, 'BURN_VELOCITY']);
    this.burnTemperature = new Program(gl, quadVert, [commonGlsl, burnSourceFrag], defs);
    this.clear();
  }

  static clampSide(v: number): number {
    return Math.max(SIM_MIN_SIDE, Math.min(SIM_MAX_SIDE, Math.round(v)));
  }

  get width(): number {
    return this.velocity.width;
  }
  get height(): number {
    return this.velocity.height;
  }
  /** Current temperature field (r = heat, g = smoke). */
  get temperatureTexture(): WebGLTexture {
    return this.temperature.texture;
  }
  get velocityTexture(): WebGLTexture {
    return this.velocity.texture;
  }
  get byteMode(): boolean {
    return !this.device.caps.floatTextures;
  }

  /** Encoded "zero" for signed fields (0.5 in byte mode, 0 otherwise). */
  private get zero(): number {
    return this.byteMode ? 0.5 : 0;
  }

  /** Resets every field; the queue is dropped as well. */
  clear(): void {
    const z = this.zero;
    this.velocity.clear(z, z, 0, 1);
    this.pressure.clear(z, 0, 0, 1);
    this.divergence.clear(z, 0, 0, 1);
    this.curl.clear(z, 0, 0, 1);
    this.temperature.clear(0, 0, 0, 1);
    this.queue.clear();
  }

  /** Resizes all fields, preserving the current state by resampling. */
  resize(width: number, height: number): void {
    const w = FireSimulation.clampSide(width);
    const h = FireSimulation.clampSide(height);
    if (w === this.width && h === this.height) return;
    const copy = (src: Fbo, dst: Fbo): void => this.device.copy(src.texture, dst);
    this.velocity.resize(w, h, copy);
    this.temperature.resize(w, h, copy);
    this.pressure.resize(w, h);
    const gl = this.device.gl;
    const f = this.device.caps.formats;
    this.divergence.dispose();
    this.curl.dispose();
    this.divergence = new Fbo(gl, w, h, { format: f.r, filter: gl.NEAREST });
    this.curl = new Fbo(gl, w, h, { format: f.r, filter: gl.NEAREST });
    const z = this.zero;
    this.pressure.clear(z, 0, 0, 1);
    this.divergence.clear(z, 0, 0, 1);
    this.curl.clear(z, 0, 0, 1);
  }

  /** Advances the simulation by `dt` seconds (already clamped by the caller). */
  /**
   * Advances the simulation by `dt` seconds (already clamped by the caller).
   * `burn` (optional) is the Arde tot burn map: its front becomes a heat source.
   */
  step(dt: number, params: SimParams, burn?: { texture: WebGLTexture; strength: number } | null): void {
    const gl = this.device.gl;
    const w = this.width;
    const h = this.height;
    const texelX = 1 / w;
    const texelY = 1 / h;
    const aspect = w / h;
    this.time = (this.time + dt) % 3600;
    gl.disable(gl.BLEND);

    // 1. Splats.
    this.applySplats(texelX, texelY, aspect, dt);
    if (burn && burn.strength > 0) this.applyBurn(burn.texture, burn.strength, dt);

    // 2. Curl.
    this.curlProgram.use();
    this.curlProgram.uniform2f('uTexel', texelX, texelY);
    this.curlProgram.texture('uVelocity', this.velocity.texture, 0);
    this.device.blit(this.curl);

    // 3. Vorticity confinement + buoyancy.
    this.forcesProgram.use();
    this.forcesProgram.uniform2f('uTexel', texelX, texelY);
    this.forcesProgram.uniform1f('uDt', dt);
    this.forcesProgram.uniform1f('uCurlStrength', params.curl);
    this.forcesProgram.uniform1f('uBuoyancy', params.buoyancy);
    this.forcesProgram.uniform1f('uMaxSpeed', params.maxSpeed);
    this.forcesProgram.texture('uVelocity', this.velocity.texture, 0);
    this.forcesProgram.texture('uCurl', this.curl.texture, 1);
    this.forcesProgram.texture('uTemperature', this.temperature.texture, 2);
    this.device.blit(this.velocity.write);
    this.velocity.swap();

    // 4. Divergence.
    this.divergenceProgram.use();
    this.divergenceProgram.uniform2f('uTexel', texelX, texelY);
    this.divergenceProgram.texture('uVelocity', this.velocity.texture, 0);
    this.device.blit(this.divergence);

    // 5. Pressure (Jacobi). Start from a damped previous solution for faster convergence.
    const iterations = Math.max(0, params.pressureIterations | 0);
    this.pressureProgram.use();
    this.pressureProgram.uniform2f('uTexel', texelX, texelY);
    this.pressureProgram.texture('uDivergence', this.divergence.texture, 1);
    for (let i = 0; i < iterations; i++) {
      this.pressureProgram.texture('uPressure', this.pressure.texture, 0);
      this.device.blit(this.pressure.write);
      this.pressure.swap();
    }

    // 6. Gradient subtraction.
    if (iterations > 0) {
      this.gradientProgram.use();
      this.gradientProgram.uniform2f('uTexel', texelX, texelY);
      this.gradientProgram.texture('uPressure', this.pressure.texture, 0);
      this.gradientProgram.texture('uVelocity', this.velocity.texture, 1);
      this.device.blit(this.velocity.write);
      this.velocity.swap();
    }

    // 7. Advect velocity.
    const eps = this.byteMode ? BYTE_EPS : 0;
    const velEps = this.byteMode ? BYTE_EPS * 4 /* VEL_SCALE */ : 0;
    this.advectVelocity.use();
    this.advectVelocity.uniform2f('uTexel', texelX, texelY);
    this.advectVelocity.uniform1f('uDt', dt);
    this.advectVelocity.uniform2f('uAspectInv', 1 / aspect, 1);
    this.advectVelocity.uniform2f('uDissipation', retentionPerFrame(params.velocityDissipation, dt), 1);
    this.advectVelocity.uniform1f('uEps', velEps);
    this.advectVelocity.texture('uVelocity', this.velocity.texture, 0);
    this.advectVelocity.texture('uSource', this.velocity.texture, 1);
    this.device.blit(this.velocity.write);
    this.velocity.swap();

    // 8. Advect temperature/smoke with dissipation + cooling.
    this.advectTemperature.use();
    this.advectTemperature.uniform2f('uTexel', texelX, texelY);
    this.advectTemperature.uniform1f('uDt', dt);
    this.advectTemperature.uniform2f('uAspectInv', 1 / aspect, 1);
    this.advectTemperature.uniform2f(
      'uDissipation',
      retentionPerFrame(params.heatDissipation, dt),
      retentionPerFrame(params.smokeDissipation, dt),
    );
    this.advectTemperature.uniform1f('uEps', eps);
    this.advectTemperature.uniform1f('uCooling', params.cooling);
    this.advectTemperature.uniform1f('uTime', this.time);
    this.advectTemperature.uniform1f('uAspect', aspect);
    this.advectTemperature.texture('uVelocity', this.velocity.texture, 0);
    this.advectTemperature.texture('uSource', this.temperature.texture, 1);
    this.device.blit(this.temperature.write);
    this.temperature.swap();
  }

  private applyBurn(map: WebGLTexture, strength: number, dt: number): void {
    for (const [program, field, lift] of [
      [this.burnVelocity, this.velocity, 2.4],
      [this.burnTemperature, this.temperature, 0],
    ] as const) {
      program.use();
      program.uniform1f('uStrength', strength);
      program.uniform1f('uDt', dt);
      program.uniform1f('uLift', lift);
      program.texture('uTarget', field.texture, 0);
      program.texture('uBurn', map, 1);
      this.device.blit(field.write);
      field.swap();
    }
  }

  private applySplats(texelX: number, texelY: number, aspect: number, dt: number): void {
    const q = this.queue;
    if (q.count === 0) return;
    for (let offset = 0; offset < q.count; offset += MAX_SPLATS_PER_PASS) {
      const n = Math.min(MAX_SPLATS_PER_PASS, q.count - offset);
      const start = offset * 4;
      const len = n * 4;

      this.splatVelocity.use();
      this.splatVelocity.uniform2f('uTexel', texelX, texelY);
      this.splatVelocity.uniform2f('uAspect', aspect, 1);
      this.splatVelocity.uniform1i('uCount', n);
      this.splatVelocity.uniform4fv('uSplatA', q.a, start, len);
      this.splatVelocity.uniform4fv('uSplatB', q.b, start, len);
      this.splatVelocity.texture('uTarget', this.velocity.texture, 0);
      this.device.blit(this.velocity.write);
      this.velocity.swap();

      this.splatTemperature.use();
      this.splatTemperature.uniform2f('uTexel', texelX, texelY);
      this.splatTemperature.uniform2f('uAspect', aspect, 1);
      this.splatTemperature.uniform1i('uCount', n);
      this.splatTemperature.uniform4fv('uSplatA', q.a, start, len);
      this.splatTemperature.uniform4fv('uSplatB', q.b, start, len);
      this.splatTemperature.uniform1f('uDt', dt);
      this.splatTemperature.texture('uTarget', this.temperature.texture, 0);
      this.splatTemperature.texture('uVelocity', this.velocity.texture, 1);
      this.device.blit(this.temperature.write);
      this.temperature.swap();
    }
    q.clear();
  }

  dispose(): void {
    this.velocity.dispose();
    this.temperature.dispose();
    this.pressure.dispose();
    this.divergence.dispose();
    this.curl.dispose();
    for (const p of [
      this.splatVelocity,
      this.splatTemperature,
      this.curlProgram,
      this.forcesProgram,
      this.divergenceProgram,
      this.pressureProgram,
      this.gradientProgram,
      this.advectVelocity,
      this.advectTemperature,
      this.burnVelocity,
      this.burnTemperature,
    ]) {
      p.dispose();
    }
  }
}
