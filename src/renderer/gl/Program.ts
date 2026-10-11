/**
 * Thin shader program wrapper: compiles `#version 300 es` sources built from a
 * list of defines plus one or more source chunks, and caches uniform locations.
 */

export class ShaderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ShaderError';
  }
}

function buildSource(chunks: readonly string[], defines: readonly string[]): string {
  const head = ['#version 300 es', ...defines.map((d) => `#define ${d}`)].join('\n');
  return `${head}\n${chunks.join('\n')}`;
}

function compile(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader {
  const shader = gl.createShader(type);
  if (!shader) throw new ShaderError('createShader returned null');
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS) && !gl.isContextLost()) {
    const log = gl.getShaderInfoLog(shader) ?? '';
    gl.deleteShader(shader);
    const kind = type === gl.VERTEX_SHADER ? 'vertex' : 'fragment';
    throw new ShaderError(`${kind} shader failed to compile:\n${log}\n--- source ---\n${numbered(source)}`);
  }
  return shader;
}

function numbered(src: string): string {
  return src
    .split('\n')
    .map((l, i) => `${String(i + 1).padStart(4, ' ')}: ${l}`)
    .join('\n');
}

export class Program {
  readonly handle: WebGLProgram;
  private readonly uniforms = new Map<string, WebGLUniformLocation | null>();

  constructor(
    private readonly gl: WebGL2RenderingContext,
    vertexChunks: readonly string[] | string,
    fragmentChunks: readonly string[] | string,
    defines: readonly string[] = [],
  ) {
    const vsSrc = buildSource(Array.isArray(vertexChunks) ? vertexChunks : [vertexChunks as string], defines);
    const fsSrc = buildSource(Array.isArray(fragmentChunks) ? fragmentChunks : [fragmentChunks as string], defines);
    const vs = compile(gl, gl.VERTEX_SHADER, vsSrc);
    const fs = compile(gl, gl.FRAGMENT_SHADER, fsSrc);
    const prog = gl.createProgram();
    if (!prog) throw new ShaderError('createProgram returned null');
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.bindAttribLocation(prog, 0, 'aPosition');
    gl.linkProgram(prog);
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS) && !gl.isContextLost()) {
      const log = gl.getProgramInfoLog(prog) ?? '';
      gl.deleteProgram(prog);
      throw new ShaderError(`program failed to link:\n${log}`);
    }
    this.handle = prog;
    const count = Number(gl.getProgramParameter(prog, gl.ACTIVE_UNIFORMS)) || 0;
    for (let i = 0; i < count; i++) {
      const info = gl.getActiveUniform(prog, i);
      if (!info) continue;
      // Arrays are reported as "name[0]"; register both spellings.
      const base = info.name.replace(/\[0\]$/, '');
      const loc = gl.getUniformLocation(prog, info.name);
      this.uniforms.set(info.name, loc);
      this.uniforms.set(base, loc);
    }
  }

  use(): this {
    this.gl.useProgram(this.handle);
    return this;
  }

  /** Uniform location or null when the uniform was optimised away. */
  loc(name: string): WebGLUniformLocation | null {
    return this.uniforms.get(name) ?? null;
  }

  has(name: string): boolean {
    return this.uniforms.has(name);
  }

  uniform1i(name: string, v: number): void {
    const l = this.loc(name);
    if (l) this.gl.uniform1i(l, v);
  }
  uniform1f(name: string, v: number): void {
    const l = this.loc(name);
    if (l) this.gl.uniform1f(l, v);
  }
  uniform2f(name: string, x: number, y: number): void {
    const l = this.loc(name);
    if (l) this.gl.uniform2f(l, x, y);
  }
  uniform3f(name: string, x: number, y: number, z: number): void {
    const l = this.loc(name);
    if (l) this.gl.uniform3f(l, x, y, z);
  }
  uniform4f(name: string, x: number, y: number, z: number, w: number): void {
    const l = this.loc(name);
    if (l) this.gl.uniform4f(l, x, y, z, w);
  }
  uniform4fv(name: string, data: Float32Array, offset = 0, length?: number): void {
    const l = this.loc(name);
    if (l) this.gl.uniform4fv(l, data, offset, length);
  }

  /** Binds `texture` to `unit` and points the sampler uniform at it. */
  texture(name: string, texture: WebGLTexture | null, unit: number): void {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    this.uniform1i(name, unit);
  }

  dispose(): void {
    this.gl.deleteProgram(this.handle);
  }
}
