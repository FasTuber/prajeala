/**
 * Render-target helpers: a single texture-backed framebuffer and the
 * ping-pong pair used by every simulation field.
 */
import type { TextureFormat } from './context';

export interface FboOptions {
  format: TextureFormat;
  /** gl.LINEAR or gl.NEAREST */
  filter: number;
  /** gl.CLAMP_TO_EDGE by default */
  wrap?: number;
}

export class Fbo {
  readonly texture: WebGLTexture;
  readonly framebuffer: WebGLFramebuffer;
  width: number;
  height: number;

  constructor(
    private readonly gl: WebGL2RenderingContext,
    width: number,
    height: number,
    readonly options: FboOptions,
  ) {
    const tex = gl.createTexture();
    const fbo = gl.createFramebuffer();
    if (!tex || !fbo) throw new Error('Failed to allocate framebuffer');
    this.texture = tex;
    this.framebuffer = fbo;
    this.width = Math.max(1, width | 0);
    this.height = Math.max(1, height | 0);
    this.allocate();
  }

  private allocate(): void {
    const gl = this.gl;
    const { format, filter, wrap = gl.CLAMP_TO_EDGE } = this.options;
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, wrap);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, wrap);
    gl.texImage2D(gl.TEXTURE_2D, 0, format.internalFormat, this.width, this.height, 0, format.format, format.type, null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.framebuffer);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.texture, 0);
    const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.bindTexture(gl.TEXTURE_2D, null);
    if (status !== gl.FRAMEBUFFER_COMPLETE && !gl.isContextLost()) {
      throw new Error(`Framebuffer incomplete (status 0x${status.toString(16)})`);
    }
  }

  /** Binds as the render target and sets the viewport. */
  bind(): void {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.framebuffer);
    gl.viewport(0, 0, this.width, this.height);
  }

  /** Clears to the given colour (rgba, already encoded for this field). */
  clear(r = 0, g = 0, b = 0, a = 0): void {
    const gl = this.gl;
    this.bind();
    gl.clearColor(r, g, b, a);
    gl.clear(gl.COLOR_BUFFER_BIT);
  }

  dispose(): void {
    this.gl.deleteFramebuffer(this.framebuffer);
    this.gl.deleteTexture(this.texture);
  }
}

/** Two framebuffers of identical size: read from one, write into the other, swap. */
export class DoubleFbo {
  private a: Fbo;
  private b: Fbo;

  constructor(
    private readonly gl: WebGL2RenderingContext,
    width: number,
    height: number,
    readonly options: FboOptions,
  ) {
    this.a = new Fbo(gl, width, height, options);
    this.b = new Fbo(gl, width, height, options);
  }

  get read(): Fbo {
    return this.a;
  }
  get write(): Fbo {
    return this.b;
  }
  get width(): number {
    return this.a.width;
  }
  get height(): number {
    return this.a.height;
  }
  get texture(): WebGLTexture {
    return this.a.texture;
  }

  swap(): void {
    const t = this.a;
    this.a = this.b;
    this.b = t;
  }

  clear(r = 0, g = 0, b = 0, a = 0): void {
    this.a.clear(r, g, b, a);
    this.b.clear(r, g, b, a);
  }

  /**
   * Reallocates at a new size. `copy` receives (source, destination) and should
   * draw the old contents into the new target so the state survives a resize.
   */
  resize(width: number, height: number, copy?: (src: Fbo, dst: Fbo) => void): void {
    if (width === this.width && height === this.height) return;
    const next = new DoubleFbo(this.gl, width, height, this.options);
    if (copy) {
      copy(this.a, next.a);
      copy(this.a, next.b);
    }
    this.a.dispose();
    this.b.dispose();
    this.a = next.a;
    this.b = next.b;
  }

  dispose(): void {
    this.a.dispose();
    this.b.dispose();
  }
}
