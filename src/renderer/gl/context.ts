/**
 * WebGL2 context creation and capability probing.
 *
 * The simulation prefers half-float render targets (EXT_color_buffer_float);
 * when they are missing, or forced off with `?nofloat=1`, every field is stored
 * in 8-bit textures with signed values encoded as 0..1 ↔ -S..S.
 */

export interface TextureFormat {
  internalFormat: number;
  format: number;
  type: number;
}

export interface GlCapabilities {
  /** Half-float colour attachments are available and will be used. */
  floatTextures: boolean;
  /** Hardware LINEAR filtering works on the chosen formats; otherwise shaders do manual bilinear. */
  linearFiltering: boolean;
  renderer: string;
  vendor: string;
  maxTextureSize: number;
  /** One/two/four channel formats actually used for the simulation fields. */
  formats: { r: TextureFormat; rg: TextureFormat; rgba: TextureFormat };
}

export interface ContextOptions {
  /** Force the UNSIGNED_BYTE fallback path even when float targets are available. */
  forceByte?: boolean;
  /** Force NEAREST sampling + manual bilinear (exercises the fallback shader path). */
  forceNearest?: boolean;
}

export interface GlContext {
  gl: WebGL2RenderingContext;
  caps: GlCapabilities;
}

export const CONTEXT_ATTRIBUTES: WebGLContextAttributes = {
  alpha: true,
  premultipliedAlpha: true,
  antialias: false,
  depth: false,
  stencil: false,
  preserveDrawingBuffer: false,
  powerPreference: 'high-performance',
  failIfMajorPerformanceCaveat: false,
};

/** Creates the WebGL2 context (or returns null when unavailable). */
export function createWebGL2(canvas: HTMLCanvasElement): WebGL2RenderingContext | null {
  try {
    return canvas.getContext('webgl2', CONTEXT_ATTRIBUTES);
  } catch {
    return null;
  }
}

/** Checks that a texture of the given format can be used as a colour attachment. */
function isRenderable(gl: WebGL2RenderingContext, fmt: TextureFormat): boolean {
  const tex = gl.createTexture();
  const fbo = gl.createFramebuffer();
  if (!tex || !fbo) return false;
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texImage2D(gl.TEXTURE_2D, 0, fmt.internalFormat, 4, 4, 0, fmt.format, fmt.type, null);
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
  const ok = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.bindTexture(gl.TEXTURE_2D, null);
  gl.deleteFramebuffer(fbo);
  gl.deleteTexture(tex);
  return ok;
}

/** Probes extensions and picks the texture formats used by the simulation. */
export function probeCapabilities(gl: WebGL2RenderingContext, opts: ContextOptions = {}): GlCapabilities {
  const halfFormats = {
    r: { internalFormat: gl.R16F, format: gl.RED, type: gl.HALF_FLOAT },
    rg: { internalFormat: gl.RG16F, format: gl.RG, type: gl.HALF_FLOAT },
    rgba: { internalFormat: gl.RGBA16F, format: gl.RGBA, type: gl.HALF_FLOAT },
  };
  const byteFormats = {
    r: { internalFormat: gl.R8, format: gl.RED, type: gl.UNSIGNED_BYTE },
    rg: { internalFormat: gl.RG8, format: gl.RG, type: gl.UNSIGNED_BYTE },
    rgba: { internalFormat: gl.RGBA8, format: gl.RGBA, type: gl.UNSIGNED_BYTE },
  };

  let floatTextures = false;
  if (!opts.forceByte) {
    const ext = gl.getExtension('EXT_color_buffer_float');
    if (ext) {
      floatTextures = isRenderable(gl, halfFormats.r) && isRenderable(gl, halfFormats.rg) && isRenderable(gl, halfFormats.rgba);
    }
  }
  // Half-float textures are filterable in core WebGL2; OES_texture_float_linear only matters for 32F,
  // but we honour it as a hint for drivers that misreport, and allow forcing the manual path.
  let linearFiltering = true;
  if (floatTextures) {
    const linearExt = gl.getExtension('OES_texture_float_linear');
    const halfLinear = gl.getExtension('OES_texture_half_float_linear');
    // In WebGL2 neither is required for 16F; only fall back when the driver advertises nothing at all
    // AND fails a tiny filtering probe.
    if (!linearExt && !halfLinear && !probeHalfFloatLinear(gl)) linearFiltering = false;
  }
  if (opts.forceNearest) linearFiltering = false;

  let renderer = 'unknown';
  let vendor = 'unknown';
  const dbg = gl.getExtension('WEBGL_debug_renderer_info');
  try {
    if (dbg) {
      renderer = String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL));
      vendor = String(gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL));
    } else {
      renderer = String(gl.getParameter(gl.RENDERER));
      vendor = String(gl.getParameter(gl.VENDOR));
    }
  } catch {
    /* ignore: some drivers throw on masked queries */
  }

  return {
    floatTextures,
    linearFiltering,
    renderer,
    vendor,
    maxTextureSize: Number(gl.getParameter(gl.MAX_TEXTURE_SIZE)) || 2048,
    formats: floatTextures ? halfFormats : byteFormats,
  };
}

/**
 * Renders a 2×1 half-float texture magnified with LINEAR filtering and checks
 * that the middle sample is interpolated. Cheap and only run once.
 */
function probeHalfFloatLinear(gl: WebGL2RenderingContext): boolean {
  const vs = `#version 300 es
void main(){ gl_Position = vec4(0.0, 0.0, 0.0, 1.0); gl_PointSize = 1.0; }`;
  const fs = `#version 300 es
precision highp float; uniform sampler2D u; out vec4 o;
void main(){ o = vec4(texture(u, vec2(0.5, 0.5)).r, 0.0, 0.0, 1.0); }`;
  const prog = gl.createProgram();
  const v = gl.createShader(gl.VERTEX_SHADER);
  const f = gl.createShader(gl.FRAGMENT_SHADER);
  const tex = gl.createTexture();
  const target = gl.createTexture();
  const fbo = gl.createFramebuffer();
  if (!prog || !v || !f || !tex || !target || !fbo) return true;
  try {
    gl.shaderSource(v, vs);
    gl.compileShader(v);
    gl.shaderSource(f, fs);
    gl.compileShader(f);
    gl.attachShader(prog, v);
    gl.attachShader(prog, f);
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) return true;

    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    // half floats: 0.0 = 0x0000, 1.0 = 0x3c00
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R16F, 2, 1, 0, gl.RED, gl.HALF_FLOAT, new Uint16Array([0x0000, 0x3c00]));

    gl.bindTexture(gl.TEXTURE_2D, target);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, target, 0);
    gl.viewport(0, 0, 1, 1);
    gl.useProgram(prog);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.uniform1i(gl.getUniformLocation(prog, 'u'), 0);
    gl.drawArrays(gl.POINTS, 0, 1);
    const px = new Uint8Array(4);
    gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
    const r = px[0] ?? 0;
    return r > 64 && r < 192; // ≈ 0.5 when interpolated, 0 or 255 when NEAREST
  } catch {
    return true;
  } finally {
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.bindTexture(gl.TEXTURE_2D, null);
    gl.useProgram(null);
    gl.deleteFramebuffer(fbo);
    gl.deleteTexture(tex);
    gl.deleteTexture(target);
    gl.deleteProgram(prog);
    gl.deleteShader(v);
    gl.deleteShader(f);
  }
}
