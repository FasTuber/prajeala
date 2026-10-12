/**
 * CPU geometry for the `zmeuStrip` program: the body as a Catmull-Rom strip
 * through the 24 display joints (tail → neck), plus a fake-3D near and far
 * wing, packed as [x, y, u, v, roll, heat, radiusPx, kind] in CSS px (y down).
 * Pure and allocation-free; draw order is far wing, body, near wing.
 */
import { smoothstep } from '../../util/math';
import { radiusAt } from './spine';
import { ZMEU_JOINTS, ZMEU_MESH_CAPACITY, ZMEU_MESH_STRIDE, ZMEU_TUNING as T } from './tuning';
import { hyp } from './vec';

/** What the mesh needs from the core (ZmeuCore satisfies it). */
export interface ZmeuView {
  readonly bodyX: ArrayLike<number>;
  readonly bodyY: ArrayLike<number>;
  readonly roll: ArrayLike<number>;
  readonly pose: {
    readonly L: number;
    readonly glow: number;
    readonly wingPhi: number;
    readonly wingFold: number;
    readonly wingSpan: number;
  };
}

/** [first vertex, vertex count] per draw. */
export interface ZmeuMeshRanges {
  farWing: [number, number];
  body: [number, number];
  nearWing: [number, number];
}

export function createZmeuMeshRanges(): ZmeuMeshRanges {
  return { farWing: [0, 0], body: [0, 0], nearWing: [0, 0] };
}

export const ZMEU_BODY_SAMPLES = 48;
export const ZMEU_BODY_SAMPLES_CHEAP = 40;
/** Halo margin: body vertices sit at (1 + m)·r from the spine. */
export const ZMEU_HALO = 0.8;
const EXT = 1 + ZMEU_HALO;
/** Fake-3D wing tilt (rad). */
export const ZMEU_WING_BETA = 0.38;

const MAX_SAMPLES = 64;
const px = new Float64Array(MAX_SAMPLES);
const py = new Float64Array(MAX_SAMPLES);
const tx = new Float64Array(MAX_SAMPLES);
const ty = new Float64Array(MAX_SAMPLES);

// Wing bone points (a along the body toward the head, s along the span), in W.
const SPREAD = [0.12, 0.52, -0.22, 1.0, -0.52, 0.8, -0.72, 0.45];
const FOLDED = [0.02, 0.2, -0.52, 0.28, -0.58, 0.22, -0.6, 0.15];

function cr(p0: number, p1: number, p2: number, p3: number, t: number): number {
  const t2 = t * t;
  const t3 = t2 * t;
  return 0.5 * (2 * p1 + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (-p0 + 3 * p1 - 3 * p2 + p3) * t3);
}

function put(out: Float32Array, v: number, x: number, y: number, u: number, vv: number, roll: number, heat: number, r: number, kind: number): void {
  const o = v * ZMEU_MESH_STRIDE;
  out[o] = x;
  out[o + 1] = y;
  out[o + 2] = u;
  out[o + 3] = vv;
  out[o + 4] = roll;
  out[o + 5] = heat;
  out[o + 6] = r;
  out[o + 7] = kind;
}

/** Joint tangent toward the head (central difference), written to tan[0..1]. */
const tan = new Float64Array(2);
function jointTangent(view: ZmeuView, j: number): void {
  const n = ZMEU_JOINTS;
  const a = j > 0 ? j - 1 : 0;
  const b = j < n - 1 ? j + 1 : n - 1;
  let dx = view.bodyX[a]! - view.bodyX[b]!;
  let dy = view.bodyY[a]! - view.bodyY[b]!;
  const l = hyp(dx, dy);
  if (l > 1e-6) {
    dx /= l;
    dy /= l;
  } else {
    dx = 1;
    dy = 0;
  }
  tan[0] = dx;
  tan[1] = dy;
}

/** Writes one wing (10 vertices) starting at vertex `v0`; returns the vertex count. */
function buildWing(view: ZmeuView, out: Float32Array, v0: number, far: boolean, L: number, R: number): number {
  const W = T.wingFrac * L;
  const fold = smoothstep(0, 1, view.pose.wingFold);
  const phi = view.pose.wingPhi;
  const tilt = far ? phi + ZMEU_WING_BETA : phi - ZMEU_WING_BETA;
  const spanMul = view.pose.wingSpan * (far ? 0.85 : 1);
  const lift = Math.sin(tilt);
  const sweep = 0.12 * Math.cos(phi);
  const glow = view.pose.glow;
  const kind = far ? 1 : 2;

  jointTangent(view, 3);
  const TSx = tan[0]!;
  const TSy = tan[1]!;
  const roll3 = view.roll[3]!;
  const DSx = roll3 * TSy;
  const DSy = roll3 * -TSx;
  const r3 = radiusAt(3 / (ZMEU_JOINTS - 1), R);
  const Sx = view.bodyX[3]! + DSx * 0.6 * r3;
  const Sy = view.bodyY[3]! + DSy * 0.6 * r3;

  for (let k = 0; k < 5; k++) {
    // Leading edge: shoulder, then wrist and three finger tips.
    let lx = Sx;
    let ly = Sy;
    if (k > 0) {
      const i = (k - 1) * 2;
      const a0 = SPREAD[i]! + (FOLDED[i]! - SPREAD[i]!) * fold;
      const s0 = (SPREAD[i + 1]! + (FOLDED[i + 1]! - SPREAD[i + 1]!) * fold) * spanMul;
      const a = a0 - sweep * s0;
      lx = Sx + a * W * TSx + s0 * W * lift * DSx;
      ly = Sy + a * W * TSy + s0 * W * lift * DSy;
    }
    // Trailing edge: shoulder, joints 5, 7, 8 on the back, rear root at joint 9.
    let qx = Sx;
    let qy = Sy;
    if (k > 0) {
      const j = k === 1 ? 5 : k === 2 ? 7 : k === 3 ? 8 : 9;
      const f = k === 1 || k === 2 ? 1 : k === 3 ? 0.8 : 0.5;
      jointTangent(view, j);
      const rj = radiusAt(j / (ZMEU_JOINTS - 1), R);
      const rl = view.roll[j]!;
      qx = view.bodyX[j]! + rl * tan[1]! * f * rj;
      qy = view.bodyY[j]! - rl * tan[0]! * f * rj;
    }
    const u = k / 4;
    put(out, v0 + k * 2, lx, ly, u, 0, roll3, glow, r3, kind);
    put(out, v0 + k * 2 + 1, qx, qy, u, 1, roll3, glow, r3, kind);
  }
  return 10;
}

