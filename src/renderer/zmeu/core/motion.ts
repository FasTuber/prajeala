/**
 * The dragon's body, per substep: move the head as the brain's nav asks
 * (steered flight, posed, scripted or still), compute pose targets, run the
 * spine (follow, bend limit, pose blend, roll), aim the head, flap the wings
 * and ease the face toward the brain's targets. No allocation.
 */
import { damp } from '../../util/math';
import { COIL_HEAD, PERCH_HEAD, ROAR_HOVER_HEAD, ROAR_PERCH_HEAD, coilPose, hoverPose, perchPose, roarPose } from './poses';
import { arrive, avoidCursor, boundsPush, integrate, seek, serpentine, wanderCarrot } from './steering';
import { ZMEU_JOINTS, ZMEU_TUNING as T, ZMEU_WING } from './tuning';
import type { ZmeuWorld } from './world';
import {
  NAV_FLY,
  NAV_POSED,
  NAV_SCRIPT,
  POSE_COIL,
  POSE_HOVER,
  POSE_NONE,
  POSE_PERCH,
  POSE_ROAR_HOVER,
  POSE_ROAR_PERCH,
} from './world';
import { hyp } from './vec';

const TAU = Math.PI * 2;

/** Wraps an angle into (−π, π]. */
export function wrapAngle(a: number): number {
  a = a % TAU;
  if (a > Math.PI) a -= TAU;
  else if (a <= -Math.PI) a += TAU;
  return a;
}

/** Body segment length for the current L. */
export function segLength(L: number): number {
  return (T.bodyFrac * L) / (ZMEU_JOINTS - 1);
}

/** States that may leave the screen (no fence, no bounds). */
export function offscreenOk(w: ZmeuWorld): boolean {
  const s = w.state;
  return s === 'absent' || s === 'entering' || s === 'leaving' || s === 'sulk';
}

/** Breathing cycle while asleep, 0..1. */
export function sleepBreath(w: ZmeuWorld): number {
  return 0.5 - 0.5 * Math.cos((TAU * w.clock) / T.breathPeriodS);
}

/** Fills w.tx/ty with the current pose target. */
export function computePose(w: ZmeuWorld): void {
  const L = w.Lc;
  const p = w.perch;
  const N = ZMEU_JOINTS;
  switch (w.poseKind) {
    case POSE_PERCH:
    case POSE_ROAR_PERCH: {
      if (w.poseKind === POSE_PERCH) perchPose(w.tx, w.ty, L, p.x, p.y, p.facing, p.drape, w.clock);
      else roarPose(w.tx, w.ty, L, p.x, p.y, p.facing, p.drape, w.clock, true);
      if (w.peek > 0 || w.reachX !== 0 || w.reachY !== 0) {
        for (let j = 0; j < 4; j++) {
          const k = 1 - j / 4;
          w.tx[j] = w.tx[j]! + w.reachX * k;
          w.ty[j] = w.ty[j]! + w.reachY * k + 0.1 * L * w.peek * k;
        }
      }
      if (w.wag > 0) {
        const a = 0.03 * L * w.wag * Math.sin(TAU * 2 * w.clock);
        for (let j = 12; j < N; j++) w.tx[j] = w.tx[j]! + p.facing * a * ((j - 12) / 11);
      }
      if (w.coilMix > 0) {
        coilPose(w.cx2, w.cy2, L, p.x, p.y, p.facing, sleepBreath(w));
        const m = w.coilMix > 1 ? 1 : w.coilMix;
        for (let j = 0; j < N; j++) {
          w.tx[j] = w.tx[j]! + (w.cx2[j]! - w.tx[j]!) * m;
          w.ty[j] = w.ty[j]! + (w.cy2[j]! - w.ty[j]!) * m;
        }
      }
      break;
    }
    case POSE_COIL:
      coilPose(w.tx, w.ty, L, p.x, p.y, p.facing, sleepBreath(w));
      if (w.wag > 0) {
        // Tail flick (sleep twitch).
        const a = 0.02 * L * w.wag * Math.sin(TAU * 3 * w.clock);
        for (let j = 18; j < N; j++) w.ty[j] = w.ty[j]! - a * ((j - 17) / 6);
      }
      break;
    case POSE_HOVER:
    case POSE_ROAR_HOVER:
      hoverPose(w.tx, w.ty, L, w.x, w.y, w.facing, w.clock);
      break;
    default:
      break;
  }
}

