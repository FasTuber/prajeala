/**
 * Owns the WebGL2 context, its capabilities, the shared full-screen quad and a
 * generic copy program. Every other GPU module receives a Device.
 */
import { createWebGL2, probeCapabilities, type ContextOptions, type GlCapabilities } from './context';
import type { Fbo } from './Framebuffer';
import { Program } from './Program';
import quadVert from '../sim/shaders/quad.vert';
import copyFrag from '../sim/shaders/copy.frag';

export class Device {
  readonly gl: WebGL2RenderingContext;
  readonly caps: GlCapabilities;
  private readonly vao: WebGLVertexArrayObject;
  private readonly vbo: WebGLBuffer;
  private readonly copyProgram: Program;

  private constructor(gl: WebGL2RenderingContext, caps: GlCapabilities) {
    this.gl = gl;
    this.caps = caps;
    const vao = gl.createVertexArray();
    const vbo = gl.createBuffer();
    if (!vao || !vbo) throw new Error('Failed to allocate quad buffers');
    this.vao = vao;
    this.vbo = vbo;
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);
    this.copyProgram = new Program(gl, quadVert, copyFrag);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.CULL_FACE);
    gl.disable(gl.BLEND);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
  }

  static create(canvas: HTMLCanvasElement, opts: ContextOptions): Device | null {
    const gl = createWebGL2(canvas);
    if (!gl) return null;
    const caps = probeCapabilities(gl, opts);
    return new Device(gl, caps);
  }

  /** Common `#define`s derived from capabilities for simulation shaders. */
  get simDefines(): string[] {
    const d: string[] = [];
    if (!this.caps.floatTextures) d.push('BYTE_MODE');
    if (!this.caps.linearFiltering) d.push('MANUAL_BILINEAR');
    return d;
  }

  get filter(): number {
    return this.caps.linearFiltering ? this.gl.LINEAR : this.gl.NEAREST;
  }

  /** Draws the full-screen quad with the currently bound program and target. */
  drawQuad(): void {
    const gl = this.gl;
    gl.bindVertexArray(this.vao);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.bindVertexArray(null);
  }

  /** Binds `target` (or the canvas when null) and draws the quad. */
  blit(target: Fbo | null, canvasWidth = 0, canvasHeight = 0): void {
    const gl = this.gl;
    if (target) {
      target.bind();
    } else {
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, canvasWidth, canvasHeight);
    }
    this.drawQuad();
  }

  /** Copies a texture into a target (resizes, glow downsample). */
  copy(src: WebGLTexture, dst: Fbo): void {
    const gl = this.gl;
    gl.disable(gl.BLEND);
    this.copyProgram.use();
    this.copyProgram.texture('uTexture', src, 0);
    this.blit(dst);
  }

  dispose(): void {
    const gl = this.gl;
    this.copyProgram.dispose();
    gl.deleteBuffer(this.vbo);
    gl.deleteVertexArray(this.vao);
  }
}
