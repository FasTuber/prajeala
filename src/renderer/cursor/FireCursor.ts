/**
 * Animated flame sprite drawn around the cursor on top of the fluid layer.
 */
import type { Device } from '../gl/Device';
import { Program } from '../gl/Program';
import noiseGlsl from '../render/shaders/noise.glsl';
import cursorVert from './shaders/cursor.vert';
import cursorFrag from './shaders/cursor.frag';

export interface FireCursorParams {
  /** Cursor position, CSS px. */
  x: number;
  y: number;
  /** Canvas CSS size. */
  width: number;
  height: number;
  /** Half size of the sprite in CSS px. */
  size: number;
  /** Lean vector (x right, y up), roughly −direction × speed factor. */
  leanX: number;
  leanY: number;
  intensity: number;
  time: number;
}

export class FireCursor {
  private readonly program: Program;

  constructor(private readonly device: Device) {
    this.program = new Program(device.gl, cursorVert, ['precision highp float;\nprecision highp int;', noiseGlsl, cursorFrag]);
  }

  draw(p: FireCursorParams, lut: WebGLTexture): void {
    const gl = this.device.gl;
    if (p.size <= 0 || p.intensity <= 0) return;
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    this.program.use();
    const cx = (p.x / p.width) * 2 - 1;
    const cy = 1 - (p.y / p.height) * 2;
    this.program.uniform2f('uCenter', cx, cy);
    this.program.uniform2f('uSize', (p.size * 2) / p.width, (p.size * 2) / p.height);
    this.program.uniform2f('uLean', p.leanX, p.leanY);
    this.program.uniform1f('uIntensity', p.intensity);
    this.program.uniform1f('uTime', p.time);
    this.program.uniform1f('uSeed', 0.37);
    this.program.texture('uLut', lut, 0);
    this.device.drawQuad();
  }

  dispose(): void {
    this.program.dispose();
  }
}