function flyHead(w: ZmeuWorld, h: number): void {
  const n = w.nav;
  const s = w.sn;
  const S = w.S;
  if (w.loopLeft > 0) {
    // Loop-de-loop: constant speed, constant turn.
    const a = w.loopSign * T.loopTurn * h;
    const c = Math.cos(a);
    const sn = Math.sin(a);
    const vx = w.vx * c - w.vy * sn;
    const vy = w.vx * sn + w.vy * c;
    w.vx = vx;
    w.vy = vy;
    w.x += vx * h;
    w.y += vy * h;
    w.loopLeft -= h;
    return;
  }
  const d = w.desired;
  if (n.jitter) {
    w.theta += w.rng.range(-1, 1) * 3 * h;
    const c = wanderCarrot(w.tmpV, w.x, w.y, w.dirX, w.dirY, w.theta, S);
    serpentine(c, w.dirX, w.dirY, S, w.clock, n.serp);
    seek(d, w.x, w.y, c.x, c.y, n.vmax);
    const cx = d.x;
    const cy = d.y;
    arrive(d, w.x, w.y, n.tx, n.ty, n.vmax, n.slowR);
    d.x = d.x * 0.65 + cx * 0.35;
    d.y = d.y * 0.65 + cy * 0.35;
  } else {
    let tx = n.tx;
    let ty = n.ty;
    if (n.serp > 0) {
      w.tmpV.x = tx;
      w.tmpV.y = ty;
      serpentine(w.tmpV, w.dirX, w.dirY, S, w.clock, n.serp);
      tx = w.tmpV.x;
      ty = w.tmpV.y;
    }
    arrive(d, w.x, w.y, tx, ty, n.vmax, n.slowR);
  }
  if (n.bounds && !offscreenOk(w)) boundsPush(d, w.x, w.y, 0, 0, w.W, w.floor, T.boundsMargin * S, n.vmax);
  if (n.avoid && s.cursorKnown && s.cursorInside) avoidCursor(d, w.x, w.y, s.cx, s.cy, S, n.vmax);
  w.lim.vmax = n.vmax;
  w.lim.amax = n.amax;
  w.lim.omega = n.omega;
  integrate(w, d, w.lim, h);
  if (w.ball < 0.5) w.y += T.bob * S * TAU * w.wf * Math.cos(w.psi) * h;
}

/** One body substep. */
export function stepBody(w: ZmeuWorld, h: number): void {
  const s = w.sn;
  w.Lc += (s.L - w.Lc) * damp(6, h);
  const seg = segLength(w.Lc);

  // Pose weight and fly blend.
  if (w.poseW < w.poseWTarget) w.poseW = Math.min(w.poseWTarget, w.poseW + w.poseWRate * h);
  else if (w.poseW > w.poseWTarget) w.poseW = Math.max(w.poseWTarget, w.poseW - (1 / 0.3) * h);
  if (w.poseW <= 0 && w.poseWTarget <= 0) w.poseKind = POSE_NONE;
  const flyT = w.onPerch || w.poseKind === POSE_COIL ? 0 : 1;
  w.wFly += Math.max(-h / 0.35, Math.min(h / 0.35, flyT - w.wFly));

  if (w.poseKind !== POSE_NONE) computePose(w);

  // Head.
  const ox = w.x;
  const oy = w.y;
  switch (w.nav.mode) {
    case NAV_FLY:
      flyHead(w, h);
      break;
    case NAV_POSED: {
      const k = damp(12, h) * Math.max(0.3, w.poseW);
      let mx = (w.tx[0]! - w.x) * k;
      let my = (w.ty[0]! - w.y) * k;
      const ml = hyp(mx, my);
      const cap = (s.reducedMotion ? T.cruise : 2) * w.S * h;
      if (ml > cap) {
        mx *= cap / ml;
        my *= cap / ml;
      }
      w.x += mx;
      w.y += my;
      w.vx = (w.x - ox) / h;
      w.vy = (w.y - oy) / h;
      break;
    }
    case NAV_SCRIPT:
      // The state moved the head and set the velocity itself.
      break;
    default:
      w.vx = 0;
      w.vy = 0;
      break;
  }
  if (!offscreenOk(w)) {
    // Hard fence: the head stays on the display, above the floor.
    if (w.x < 1) {
      w.x = 1;
      if (w.vx < 0) w.vx = 0;
    } else if (w.x > w.W - 1) {
      w.x = w.W - 1;
      if (w.vx > 0) w.vx = 0;
    }
    if (w.y < 1) {
      w.y = 1;
      if (w.vy < 0) w.vy = 0;
    } else if (w.y > w.floor - 1) {
      w.y = w.floor - 1;
      if (w.vy > 0) w.vy = 0;
    }
  }
  w.speed = hyp(w.vx, w.vy);
  if (w.speed > 20) {
    w.dirX = w.vx / w.speed;
    w.dirY = w.vy / w.speed;
  }

  // Facing: the perch decides when sitting; otherwise flips with hysteresis.
  if (w.onPerch && w.poseKind !== POSE_NONE && w.poseKind !== POSE_HOVER && w.poseKind !== POSE_ROAR_HOVER) w.facing = w.perch.facing;
  else if (w.faceLock !== 0) w.facing = w.faceLock;
  else if (w.speed > 20) {
    if (w.dirX > 0.25) w.facing = 1;
    else if (w.dirX < -0.25) w.facing = -1;
  }

  // Spine.
  const sp = w.spine;
  if (w.poseW >= 1 && w.poseKind !== POSE_NONE && sp.seg === seg) {
    // Fully posed: the blend + restore below keep the chain; no need to drag it first.
    sp.x[0] = w.x;
    sp.y[0] = w.y;
  } else sp.follow(w.x, w.y, seg);
  if (w.poseW < 0.5) sp.bendLimit();
  if (w.poseW > 0 && w.poseKind !== POSE_NONE) {
    sp.blendToward(w.tx, w.ty, w.poseK, w.poseW, h);
    sp.restoreLengths(1);
  }
  sp.updateRoll(w.facing, h);

  aimHead(w, h);
  flapWings(w, h);
  easeFace(w, h);
}

