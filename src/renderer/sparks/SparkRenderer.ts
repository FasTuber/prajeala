/**
 * GPU side of the spark system: one dynamic VBO, LINES for the tails and
 * POINTS for the heads, premultiplied additive blending.
 */
import type { Device } from '../gl/Device';
import { Program } from '../gl/Program';
import type { Sparks } from './Sparks';
import sparksVert from './shaders/sparks.vert';
import sparksFrag from './shaders/sparks.frag';

export class SparkRenderer {
  private readonly lineProgram: Program;
  private readonly pointProgram: Program;
  private readonly vbo: WebGLBuffer;
  private readonly lineVao: WebGLVertexArrayObject;
  private readonly pointVao: WebGLVertexArrayObject;
  private readonly staging: Float32Array;

  constructor(
    private readonly device: Device,
    capacity: number,
  ) {
    const gl = device.gl;
    this.lineProgram = new Program(gl, sparksVert, sparksFrag);
    this.pointProgram = new Program(gl, sparksVert, sparksFrag, ['POINTS']);
    const vbo = gl.createBuffer();
    const lineVao = gl.createVertexArray();
    const pointVao = gl.createVertexArray();
    if (!vbo || !lineVao || !pointVao) throw new Error('Failed to allocate spark buffers');
    this.vbo = vbo;
    this.lineVao = lineVao;
    this.pointVao = pointVao;
    this.staging = new Float32Array(capacity * 8);
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER, this.staging.byteLength, gl.DYNAMIC_DRAW);

    const posLine = gl.getAttribLocation(this.lineProgram.handle, 'aPosition');
    const dataLine = gl.getAttribLocation(this.lineProgram.handle, 'aData');
    gl.bindVertexArray(lineVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.enableVertexAttribArray(posLine);
    gl.vertexAttribPointer(posLine, 2, gl.FLOAT, false, 16, 0);
    gl.enableVertexAttribArray(dataLine);
    gl.vertexAttribPointer(dataLine, 2, gl.FLOAT, false, 16, 8);

    const posPt = gl.getAttribLocation(this.pointProgram.handle, 'aPosition');
    const dataPt = gl.getAttribLocation(this.pointProgram.handle, 'aData');
    gl.bindVertexArray(pointVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.enableVertexAttribArray(posPt);
    gl.vertexAttribPointer(posPt, 2, gl.FLOAT, false, 32, 16);
    gl.enableVertexAttribArray(dataPt);
    gl.vertexAttribPointer(dataPt, 2, gl.FLOAT, false, 32, 24);
    gl.bindVertexArray(null);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);
  }

  draw(sparks: Sparks, width: number, height: number, dpr: number, color: readonly [number, number, number]): void {
    if (sparks.count === 0) return;
    const gl = this.device.gl;
    const floats = sparks.writeVertices(this.staging);
    const particles = floats / 8;
    if (particles === 0) return;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.staging, 0, floats);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);

    gl.enable(gl.BLEND);
    gl.blendFuncSeparate(gl.ONE, gl.ONE, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);

    this.lineProgram.use();
    this.lineProgram.uniform2f('uResolution', width, height);
    this.lineProgram.uniform1f('uPointSize', 1);
    this.lineProgram.uniform3f('uColor', color[0], color[1], color[2]);
    gl.bindVertexArray(this.lineVao);
    gl.drawArrays(gl.LINES, 0, particles * 2);

    this.pointProgram.use();
    this.pointProgram.uniform2f('uResolution', width, height);
    this.pointProgram.uniform1f('uPointSize', 7 * dpr);
    this.pointProgram.uniform3f('uColor', color[0], color[1], color[2]);
    gl.bindVertexArray(this.pointVao);
    gl.drawArrays(gl.POINTS, 0, particles);
    gl.bindVertexArray(null);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
  }

  dispose(): void {
    const gl = this.device.gl;
    this.lineProgram.dispose();
    this.pointProgram.dispose();
    gl.deleteBuffer(this.vbo);
    gl.deleteVertexArray(this.lineVao);
    gl.deleteVertexArray(this.pointVao);
  }
}
