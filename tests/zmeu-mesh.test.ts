import { describe, expect, it } from 'vitest';

import type { ZmeuView } from '../src/renderer/zmeu/core/mesh';
import { ZMEU_BODY_SAMPLES_CHEAP, ZMEU_WING_BETA, buildZmeuMesh, createZmeuMeshRanges } from '../src/renderer/zmeu/core/mesh';
import { ZMEU_JOINTS, ZMEU_MESH_CAPACITY, ZMEU_MESH_STRIDE, ZMEU_TUNING } from '../src/renderer/zmeu/core/tuning';

const N = ZMEU_JOINTS;
const L = 270;
const SEG = (ZMEU_TUNING.bodyFrac * L) / (N - 1);

function view(shape: (i: number) => [number, number], opts: Partial<ZmeuView['pose']> = {}, roll = 1): ZmeuView {
  const bodyX = new Float32Array(N);
  const bodyY = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const [x, y] = shape(i);
    bodyX[i] = x;
    bodyY[i] = y;
  }
  return {
    bodyX,
    bodyY,
    roll: new Float32Array(N).fill(roll),
    pose: { L, glow: 1, wingPhi: 0.6, wingFold: 0, wingSpan: 1, ...opts },
  };
}

const straight = (i: number): [number, number] => [1000 - i * SEG, 500];
const wavy = (i: number): [number, number] => [1000 - i * SEG, 500 + 40 * Math.sin(i * 0.5)];

function vertex(out: Float32Array, v: number): number[] {
  return Array.from(out.subarray(v * ZMEU_MESH_STRIDE, v * ZMEU_MESH_STRIDE + ZMEU_MESH_STRIDE));
}

