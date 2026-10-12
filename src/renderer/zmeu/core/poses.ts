/**
 * Pose targets for the spine. Perch and coil are authored in perch-local
 * units of L: x along `facing`, y up, origin on the edge, so a local point
 * (x, y) lands on screen at (ax + facing·x·L, ay − y·L). Hover is in screen
 * space. Each function fills the 24 targets of outX/outY; no allocation.
 */
import { smoothstep } from '../../util/math';
import { ZMEU_JOINTS } from './tuning';

const N = ZMEU_JOINTS;
const DEG = Math.PI / 180;

/** Head angle offsets (rad, up = positive) the poses ask for. */
export const PERCH_HEAD = 8 * DEG;
export const COIL_HEAD = -6 * DEG;
export const ROAR_PERCH_HEAD = 35 * DEG;
export const ROAR_HOVER_HEAD = 30 * DEG;

/** Coil bounding box in L (perch-local). */
export const COIL_BOX = Object.freeze({ x0: -0.27, x1: 0.27, y0: 0, y1: 0.24 });

function bez(p0: number, p1: number, p2: number, p3: number, t: number): number {
  const u = 1 - t;
  return u * u * u * p0 + 3 * u * u * t * p1 + 3 * u * t * t * p2 + t * t * t * p3;
}

/** Static perch-local shape of joint j (neck Bézier, body, draped or resting tail, tip curl), without the sway. */
function perchBase(j: number, drape: number, hx: number, hy: number, out: Float64Array): void {
  let x: number;
  let y: number;
  if (j < 4) {
    const s = j / 4;
    x = bez(hx, hx - 0.08, 0.07, 0.02, s);
    y = bez(hy, hy - 0.05, 0.12, 0.08, s);
  } else if (j <= 12) {
    const s = (j - 4) / 8;
    x = 0.02 - 0.42 * s;
    y = 0.045 + 0.025 * Math.sin(Math.PI * s);
  } else {
    const s = (j - 12) / 11;
    x = -0.4 - 0.12 * s;
    y = drape > 0 ? 0.045 * (1 - s) - 0.09 * smoothstep(0, 1, s) : 0.02 + 0.06 * smoothstep(0.7, 1, s);
    const k = j - 19;
    if (k >= 1) {
      x += 0.015 * k;
      y += 0.012 * k * k;
    }
  }
  out[0] = x;
  out[1] = y;
}

const tmp = new Float64Array(2);
// Precomputed shapes: [perch, roar] × [floor (drape 0), window (drape 1)].
const BX = [new Float64Array(N), new Float64Array(N)];
const BY0 = [new Float64Array(N), new Float64Array(N)];
const BY1 = [new Float64Array(N), new Float64Array(N)];
for (let r = 0; r < 2; r++) {
  const hx = r === 0 ? 0.1 : 0.14;
  const hy = r === 0 ? 0.27 : 0.36;
  for (let j = 0; j < N; j++) {
    perchBase(j, 0, hx, hy, tmp);
    BX[r]![j] = tmp[0]!;
    BY0[r]![j] = tmp[1]!;
    perchBase(j, 1, hx, hy, tmp);
    BY1[r]![j] = tmp[1]!;
  }
}
// Tail sway sin(1.3t + 3s) stepped by a rotation of 3/11 per joint.
const SWAY_C = Math.cos(3 / 11);
const SWAY_S = Math.sin(3 / 11);

function perchInto(outX: Float64Array, outY: Float64Array, L: number, ax: number, ay: number, facing: number, drape: number, t: number, roar: number): void {
  const d = drape < 0 ? 0 : drape > 1 ? 1 : drape;
  const bx = BX[roar]!;
  const b0 = BY0[roar]!;
  const b1 = BY1[roar]!;
  const chest = 0.004 * Math.sin((2 * Math.PI * t) / 3.2);
  let sn = Math.sin(1.3 * t);
  let cs = Math.cos(1.3 * t);
  const fL = facing * L;
  for (let j = 0; j < N; j++) {
    let x = bx[j]!;
    let y = b0[j]! + (b1[j]! - b0[j]!) * d;
    if (j >= 3 && j <= 8) y += chest;
    if (j >= 12) {
      x += 0.012 * sn;
      const ns = sn * SWAY_C + cs * SWAY_S;
      cs = cs * SWAY_C - sn * SWAY_S;
      sn = ns;
    }
    outX[j] = ax + fL * x;
    outY[j] = ay - y * L;
  }
}

/** Gargoyle-serpent perch on a ledge (drape 1: the tail hangs over a window edge; 0: rests on the floor). */
export function perchPose(outX: Float64Array, outY: Float64Array, L: number, ax: number, ay: number, facing: number, drape: number, t: number): void {
  perchInto(outX, outY, L, ax, ay, facing, drape, t, 0);
}

/** Sleeping coil: a spiral around C = (−0.10, 0.11) with the head resting at (0.08, 0.05). */
export function coilPose(outX: Float64Array, outY: Float64Array, L: number, ax: number, ay: number, facing: number, breath: number): void {
  const cx = -0.1;
  const cy = 0.11;
  for (let j = 3; j < N; j++) {
    const s = (j - 3) / 20;
    const a = Math.PI / 2 + 2 * Math.PI * 1.15 * s;
    const rho = (0.15 - 0.075 * s) * (1 + (s < 0.5 ? 0.025 * breath : 0));
    const x = cx + rho * Math.cos(a);
    const y = Math.max(0.025, cy + 0.62 * rho * Math.sin(a));
    outX[j] = ax + facing * x * L;
    outY[j] = ay - y * L;
  }
  const hx = 0.08;
  const hy = 0.05;
  const x3 = (outX[3]! - ax) / (facing * L);
  const y3 = (ay - outY[3]!) / L;
  for (let j = 0; j < 3; j++) {
    const s = j / 3;
    const x = hx + (x3 - hx) * s;
    const y = hy + (y3 - hy) * s;
    outX[j] = ax + facing * x * L;
    outY[j] = ay - y * L;
  }
}

/** Hovering: the body hangs below the head with a slow sway (screen space, y down). */
export function hoverPose(outX: Float64Array, outY: Float64Array, L: number, hx: number, hy: number, facing: number, t: number): void {
  for (let j = 0; j < N; j++) {
    const s = j / (N - 1);
    outX[j] = hx + (-facing * 0.12 * L * Math.sin(Math.PI * s) + 0.04 * L * Math.sin(2.6 * t - 5 * s));
    outY[j] = hy + 0.7 * L * s;
  }
}

/** Roar: perched → the perch pose with the head reared up to (0.14, 0.36); flying → hover (head at ax, ay). */
export function roarPose(outX: Float64Array, outY: Float64Array, L: number, ax: number, ay: number, facing: number, drape: number, t: number, perched: boolean): void {
  if (!perched) {
    hoverPose(outX, outY, L, ax, ay, facing, t);
    return;
  }
  perchInto(outX, outY, L, ax, ay, facing, drape, t, 1);
}
