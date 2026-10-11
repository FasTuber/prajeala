/**
 * Draws the simulation's temperature field onto the transparent canvas:
 * palette LUT + scrolling fbm detail + a cheap two-pass gaussian glow.
 */
import type { Device } from '../gl/Device';
import { Fbo } from '../gl/Framebuffer';
import { Program } from '../gl/Program';
import { bakePaletteLut, type PaletteDefinition } from '../../shared/palettes';
import quadVert from '../sim/shaders/quad.vert';
import commonGlsl from '../sim/shaders/common.glsl';
import noiseGlsl from './shaders/noise.glsl';
import compositeFrag from './shaders/composite.frag';
import blurFrag from './shaders/blur.frag';

export interface RenderLook {
  /** Noise erosion/detail strength (0..1). */
  detail: number;
  /** Glow halo strength. */
  glow: number;
  /** Smoke opacity. */
  smoke: number;
  /** Debug view: 0 normal, 1 heat, 2 smoke, 3 glow. */
  view: number;
}

export const DEFAULT_LOOK: RenderLook = { detail: 0.9, glow: 0.3, smoke: 0.14, view: 0 };

export class FireRenderer {
  private readonly composite: Program;
  private readonly blur: Program;
  private readonly lut: WebGLTexture;
  private glowA: Fbo;
  private glowB: Fbo;

  constructor(
    private readonly device: Device,
    simWidth: number,
    simHeight: number,
  ) {
    const gl = device.gl;
    this.composite = new Program(gl, quadVert, [commonGlsl, noiseGlsl, compositeFrag], device.simDefines);
    this.blur = new Program(gl, quadVert, blurFrag);
    const lut = gl.createTexture();
    if (!lut) throw new Error('Failed to allocate palette LUT');
    this.lut = lut;
    gl.bindTexture(gl.TEXTURE_2D, lut);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 256, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.bindTexture(gl.TEXTURE_2D, null);
    const { w, h } = FireRenderer.glowSize(simWidth, simHeight);
    this.glowA = this.makeGlow(w, h);
    this.glowB = this.makeGlow(w, h);
  }

  get lutTexture(): WebGLTexture {
    return this.lut;
  }

  private static glowSize(simWidth: number, simHeight: number): { w: number; h: number } {
    return { w: Math.max(16, Math.round(simWidth / 2)), h: Math.max(16, Math.round(simHeight / 2)) };
  }

  private makeGlow(w: number, h: number): Fbo {
    const gl = this.device.gl;
    return new Fbo(gl, w, h, { format: this.device.caps.formats.r, filter: gl.LINEAR });
  }

  /** Re-bakes the palette LUT (call on palette changes). */
  setPalette(def: PaletteDefinition): void {
    const gl = this.device.gl;
    const data = bakePaletteLut(def, 256);
    gl.bindTexture(gl.TEXTURE_2D, this.lut);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 256, 1, gl.RGBA, gl.UNSIGNED_BYTE, data);
    gl.bindTexture(gl.TEXTURE_2D, null);
  }

  resize(simWidth: number, simHeight: number): void {
    const { w, h } = FireRenderer.glowSize(simWidth, simHeight);
    if (w === this.glowA.width && h === this.glowA.height) return;
    this.glowA.dispose();
    this.glowB.dispose();
    this.glowA = this.makeGlow(w, h);
    this.glowB = this.makeGlow(w, h);
  }

  /** Renders the fire to the canvas. The canvas is cleared first. */
  render(
    temperature: WebGLTexture,
    simWidth: number,
    simHeight: number,
    canvasWidth: number,
    canvasHeight: number,
    time: number,
    look: RenderLook,
  ): void {
    const gl = this.device.gl;
    gl.disable(gl.BLEND);

    // Glow: downsample heat, then blur twice (H+V, H+V) at half simulation resolution.
    this.device.copy(temperature, this.glowA);
    const gx = 1 / this.glowA.width;
    const gy = 1 / this.glowA.height;
    this.blur.use();
    for (let i = 0; i < 2; i++) {
      this.blur.uniform2f('uDirection', gx, 0);
      this.blur.texture('uTexture', this.glowA.texture, 0);
      this.device.blit(this.glowB);
      this.blur.uniform2f('uDirection', 0, gy);
      this.blur.texture('uTexture', this.glowB.texture, 0);
      this.device.blit(this.glowA);
    }

    // Composite onto the transparent canvas (premultiplied).
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, canvasWidth, canvasHeight);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    this.composite.use();
    this.composite.uniform2f('uTexel', 1 / simWidth, 1 / simHeight);
    this.composite.uniform1f('uTime', time);
    this.composite.uniform1f('uAspect', canvasWidth / Math.max(1, canvasHeight));
    this.composite.uniform1f('uDetail', look.detail);
    this.composite.uniform1f('uGlow_', look.glow);
    this.composite.uniform1f('uSmoke', look.smoke);
    this.composite.uniform1i('uView', look.view | 0);
    this.composite.texture('uTemperature', temperature, 0);
    this.composite.texture('uGlow', this.glowA.texture, 1);
    this.composite.texture('uLut', this.lut, 2);
    this.device.drawQuad();
  }

  dispose(): void {
    this.composite.dispose();
    this.blur.dispose();
    this.glowA.dispose();
    this.glowB.dispose();
    this.device.gl.deleteTexture(this.lut);
  }
}