describe('buildZmeuMesh', () => {
  it('stays within capacity with finite values and contiguous ranges', () => {
    const out = new Float32Array(ZMEU_MESH_CAPACITY * ZMEU_MESH_STRIDE);
    const ranges = createZmeuMeshRanges();
    for (const shape of [straight, wavy]) {
      for (const fold of [0, 0.5, 1]) {
        for (const phi of [-1.5, 0, ZMEU_WING_BETA, 0.9, 1.6]) {
          for (const samples of [48, ZMEU_BODY_SAMPLES_CHEAP]) {
            const n = buildZmeuMesh(view(shape, { wingFold: fold, wingPhi: phi }, -0.3), out, ranges, samples);
            expect(n).toBeLessThanOrEqual(ZMEU_MESH_CAPACITY);
            for (let k = 0; k < n * ZMEU_MESH_STRIDE; k++) expect(Number.isFinite(out[k]!)).toBe(true);
            expect(ranges.farWing[0]).toBe(0);
            expect(ranges.body[0]).toBe(ranges.farWing[0] + ranges.farWing[1]);
            expect(ranges.nearWing[0]).toBe(ranges.body[0] + ranges.body[1]);
            expect(ranges.nearWing[0] + ranges.nearWing[1]).toBe(n);
            expect(ranges.body[1]).toBe(samples * 2);
            expect(ranges.farWing[1]).toBe(10);
            expect(ranges.nearWing[1]).toBe(10);
            for (let v = ranges.farWing[0]; v < ranges.farWing[0] + 10; v++) expect(vertex(out, v)[7]).toBe(1);
            for (let v = ranges.nearWing[0]; v < n; v++) expect(vertex(out, v)[7]).toBe(2);
          }
        }
      }
    }
  });

  it('runs u monotonically along the body strip (tail → neck)', () => {
    const out = new Float32Array(ZMEU_MESH_CAPACITY * ZMEU_MESH_STRIDE);
    const ranges = createZmeuMeshRanges();
    buildZmeuMesh(view(wavy), out, ranges);
    const [b0, bn] = ranges.body;
    let last = Infinity;
    for (let v = b0; v < b0 + bn; v += 2) {
      const u = vertex(out, v)[2]!;
      expect(vertex(out, v + 1)[2]).toBe(u);
      expect(u).toBeLessThan(last);
      last = u;
      expect(Math.abs(vertex(out, v)[3]!)).toBeCloseTo(1.8, 6);
      expect(vertex(out, v)[7]).toBe(0);
    }
    expect(vertex(out, b0)[2]).toBeCloseTo(1, 6);
    expect(vertex(out, b0 + bn - 2)[2]).toBeCloseTo(0, 6);
  });

  it('clamps the inner extrusion on a tight curve', () => {
    const rho = 0.05 * L;
    const cx = 900;
    const cy = 500;
    const circle = (i: number): [number, number] => {
      const a = (i * SEG) / rho;
      return [cx + rho * Math.cos(a), cy + rho * Math.sin(a)];
    };
    const out = new Float32Array(ZMEU_MESH_CAPACITY * ZMEU_MESH_STRIDE);
    const ranges = createZmeuMeshRanges();
    buildZmeuMesh(view(circle), out, ranges);
    const [b0, bn] = ranges.body;
    // Sample points: the outer vertex sits exactly 1.8·r from the spine point along the normal.
    const px: number[] = [];
    const py: number[] = [];
    const ext: number[] = [];
    for (let v = b0; v < b0 + bn; v += 2) {
      const a = vertex(out, v);
      const b = vertex(out, v + 1);
      const da = Math.hypot(a[0]! - cx, a[1]! - cy);
      const db = Math.hypot(b[0]! - cx, b[1]! - cy);
      const [inner, outer] = da < db ? [a, b] : [b, a];
      const r = outer[6]!;
      const span = Math.hypot(outer[0]! - inner[0]!, outer[1]! - inner[1]!);
      const k = (1.8 * r) / span;
      px.push(outer[0]! + (inner[0]! - outer[0]!) * k);
      py.push(outer[1]! + (inner[1]! - outer[1]!) * k);
      ext.push(span - 1.8 * r);
    }
    let checked = 0;
    for (let i = 2; i < px.length - 2; i++) {
      // Menger curvature through the neighbouring sample points.
      const ax = px[i - 1]!;
      const ay = py[i - 1]!;
      const bx = px[i]!;
      const by = py[i]!;
      const qx = px[i + 1]!;
      const qy = py[i + 1]!;
      const area2 = Math.abs((bx - ax) * (qy - ay) - (by - ay) * (qx - ax));
      const kappa = (2 * area2) / (Math.hypot(bx - ax, by - ay) * Math.hypot(qx - bx, qy - by) * Math.hypot(qx - ax, qy - ay));
      expect(ext[i]!).toBeGreaterThan(0);
      expect(ext[i]!).toBeLessThanOrEqual((0.92 / kappa) * 1.1);
      expect(ext[i]!).toBeLessThanOrEqual(1.8 * vertex(out, b0 + i * 2)[6]! + 1e-3);
      checked++;
    }
    expect(checked).toBeGreaterThan(30);
  });

  it('builds wings without NaN edge-on, with the tip about one span from the shoulder', () => {
    const out = new Float32Array(ZMEU_MESH_CAPACITY * ZMEU_MESH_STRIDE);
    const ranges = createZmeuMeshRanges();
    // Edge-on: sin(φ − β) = 0 for the near wing.
    const n = buildZmeuMesh(view(straight, { wingPhi: ZMEU_WING_BETA }), out, ranges);
    for (let k = 0; k < n * ZMEU_MESH_STRIDE; k++) expect(Number.isFinite(out[k]!)).toBe(true);
    // Fully spread near wing: sin(φ − β) = 1.
    for (const span of [1, 1.1]) {
      buildZmeuMesh(view(straight, { wingPhi: Math.PI / 2 + ZMEU_WING_BETA, wingSpan: span }), out, ranges);
      const v0 = ranges.nearWing[0];
      const shoulder = vertex(out, v0);
      const f1 = vertex(out, v0 + 4); // leading edge, k = 2 (first finger)
      const d = Math.hypot(f1[0]! - shoulder[0]!, f1[1]! - shoulder[1]!);
      const W = ZMEU_TUNING.wingFrac * L * span;
      expect(Math.abs(d - W) / W).toBeLessThan(0.1);
      // Dorsal side is up for a right-facing dragon (roll = +1).
      expect(f1[1]!).toBeLessThan(shoulder[1]!);
    }
  });
});