function aimHead(w: ZmeuWorld, h: number): void {
  const sp = w.spine;
  const neck = Math.atan2(sp.y[0]! - sp.y[1]!, sp.x[0]! - sp.x[1]!);
  const f = w.facing;
  let base: number;
  let clampR = 0.9;
  const pk = w.poseKind;
  const posed = w.poseW > 0.5;
  if (posed && w.onPerch && (pk === POSE_PERCH || pk === POSE_ROAR_PERCH || pk === POSE_COIL)) {
    let up = pk === POSE_ROAR_PERCH ? ROAR_PERCH_HEAD : pk === POSE_COIL ? COIL_HEAD : PERCH_HEAD;
    up = up + (COIL_HEAD - up) * Math.min(1, w.coilMix) - 0.45 * w.peek;
    base = f > 0 ? -up : Math.PI + up;
    clampR = 1.7;
  } else if (posed && (pk === POSE_HOVER || pk === POSE_ROAR_HOVER)) {
    const up = pk === POSE_ROAR_HOVER ? ROAR_HOVER_HEAD : 0;
    base = f > 0 ? -up : Math.PI + up;
    clampR = 1.7;
  } else if (w.speed > 20) {
    base = neck + wrapAngle(Math.atan2(w.vy, w.vx) - neck) * 0.7;
  } else {
    base = neck;
  }
  base += f > 0 ? -w.headOffset : w.headOffset;
  if (w.gazeOn) {
    const ga = Math.atan2(w.gazeY - w.y, w.gazeX - w.x);
    const d = wrapAngle(ga - base) * 0.35;
    base += d < -0.4 ? -0.4 : d > 0.4 ? 0.4 : d;
  }
  const rel = wrapAngle(base - neck);
  base = neck + (rel < -clampR ? -clampR : rel > clampR ? clampR : rel);
  w.headAng = wrapAngle(w.headAng + wrapAngle(base - w.headAng) * damp(8, h));
  w.headDirX = Math.cos(w.headAng);
  w.headDirY = Math.sin(w.headAng);
  // Pupil look direction in head-local units (x toward the snout, y toward the back).
  if (w.gazeOn) {
    let gx = w.gazeX - w.x;
    let gy = w.gazeY - w.y;
    const gl = hyp(gx, gy);
    if (gl > 1e-6) {
      gx /= gl;
      gy /= gl;
    }
    const lx = gx * w.headDirX + gy * w.headDirY;
    const ly = (gx * w.headDirY - gy * w.headDirX) * f;
    w.lookX += (lx - w.lookX) * damp(10, h);
    w.lookY += (ly - w.lookY) * damp(10, h);
  } else {
    w.lookX += (0 - w.lookX) * damp(4, h);
    w.lookY += (0 - w.lookY) * damp(4, h);
  }
}

function flapWings(w: ZmeuWorld, h: number): void {
  const p = w.flapBoostUntil > w.clock ? ZMEU_WING.flee : w.wingPreset;
  const k = damp(w.wingRate, h);
  w.wf += (p.f - w.wf) * k;
  w.wamp += (p.amp - w.wamp) * k;
  w.wbias += (p.bias - w.wbias) * k;
  w.wfold += (p.fold - w.wfold) * k;
  w.wspan += (p.span - w.wspan) * k;
  w.psi += TAU * w.wf * h;
  if (w.psi > TAU) w.psi -= TAU;
  const prev = w.phi;
  w.phi = w.wbias + w.wamp * Math.sin(w.psi + 0.35 * Math.sin(w.psi));
  w.wingVel = (w.phi - prev) / h;
}

function easeFace(w: ZmeuWorld, h: number): void {
  w.jaw += (w.jawT - w.jaw) * damp(14, h);
  w.eyeOpen += (w.eyeT - w.eyeOpen) * damp(30, h);
  w.pupil += (w.pupilT - w.pupil) * damp(10, h);
  w.slant += (w.slantT - w.slant) * damp(8, h);
  w.happy += (w.happyT - w.happy) * damp(6, h);
  w.glow += (w.glowT - w.glow) * damp(6, h);
  w.crust += (w.crustT - w.crust) * damp(2, h);
  w.charge += (w.chargeT - w.charge) * damp(6, h);
  w.sleep += (w.sleepT - w.sleep) * damp(2, h);
  const fd = w.fadeT - w.fade;
  w.fade += Math.max(-w.fadeRate * h, Math.min(w.fadeRate * h, fd));
  const bd = w.ballT - w.ball;
  w.ball += Math.max(-h / 0.35, Math.min(h / 0.35, bd));
  w.flash = Math.max(0, w.flash - h / 0.15);
}