/**
 * Fills `out` with the far wing, the body strip and the near wing and records
 * their ranges. Returns the vertex count (≤ ZMEU_MESH_CAPACITY).
 */
export function buildZmeuMesh(view: ZmeuView, out: Float32Array, ranges: ZmeuMeshRanges, samples = ZMEU_BODY_SAMPLES): number {
  const n = Math.max(8, Math.min(MAX_SAMPLES, Math.floor(samples), Math.floor((ZMEU_MESH_CAPACITY - 20) / 2)));
  const L = view.pose.L;
  const R = T.radiusFrac * L;
  const J = ZMEU_JOINTS;
  const bx = view.bodyX;
  const by = view.bodyY;

  // Far wing first (drawn behind the body).
  let v = 0;
  ranges.farWing[0] = v;
  ranges.farWing[1] = buildWing(view, out, v, true, L, R);
  v += ranges.farWing[1];

  // Catmull-Rom samples, sample 0 at the neck.
  for (let s = 0; s < n; s++) {
    const t = (s / (n - 1)) * (J - 1);
    const j = Math.min(J - 2, Math.floor(t));
    const f = t - j;
    const j0 = j > 0 ? j - 1 : 0;
    const j3 = j + 2 < J ? j + 2 : J - 1;
    px[s] = cr(bx[j0]!, bx[j]!, bx[j + 1]!, bx[j3]!, f);
    py[s] = cr(by[j0]!, by[j]!, by[j + 1]!, by[j3]!, f);
  }
  // Tangents toward the head and half-spacing.
  let lx = 1;
  let ly = 0;
  for (let s = 0; s < n; s++) {
    const a = s > 0 ? s - 1 : 0;
    const b = s < n - 1 ? s + 1 : n - 1;
    let dx = px[a]! - px[b]!;
    let dy = py[a]! - py[b]!;
    const l = hyp(dx, dy);
    if (l > 1e-6) {
      dx /= l;
      dy /= l;
      lx = dx;
      ly = dy;
    } else {
      dx = lx;
      dy = ly;
    }
    tx[s] = dx;
    ty[s] = dy;
  }

  ranges.body[0] = v;
  const glow = view.pose.glow;
  for (let k = 0; k < n; k++) {
    const s = n - 1 - k; // tail → neck
    const u = s / (n - 1);
    const t = u * (J - 1);
    const j = Math.min(J - 2, Math.floor(t));
    const f = t - j;
    const roll = view.roll[j]! + (view.roll[j + 1]! - view.roll[j]!) * f;
    const r = radiusAt(u, R);
    const Tx = tx[s]!;
    const Ty = ty[s]!;
    const nx = Ty;
    const ny = -Tx;
    let extP = EXT * r;
    let extN = EXT * r;
    if (s > 0 && s < n - 1) {
      // Curvature from the neighbouring samples (Menger; the spec's tangent-difference
      // estimate smooths over a wider stencil and under-reads tight Catmull-Rom bends).
      const ax = px[s - 1]!;
      const ay = py[s - 1]!;
      const bx = px[s]!;
      const by = py[s]!;
      const cx = px[s + 1]!;
      const cy = py[s + 1]!;
      const ux = bx - ax;
      const uy = by - ay;
      const wx = cx - bx;
      const wy = cy - by;
      const den = hyp(ux, uy) * hyp(wx, wy) * hyp(cx - ax, cy - ay);
      const kappa = den > 1e-12 ? (2 * Math.abs(ux * wy - uy * wx)) / den : 0;
      if (kappa > 1e-9) {
        const lim = 0.92 / kappa;
        // The centre of curvature is on the side of the chord midpoint.
        const side = nx * ((ax + cx) * 0.5 - bx) + ny * ((ay + cy) * 0.5 - by);
        if (side > 0) extP = Math.min(extP, lim);
        else if (side < 0) extN = Math.min(extN, lim);
      }
    }
    const heat = glow * (1 - 0.55 * u);
    put(out, v, px[s]! + nx * extP, py[s]! + ny * extP, u, EXT, roll, heat, r, 0);
    put(out, v + 1, px[s]! - nx * extN, py[s]! - ny * extN, u, -EXT, roll, heat, r, 0);
    v += 2;
  }
  ranges.body[1] = v - ranges.body[0];

  ranges.nearWing[0] = v;
  ranges.nearWing[1] = buildWing(view, out, v, false, L, R);
  v += ranges.nearWing[1];
  return v;
}
