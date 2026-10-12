/**
 * The dragon's brain: perception, the transition priority (`decide`, pure)
 * and table-driven per-state enter/update functions. It steers the body only
 * through the world's nav, pose and face targets; motion.ts does the physics.
 * Brain timers run on `w.bclock` (scaled by timerScale, frozen by hold);
 * animation runs on `w.clock`.
 */
import type { TemperTuning } from '../../../shared/zmeu';
import { ZMEU_TEMPER } from '../../../shared/zmeu';
import { smoothstep } from '../../util/math';
import type { ZmeuBodyShape } from './gestures';
import { closingSpeed, hitsBody, isPetting } from './gestures';
import { segLength } from './motion';
import type { ZmeuBreathPlan, ZmeuPerch } from './perches';
import { breathPlan, copyPerch, floorPerches, pickWindowPerch, sleepPerch, windowSpan, classifyWindowChange } from './perches';
import { coilPose, perchPose } from './poses';
import type { ZmeuSenses } from './senses';
import type { ZmeuEmote, ZmeuState } from './tuning';
import { ZMEU_EVENT as EV, ZMEU_TUNING as T, ZMEU_WING, ZmeuEmote as EM } from './tuning';
import type { ZmeuWorld } from './world';
import { NAV_FLY, NAV_POSED, NAV_SCRIPT, NAV_STILL, POSE_COIL, POSE_HOVER, POSE_NONE, POSE_PERCH, POSE_ROAR_HOVER, POSE_ROAR_PERCH } from './world';
import { hyp } from './vec';

type EnterFn = (w: ZmeuWorld, s: ZmeuSenses) => void;
type UpdateFn = (w: ZmeuWorld, s: ZmeuSenses, bh: number, h: number) => void;

const NEVER = -1e9;

// ---------------------------------------------------------------- helpers

export function temperOf(s: Readonly<ZmeuSenses>): TemperTuning {
  return Object.prototype.hasOwnProperty.call(ZMEU_TEMPER, s.temper) ? ZMEU_TEMPER[s.temper] : ZMEU_TEMPER.playful;
}

/** Quiet mode: the user is busy, so no showing off. */
export function isQuiet(s: Readonly<ZmeuSenses>): boolean {
  return s.typingRecent || s.buttonHeld || s.focusTicking;
}

/** Idle seconds before a nap. */
export function napAfter(s: Readonly<ZmeuSenses>): number {
  return s.idleSleepS > 0 ? Math.min(90, Math.max(20, 0.5 * s.idleSleepS)) : 60;
}

function cursorOn(s: Readonly<ZmeuSenses>): boolean {
  return s.cursorKnown && s.cursorInside;
}

function ev(w: ZmeuWorld, bit: number): void {
  w.events |= bit;
}

/** Shows an emote: one at a time, at least 1.5 s apart (alert overrides). */
export function emote(w: ZmeuWorld, kind: ZmeuEmote): void {
  if (kind !== EM.alert && w.bclock - w.lastEmoteAt < 1.5) return;
  w.emoteKind = kind;
  w.emoteAge = 0;
  w.lastEmoteAt = w.bclock;
}

function countSince(a: Float64Array, t0: number): number {
  let n = 0;
  for (let i = 0; i < a.length; i++) if (a[i]! >= t0) n++;
  return n;
}

function pushTime(a: Float64Array, t: number): void {
  let oldest = 0;
  for (let i = 1; i < a.length; i++) if (a[i]! < a[oldest]!) oldest = i;
  a[oldest] = t;
}

function speedPx(w: ZmeuWorld, s: Readonly<ZmeuSenses>, frac: number): number {
  const v = frac * w.S;
  return s.reducedMotion ? Math.min(v, T.cruise * w.S) : v;
}

function navTo(w: ZmeuWorld, s: Readonly<ZmeuSenses>, tx: number, ty: number, frac: number, fast = false): void {
  const n = w.nav;
  n.mode = NAV_FLY;
  n.tx = tx;
  n.ty = ty;
  n.vmax = speedPx(w, s, frac);
  n.amax = (fast ? T.accelFast : T.accel) * w.S;
  n.omega = fast ? T.turnFast : T.turn;
  n.slowR = T.slowRadius * w.S;
  n.jitter = false;
  n.serp = 0;
  n.bounds = true;
  n.avoid = true;
}

function navPosed(w: ZmeuWorld): void {
  w.nav.mode = NAV_POSED;
}

function navScript(w: ZmeuWorld): void {
  w.nav.mode = NAV_SCRIPT;
}

function margin(w: ZmeuWorld): number {
  return T.boundsMargin * w.S;
}

function clampX(w: ZmeuWorld, x: number): number {
  const m = margin(w);
  return Math.min(w.W - m, Math.max(m, x));
}

function clampY(w: ZmeuWorld, y: number): number {
  const m = margin(w);
  return Math.min(w.floor - m, Math.max(m, y));
}

/** Head target (joint 0) of the perch pose on `p`. */
function perchHeadX(w: ZmeuWorld, p: ZmeuPerch): number {
  return p.x + p.facing * 0.1 * w.Lc;
}

function perchHeadY(w: ZmeuWorld, p: ZmeuPerch): number {
  return p.y - 0.27 * w.Lc;
}

/** Inside the active window's content (below a 30 px title bar). */
export function overContent(s: Readonly<ZmeuSenses>, x: number, y: number): boolean {
  const r = s.win;
  if (!r || s.winMaximized) return false;
  return x >= r.x && x <= r.x + r.width && y >= r.y + 30 && y <= r.y + r.height;
}

function isBusy(w: ZmeuWorld, x: number, y: number): boolean {
  const d = 0.3 * w.Lc;
  for (let i = 0; i < w.busyUntil.length; i++) {
    if (w.busyUntil[i]! > w.bclock && Math.abs(w.busyX[i]! - x) < d && Math.abs(w.busyY[i]! - y) < d) return true;
  }
  return false;
}

function markBusy(w: ZmeuWorld, x: number, y: number): void {
  const i = w.busyNext;
  w.busyX[i] = x;
  w.busyY[i] = y;
  w.busyUntil[i] = w.bclock + T.hopBusyS;
  w.busyNext = (i + 1) % w.busyUntil.length;
}

/** A window perch that is not busy (one retry), into `out`. */
function windowPerch(w: ZmeuWorld, s: Readonly<ZmeuSenses>, out: ZmeuPerch): boolean {
  for (let k = 0; k < 2; k++) {
    if (!pickWindowPerch(s, w.rng, out)) return false;
    if (!isBusy(w, out.x, out.y)) return true;
  }
  return false;
}

/** A floor perch: the nearest to (nx, ny), or a random one preferring spots not under the window. */
function floorPerch(w: ZmeuWorld, s: Readonly<ZmeuSenses>, nx: number, ny: number, nearest: boolean, out: ZmeuPerch): ZmeuPerch {
  const fl = floorPerches(s, w.floors);
  const r = w.rng.next();
  let best = -1;
  let bestScore = Infinity;
  for (let i = 0; i < fl.length; i++) {
    const p = fl[i]!;
    let score = nearest ? hyp(p.x - nx, p.y - ny) : ((i + r * fl.length) % fl.length) * 10;
    if (isBusy(w, p.x, p.y)) score += 1e6;
    const win = s.win;
    if (!nearest && win && p.x > win.x && p.x < win.x + win.width) score += 100;
    if (score < bestScore) {
      bestScore = score;
      best = i;
    }
  }
  return copyPerch(out, fl[best < 0 ? 0 : best]!);
}

/** Lays the spine out straight at (x, y), tail opposite (dx, dy); flying. */
function spawnStraight(w: ZmeuWorld, x: number, y: number, dx: number, dy: number): void {
  w.spine.reset(x, y, dx, dy, segLength(w.Lc));
  w.x = x;
  w.y = y;
  w.vx = 0;
  w.vy = 0;
  w.dirX = dx;
  w.dirY = dy;
  w.onPerch = false;
  w.poseKind = POSE_NONE;
  w.poseW = 0;
  w.poseWTarget = 0;
  w.coilMix = 0;
  w.peek = 0;
  w.facing = dx >= 0 ? 1 : -1;
  w.spine.roll.fill(w.facing);
  w.headAng = Math.atan2(dy, dx);
  w.wFly = 1;
}

/** Puts the dragon straight onto a perch, already in pose (perch or coil). */
export function snapPerch(w: ZmeuWorld, p: ZmeuPerch, coil: boolean): void {
  copyPerch(w.perch, p);
  w.onPerch = true;
  w.poseKind = coil ? POSE_COIL : POSE_PERCH;
  w.coilMix = 0;
  w.peek = 0;
  w.facing = p.facing;
  if (coil) coilPose(w.tx, w.ty, w.Lc, p.x, p.y, p.facing, 0);
  else perchPose(w.tx, w.ty, w.Lc, p.x, p.y, p.facing, p.drape, w.clock);
  const sp = w.spine;
  for (let i = 0; i < sp.n; i++) {
    sp.x[i] = w.tx[i]!;
    sp.y[i] = w.ty[i]!;
  }
  sp.seg = segLength(w.Lc);
  sp.restoreLengths(1);
  sp.roll.fill(p.facing);
  w.x = sp.x[0]!;
  w.y = sp.y[0]!;
  w.vx = 0;
  w.vy = 0;
  w.poseW = 1;
  w.poseWTarget = 1;
  w.poseK = coil ? 2.2 : 7;
  w.wFly = 0;
  w.headAng = p.facing > 0 ? 0 : Math.PI;
  w.nav.mode = NAV_POSED;
}

/** Leaves the perch with an upward kick and a burst of fast flaps. */
function takeoff(w: ZmeuWorld, s: Readonly<ZmeuSenses>): void {
  if (!w.onPerch) return;
  w.onPerch = false;
  w.poseWTarget = 0;
  w.coilMix = 0;
  w.peek = 0;
  let vx = w.facing * 0.3 * w.S;
  let vy = -0.4 * w.S;
  const vm = speedPx(w, s, 1);
  const l = hyp(vx, vy);
  if (l > vm) {
    vx *= vm / l;
    vy *= vm / l;
  }
  w.vx = vx;
  w.vy = vy;
  w.flapBoostUntil = w.clock + 0.4;
  ev(w, EV.TAKEOFF);
}

const shape = {
  bodyX: new Float32Array(0) as ArrayLike<number>,
  bodyY: new Float32Array(0) as ArrayLike<number>,
  R: 1,
  L: 1,
  dirX: 1,
  dirY: 0,
};

/** The current body as a hit-test shape (display spine of the last frame). */
export function bodyShape(w: ZmeuWorld): ZmeuBodyShape {
  shape.bodyX = w.bodyX;
  shape.bodyY = w.bodyY;
  shape.R = T.radiusFrac * w.Lc;
  shape.L = w.Lc;
  shape.dirX = w.headDirX;
  shape.dirY = w.headDirY;
  return shape;
}

const scratchPlan: ZmeuBreathPlan = { hoverX: 0, hoverY: 0, x0: 0, x1: 0, edgeY: 0, side: 1 };
const scratchSpan = { x0: 0, x1: 0 };

function breathKeyRecent(w: ZmeuWorld, key: number): boolean {
  for (let i = 0; i < w.breathKeys.length; i++) {
    if (w.breathKeys[i] === key && w.bclock - w.breathKeyAt[i]! < T.breathKeyGapS) return true;
  }
  return false;
}

/** All the gates for a breath at the new window (the dice were rolled on detection). */
export function canBreathe(w: ZmeuWorld, s: Readonly<ZmeuSenses>): boolean {
  const t = temperOf(s);
  if (!(t.breathChance > 0) || w.winRoll >= t.breathChance) return false;
  if (w.bclock - w.lastBreathAt < t.bigCooldownS) return false;
  if (breathKeyRecent(w, s.winKey)) return false;
  return breathPlan(s.win, w.x, w.y, s, w.rng, scratchPlan);
}

function viaDelay(w: ZmeuWorld): number {
  if (w.reenterEdge) return 0.3;
  const v = w.homeVia;
  return v === 'edge' || v === 'sky' ? 0.3 : 0;
}

function startleable(st: ZmeuState): boolean {
  return st === 'wander' || st === 'landing' || st === 'perched' || st === 'curious' || st === 'hop' || st === 'cheer';
}

function awake(st: ZmeuState): boolean {
  return st !== 'absent' && st !== 'entering' && st !== 'leaving' && st !== 'sulk' && st !== 'asleep' && st !== 'drowsy' && st !== 'waking';
}

// ---------------------------------------------------------------- decide

/**
 * Transition priority (spec 4.4). Pure: reads the world and senses, returns the
 * next state or null. Per-state timers (rule 11) live in the update functions.
 */
export function decide(w: ZmeuWorld, s: Readonly<ZmeuSenses>): ZmeuState | null {
  const st = w.state;
  // 1. Not home, or switched off.
  if (!w.home || !w.enabled) return st === 'leaving' || st === 'absent' ? null : 'leaving';
  // 2. Arrive after the via delay.
  if (st === 'absent') return w.bclock >= w.absentUntil && w.bclock - w.homeSince >= viaDelay(w) ? 'entering' : null;
  if (st === 'leaving') return w.leaveForced ? null : 'wander';
  if (st === 'entering' || st === 'sulk') return null;
  const quiet = isQuiet(s);
  // 3. Pokes.
  if (w.pokeNow) {
    if (countSince(w.pokeTimes, w.bclock - 6) >= 3) return 'sulk';
    if (st === 'asleep') return 'waking';
    if (st !== 'startled' && st !== 'waking') return 'startled';
  }
  // Riding a window that jumped, changed or vanished.
  if (w.rideJump > 0 && w.onPerch && w.perch.window && st !== 'hop' && st !== 'waking') {
    if (st === 'asleep') return 'waking';
    if (w.rideJump === 2) return 'startled';
    if (!w.winNew || quiet || st === 'drowsy') return 'wander';
  }
  // 4. Power sleep and naps.
  if (st !== 'waking' && st !== 'drowsy' && st !== 'asleep') {
    if (s.powerSleeping) return 'drowsy';
    // The spec names perched and wander; landing is part of the same idle cycle.
    if ((st === 'perched' || st === 'wander' || st === 'landing') && !s.focusTicking && s.inputIdleS >= napAfter(s)) return 'drowsy';
  }
  if (st === 'drowsy' && !w.coilDone && w.inputPulse && !s.powerSleeping) return w.onPerch ? 'perched' : 'wander';
  if (st === 'asleep' && !s.powerSleeping && (w.wakePulse || w.panic)) return 'waking';
  // 5. Chase / panic.
  if (w.panic && startleable(st)) return 'startled';
  // 6. Make way for a resting pointer, or for typing next to the perch.
  if ((w.restTime >= T.restS || w.typingHop) && w.onPerch && (st === 'perched' || (st === 'curious' && w.curiousPerched))) return 'hop';
  // 7. Petting.
  if (w.petting && (st === 'perched' || st === 'curious' || st === 'wander' || st === 'landing')) return 'pet';
  // 8. Cheer the burn.
  if (s.burnTarget && (st === 'wander' || st === 'perched' || st === 'curious' || st === 'landing')) return 'cheer';
  if (st === 'cheer' && !s.burnTarget) return 'wander';
  // Called by the user (tray / settings): come and look.
  if (w.callPending && awake(st) && st !== 'curious') return 'curious';
  // 9. Curiosity.
  if ((st === 'wander' || st === 'perched') && w.stillNear >= T.curiousAt && !quiet && w.bclock >= w.curiousCooldownUntil && w.bclock >= w.curiousOffUntil) {
    return 'curious';
  }
  // 10. A new active window.
  if (w.winNew && !quiet && (st === 'wander' || st === 'perched' || st === 'curious' || st === 'landing')) {
    if (canBreathe(w, s)) return 'breathe';
    if (windowSpan(s, scratchSpan) && !(w.onPerch && w.perch.window && st !== 'landing' && w.rideJump === 0)) return 'landing';
    if (w.rideJump > 0) return 'wander';
  }
  return null;
}

// ---------------------------------------------------------------- transitions

export function go(w: ZmeuWorld, s: ZmeuSenses, next: ZmeuState): void {
  w.prevState = w.state;
  w.state = next;
  w.stateAge = 0;
  w.phase = 0;
  w.phaseAge = 0;
  w.stateTimer = 0;
  w.loopLeft = 0;
  w.headOffset = 0;
  w.reachX = 0;
  w.reachY = 0;
  w.faceLock = 0;
  w.breathPower = 0;
  w.wingRate = 6;
  w.fadeRate = 2;
  ENTER[next](w, s);
}

function nextPhase(w: ZmeuWorld): void {
  w.phase++;
  w.phaseAge = 0;
}

/** Straight, at the safe-rect centre, wandering: the last resort after a numeric blow-up. */
export function resetBody(w: ZmeuWorld, s: ZmeuSenses): void {
  w.resets++;
  const cx = w.W / 2;
  const cy = Math.max(1, w.floor / 2);
  w.Lc = s.L;
  spawnStraight(w, cx, cy, 1, 0);
  w.headAng = 0;
  w.headDirX = 1;
  w.headDirY = 0;
  w.jaw = w.jawT = 0.03;
  w.eyeOpen = 1;
  w.pupil = 1;
  w.slant = 0;
  w.happy = 0;
  w.glow = 1;
  w.crust = 0.8;
  w.charge = 0;
  w.chargeFront = 1;
  w.sleep = 0;
  w.fade = 1;
  w.ball = 0;
  w.ballT = 0;
  w.flash = 0;
  w.phi = 0;
  w.psi = 0;
  w.wingVel = 0;
  w.lookX = 0;
  w.lookY = 0;
  w.chaseC = 0;
  w.stillNear = 0;
  w.theta = 0;
  if (w.state === 'absent' || w.state === 'leaving') return;
  go(w, s, 'wander');
}

// ---------------------------------------------------------------- perception

/** Once per step: window changes and riding, gestures, resting pointer, typing next to the perch. */
export function perceiveFrame(w: ZmeuWorld, s: ZmeuSenses, dt: number): void {
  const S = w.S;
  const win = s.win;
  const change = classifyWindowChange(w.hadWin ? w.prevWin : null, win, w.prevWinKey, s.winKey, S);
  if (change === 'new' && win) {
    w.winNew = true;
    w.winRoll = w.rng.next();
  }
  if (w.onPerch && w.perch.window && w.state !== 'absent') {
    let leave = 0;
    if (!win || s.winMaximized || (w.hadWin && w.prevWinKey !== s.winKey)) leave = 1;
    else if (w.hadWin) {
      const fx = w.perch.fx;
      const jump = hyp(win.x + fx * win.width - (w.prevWin.x + fx * w.prevWin.width), win.y - w.prevWin.y);
      if (jump > 0.3 * S) leave = 2;
      else if (jump > 0.12 * S || Math.abs(win.width - w.prevWin.width) > 0.2 * w.prevWin.width) leave = 1;
    }
    if (!windowSpan(s, scratchSpan)) leave = Math.max(leave, 1);
    w.rideJump = leave;
  }
  if (win) {
    w.prevWin.x = win.x;
    w.prevWin.y = win.y;
    w.prevWin.width = win.width;
    w.prevWin.height = win.height;
    w.hadWin = true;
  } else w.hadWin = false;
  w.prevWinKey = s.winKey;

  const vis = w.state !== 'absent';
  const on = vis && cursorOn(s);
  const b = bodyShape(w);
  const now = w.ringNow + (w.clock - w.ringClock);
  w.petting = vis && w.ring.count > 0 && isPetting(w.ring, now, b);
  if (on && s.cspeed < T.restSpeed && hitsBody(b, s.cx, s.cy, T.restPad)) w.restTime += dt;
  else w.restTime = Math.min(0, w.restTime + dt);
  w.typingHop = w.keyPulse && s.typingRecent && w.onPerch && on && hyp(s.cx - w.perch.x, s.cy - w.perch.y) < 0.6 * w.Lc && w.bclock - w.lastHopAt > 2;
}

/** Per substep: curiosity build-up and the chase accumulator. */
function perceiveSubstep(w: ZmeuWorld, s: ZmeuSenses, h: number): void {
  const on = w.state !== 'absent' && cursorOn(s);
  const d = on ? hyp(s.cx - w.x, s.cy - w.y) : Infinity;
  const gain = s.torch ? 1.5 : 1;
  if (on && s.cspeed < T.stillNearSpeed && d < T.stillNearRange * w.Lc) w.stillNear = Math.min(3, w.stillNear + h * gain);
  else w.stillNear = Math.max(0, w.stillNear - 2 * h);

  w.chaseC *= Math.exp(-T.chaseDecay * h);
  w.panic = false;
  const petting = w.petting || w.state === 'pet';
  if (on && d < T.chaseRange * w.S && !petting) {
    const app = closingSpeed(w.x, w.y, s.cx, s.cy, s.cvx, s.cvy);
    w.chaseC += (h * Math.max(0, app - T.chaseThreshold)) / T.chaseScale;
    w.panic = w.chaseC >= 1 || (d < T.panicRange * w.S && app > T.panicSpeed);
  }
  if (w.bclock < w.immuneUntil) w.panic = false;
}

/** Riding: a window-perched dragon follows its window (damped at 10/s); a floor perch follows the floor line. */
function ride(w: ZmeuWorld, s: ZmeuSenses, h: number): void {
  if (!w.onPerch) return;
  const p = w.perch;
  let tx = p.x;
  let ty: number;
  if (p.window) {
    const win = s.win;
    if (!win || w.rideJump > 0) return;
    tx = win.x + p.fx * win.width;
    ty = win.y;
  } else ty = s.floor;
  const k = 1 - Math.exp(-10 * h);
  const dx = (tx - p.x) * k;
  const dy = (ty - p.y) * k;
  if (Math.abs(dx) < 1e-9 && Math.abs(dy) < 1e-9) return;
  p.x += dx;
  p.y += dy;
  w.spine.translate(dx, dy);
  w.x += dx;
  w.y += dy;
}

// ---------------------------------------------------------------- per substep

/** One brain substep (before the body moves). */
export function think(w: ZmeuWorld, s: ZmeuSenses, h: number, first: boolean): void {
  const bh = w.hold ? 0 : h * w.timerScale;
  w.bclock += bh;
  w.stateAge += bh;
  w.phaseAge += bh;
  perceiveSubstep(w, s, h);

  // Face defaults; states override.
  w.jawT = 0.03;
  w.eyeT = 1;
  w.pupilT = 1;
  w.slantT = 0;
  w.glowT = 1;
  w.crustT = 0.8;
  w.sleepT = 0;
  w.chargeT = 0;
  w.happyT = w.happyUntil > w.bclock ? 1 : 0;
  w.ballT = 0;
  w.fadeT = 1;
  w.headOffset = 0;
  w.wag = 0;
  w.stretch = 0;
  w.breathPower = 0;

  if (!w.hold) {
    const next = decide(w, s);
    if (next !== null) {
      w.inspectWin = next === 'landing' && w.winNew;
      go(w, s, next);
    }
  }
  if (first) {
    w.pokeNow = false;
    w.winNew = false;
    w.rideJump = 0;
    w.typingHop = false;
    w.inputPulse = false;
    w.wakePulse = false;
    w.keyPulse = false;
  }
  ride(w, s, h);
  UPDATE[w.state](w, s, bh, h);
  common(w, s, bh, h);
}

/** After the body moved: constraints that need the new head position. */
export function afterMotion(w: ZmeuWorld, s: ZmeuSenses): void {
  if (w.state === 'curious' && !w.curiousPerched && cursorOn(s)) {
    // Personal space: never closer than Dp to the cursor while hovering.
    const dp = Math.max(0.45 * w.Lc, 90);
    const dx = w.x - s.cx;
    const dy = w.y - s.cy;
    const d = hyp(dx, dy);
    if (d < dp) {
      const k = d > 1e-6 ? dp / d : 1;
      const nx = Math.min(w.W - 1, Math.max(1, d > 1e-6 ? s.cx + dx * k : s.cx + dp));
      const ny = Math.min(w.floor - 1, Math.max(1, d > 1e-6 ? s.cy + dy * k : s.cy));
      w.spine.translate(nx - w.x, ny - w.y);
      w.x = nx;
      w.y = ny;
    }
  }
}

function common(w: ZmeuWorld, s: ZmeuSenses, bh: number, h: number): void {
  const st = w.state;
  const sleepy = st === 'asleep' || (st === 'drowsy' && w.phase >= 3) || (st === 'waking' && w.phase === 0) || st === 'absent';
  // Blinks.
  if (!sleepy) {
    if (w.bclock >= w.blinkAt) {
      w.blinkLeft = 0.14;
      w.blinkDouble = w.rng.next() < 0.15;
      w.blinkAt = w.bclock + w.rng.range(2.5, 6);
      w.animUntil = Math.max(w.animUntil, w.bclock + 0.3);
    }
    if (w.blinkLeft > 0) {
      w.blinkLeft -= bh;
      w.eyeT = 0;
      if (w.blinkLeft <= 0 && w.blinkDouble) {
        w.blinkDouble = false;
        w.blinkAt = w.bclock + 0.12;
      }
    }
  }
  // Emote life.
  if (w.emoteKind !== EM.none) {
    w.emoteAge += bh;
    if (w.emoteAge > 1.1) {
      w.emoteKind = EM.none;
      w.emoteAge = 0;
    }
  }
  if (w.roarRingAge >= 0) {
    w.roarRingAge += h;
    if (w.roarRingAge > 0.55) w.roarRingAge = -1;
  }
  // Gaze: a glance, else the cursor when near, else straight ahead.
  if (sleepy && w.peekEyeUntil <= w.bclock) w.gazeOn = false;
  else if (w.glanceUntil > w.bclock) {
    w.gazeOn = true;
    w.gazeX = w.glanceX;
    w.gazeY = w.glanceY;
  } else if (cursorOn(s) && hyp(s.cx - w.x, s.cy - w.y) < 3 * w.Lc) {
    w.gazeOn = true;
    w.gazeX = s.cx;
    w.gazeY = s.cy;
  } else w.gazeOn = false;
  if (w.breathPower > 0) w.breathAge += h;
  else w.breathAge = 0;
}

// ---------------------------------------------------------------- states

function enterAbsent(w: ZmeuWorld): void {
  w.leaveForced = false;
  w.nav.mode = NAV_STILL;
  w.onPerch = false;
  w.poseKind = POSE_NONE;
  w.poseW = 0;
  w.poseWTarget = 0;
  w.fade = 0;
  w.ball = 0;
  w.emoteKind = EM.none;
  w.roarRingAge = -1;
  w.vx = 0;
  w.vy = 0;
}

function updateAbsent(w: ZmeuWorld): void {
  w.nav.mode = NAV_STILL;
  w.fadeT = 0;
}

function enterEntering(w: ZmeuWorld, s: ZmeuSenses): void {
  const via = w.reenterEdge ? 'edge' : (w.homeVia ?? 'puff');
  w.enterVia = via;
  w.fade = 1;
  w.ball = 0;
  w.enterRoar = false;
  const S = w.S;
  if (s.powerSleeping) {
    // It arrives already asleep, curled on a floor perch.
    snapPerch(w, floorPerch(w, s, w.W / 2, w.floor, true, w.tmpPerch), true);
    w.fade = 0;
    w.sleptBase = 0;
    go(w, s, 'asleep');
    return;
  }
  if (via === 'edge') {
    const edge = w.reenterEdge ?? w.homeEdge ?? 'left';
    const at = w.reenterEdge ? w.reenterAt : w.homeAt;
    const ay = Math.min(w.floor - 0.1 * S, Math.max(0.1 * S, at));
    const ax = Math.min(0.95 * w.W, Math.max(0.05 * w.W, at));
    let x = -0.15 * S;
    let y = ay;
    let dx = 1;
    let dy = 0;
    if (edge === 'right') {
      x = w.W + 0.15 * S;
      dx = -1;
    } else if (edge === 'top') {
      x = ax;
      y = -0.15 * S;
      dx = 0;
      dy = 1;
    } else if (edge === 'bottom') {
      x = ax;
      y = w.H + 0.15 * S;
      dx = 0;
      dy = -1;
    }
    spawnStraight(w, x, y, dx, dy);
    const v = speedPx(w, s, T.entering);
    w.vx = dx * v;
    w.vy = dy * v;
    if (w.reenterEdge) {
      w.glanceX = x - dx * S;
      w.glanceY = y - dy * S;
      w.glanceUntil = w.bclock + 1.2;
    }
    w.reenterEdge = null;
    w.phase = 0;
    return;
  }
  if (via === 'puff') {
    snapPerch(w, floorPerch(w, s, cursorOn(s) ? s.cx : w.W / 2, w.floor, true, w.tmpPerch), false);
    w.fade = 0;
    w.phase = 10;
    return;
  }
  // sky / hello: a fireball falls from above.
  const hx = via === 'hello' && s.cursorKnown ? s.cx : via === 'sky' ? w.homeAt : w.W / 2;
  const x = Math.min(0.9 * w.W, Math.max(0.1 * w.W, hx));
  spawnStraight(w, x, -0.1 * S, 0, 1);
  w.ball = 1;
  w.vx = 0;
  w.vy = speedPx(w, s, T.skyFall);
  w.phase = 20;
}

function updateEntering(w: ZmeuWorld, s: ZmeuSenses, _bh: number, h: number): void {
  const t = temperOf(s);
  switch (w.phase) {
    case 0: // edge: heading locked for 0.6 s
      navScript(w);
      w.x += w.vx * h;
      w.y += w.vy * h;
      w.wingPreset = ZMEU_WING.cruise;
      if (w.phaseAge >= 0.6) go(w, s, 'wander');
      return;
    case 10: // puff: fade in on the perch
      navPosed(w);
      w.wingPreset = ZMEU_WING.perched;
      w.fadeRate = 2;
      if (w.phaseAge >= 0.5) {
        w.landedAt = w.bclock;
        go(w, s, 'perched');
      }
      return;
    case 20: // falling fireball
      navScript(w);
      w.ballT = 1;
      w.vx = 0;
      w.vy = speedPx(w, s, T.skyFall);
      w.y += w.vy * h;
      if (w.y >= 0.3 * w.H) {
        ev(w, EV.UNFURL);
        w.vy *= 0.3;
        nextPhase(w);
        w.phase = 21;
        if (w.enterVia === 'hello') emote(w, EM.alert);
      }
      return;
    case 21: // unfurl
      navTo(w, s, w.x, w.y, T.hover);
      w.nav.bounds = false;
      w.wingPreset = ZMEU_WING.hover;
      if (w.phaseAge >= 0.35) {
        if (w.enterVia !== 'hello') {
          go(w, s, 'wander');
          return;
        }
        w.phase = 22;
        w.phaseAge = 0;
        if (!s.reducedMotion) {
          const v = speedPx(w, s, T.cruise);
          const dir = cursorOn(s) && s.cx < w.x ? -1 : 1;
          w.vx = dir * v;
          w.vy = 0;
          w.loopLeft = T.loopS;
          w.loopSign = dir > 0 ? -1 : 1;
          w.lastLoopAt = w.bclock;
        }
      }
      return;
    case 22: // hello loop, then land by the cursor
      navTo(w, s, w.x + w.vx * 0.2, w.y + w.vy * 0.2, T.cruise);
      w.wingPreset = ZMEU_WING.cruise;
      if (w.loopLeft <= 0) {
        const nx = cursorOn(s) ? s.cx : w.x;
        if (!windowPerch(w, s, w.landPerch)) floorPerch(w, s, nx, w.floor, true, w.landPerch);
        w.enterRoar = t.roarOnWake;
        w.peekLand = false;
        w.fastLand = true;
        go(w, s, 'landing');
      }
      return;
    default:
      go(w, s, 'wander');
  }
}

/** True when the segment (x0, y0) → (x1, y1) passes through the window content (Liang–Barsky). */
export function crossesContent(s: Readonly<ZmeuSenses>, x0: number, y0: number, x1: number, y1: number): boolean {
  const r = s.win;
  if (!r || s.winMaximized) return false;
  const rx0 = r.x;
  const rx1 = r.x + r.width;
  const ry0 = r.y + 30;
  const ry1 = r.y + r.height;
  const dx = x1 - x0;
  const dy = y1 - y0;
  let t0 = 0;
  let t1 = 1;
  const p0 = -dx;
  const p1 = dx;
  const p2 = -dy;
  const p3 = dy;
  const q0 = x0 - rx0;
  const q1 = rx1 - x0;
  const q2 = y0 - ry0;
  const q3 = ry1 - y0;
  for (let i = 0; i < 4; i++) {
    const p = i === 0 ? p0 : i === 1 ? p1 : i === 2 ? p2 : p3;
    const q = i === 0 ? q0 : i === 1 ? q1 : i === 2 ? q2 : q3;
    if (p === 0) {
      if (q < 0) return false;
    } else {
      const t = q / p;
      if (p < 0) {
        if (t > t1) return false;
        if (t > t0) t0 = t;
      } else {
        if (t < t0) return false;
        if (t < t1) t1 = t;
      }
    }
  }
  return t0 <= t1;
}

/**
 * Points the nav at (tx, ty), or at a corner of the (padded) window content
 * when the straight line would cross it: the dragon flies round your work.
 */
function routeTo(w: ZmeuWorld, s: ZmeuSenses, tx: number, ty: number): void {
  const n = w.nav;
  n.tx = tx;
  n.ty = ty;
  const r = s.win;
  if (!r || !crossesContent(s, w.x, w.y, tx, ty)) return;
  const pad = 0.3 * w.Lc;
  let best = Infinity;
  for (let k = 0; k < 4; k++) {
    const cx = clampX(w, k & 1 ? r.x + r.width + pad : r.x - pad);
    const cy = clampY(w, k & 2 ? r.y + r.height + pad : r.y + 30 - pad);
    if (overContent(s, cx, cy) || crossesContent(s, w.x, w.y, cx, cy)) continue;
    // A corner whose second leg still crosses the content only helps as a stepping stone.
    const d = hyp(cx - w.x, cy - w.y) + hyp(tx - cx, ty - cy) + (crossesContent(s, cx, cy, tx, ty) ? 4 * w.S : 0);
    if (d < best) {
      best = d;
      n.tx = cx;
      n.ty = cy;
    }
  }
  if (best < Infinity) n.slowR = 0.04 * w.S;
}

/** Moves (x, y) out of the window content to its nearest side, `pad` px beyond it (into w.tmpV). */
function offContent(w: ZmeuWorld, s: ZmeuSenses, x: number, y: number, pad: number): void {
  w.tmpV.x = x;
  w.tmpV.y = y;
  const r = s.win;
  if (!r || !overContent(s, x, y)) return;
  const dl = x - r.x;
  const dr = r.x + r.width - x;
  const dt = y - (r.y + 30);
  const db = r.y + r.height - y;
  const m = Math.min(dl, dr, dt, db);
  if (m === dt) w.tmpV.y = r.y + 30 - pad;
  else if (m === dl) w.tmpV.x = r.x - pad;
  else if (m === dr) w.tmpV.x = r.x + r.width + pad;
  else w.tmpV.y = r.y + r.height + pad;
  w.tmpV.x = clampX(w, w.tmpV.x);
  w.tmpV.y = clampY(w, w.tmpV.y);
}

/** A wander point in the upper 60 %, off the window content and, if possible, reachable without crossing it. */
function pickWanderPoint(w: ZmeuWorld, s: ZmeuSenses): void {
  const m = margin(w);
  const top = m;
  const bottom = Math.max(top + 1, m + 0.6 * (w.floor - 2 * m));
  let bx = NaN;
  let by = NaN;
  for (let k = 0; k < 8; k++) {
    const x = w.rng.range(m, w.W - m);
    const y = w.rng.range(top, bottom);
    if (overContent(s, x, y)) continue;
    if (!crossesContent(s, w.x, w.y, x, y)) {
      w.goalX = x;
      w.goalY = y;
      return;
    }
    if (Number.isNaN(bx)) {
      bx = x;
      by = y;
    }
  }
  if (Number.isNaN(bx)) {
    // Everything sampled was content: go above the window (or to the top band).
    bx = clampX(w, w.x);
    by = s.win ? clampY(w, s.win.y - 0.2 * w.Lc) : top;
  }
  w.goalX = bx;
  w.goalY = by;
}

function enterWander(w: ZmeuWorld, s: ZmeuSenses): void {
  takeoff(w, s);
  const t = temperOf(s);
  const dur = w.rng.range(t.wanderS[0], t.wanderS[1]);
  w.legUntil = w.bclock + dur;
  w.legPerch = 0;
  if (w.rng.next() < 0.55 && windowSpan(s, scratchSpan)) w.legPerch = 1;
  else if (w.rng.next() < 0.45) w.legPerch = 2;
  pickWanderPoint(w, s);
  w.loopAt = w.rng.next() < t.loopChance ? w.bclock + w.rng.range(1, Math.max(1.1, dur - 1)) : -1;
  w.glideLeft = 0;
  w.straightT = 0;
  w.overContentT = 0;
  w.overContentBoost = 0;
  w.lastTurnAng = Math.atan2(w.vy, w.vx);
  w.poseWTarget = 0;
}

function updateWander(w: ZmeuWorld, s: ZmeuSenses, bh: number, h: number): void {
  const t = temperOf(s);
  let frac: number = T.cruise;
  if (w.glideLeft > 0) {
    w.glideLeft -= bh;
    frac = T.glide;
    w.wingPreset = ZMEU_WING.glide;
  } else w.wingPreset = ZMEU_WING.cruise;
  if (w.overContentBoost > 0) {
    w.overContentBoost -= bh;
    frac *= 1.5;
  }
  navTo(w, s, w.goalX, w.goalY, frac);
  routeTo(w, s, w.goalX, w.goalY);
  w.nav.jitter = w.overContentBoost <= 0 && w.nav.tx === w.goalX;
  w.nav.serp = 1;
  if (hyp(w.goalX - w.x, w.goalY - w.y) < 0.12 * w.S) pickWanderPoint(w, s);

  // Glide after a second of straight, fast flight.
  const ang = Math.atan2(w.vy, w.vx);
  let da = ang - w.lastTurnAng;
  if (da > Math.PI) da -= 2 * Math.PI;
  else if (da < -Math.PI) da += 2 * Math.PI;
  w.lastTurnAng = ang;
  if (Math.abs(da) / h < 0.5 && w.speed >= 0.8 * T.cruise * w.S) w.straightT += h;
  else w.straightT = Math.min(0, w.straightT);
  if (w.straightT >= 1 && w.glideLeft <= 0) {
    w.glideLeft = w.rng.range(0.6, 1.2);
    w.straightT = -2;
  }

  // Loop-de-loop, with a lengths' clearance all round.
  if (w.loopAt > 0 && w.bclock >= w.loopAt) {
    w.loopAt = -1;
    const L = w.Lc;
    const clear = w.x > L && w.x < w.W - L && w.y > L && w.y < w.floor - L;
    if (clear && !isQuiet(s) && !s.reducedMotion && w.bclock - w.lastLoopAt >= Math.max(T.loopGapS, t.bigCooldownS) && w.speed > 0.5 * T.cruise * w.S) {
      w.loopLeft = T.loopS;
      w.loopSign = w.vx >= 0 ? -1 : 1;
      w.lastLoopAt = w.bclock;
      w.loops++;
    }
  }

  // Over-content guard.
  if (overContent(s, w.x, w.y)) w.overContentT += bh;
  else w.overContentT = 0;
  if (w.overContentT > t.overContentMaxS && s.win) {
    const r = s.win;
    const up = r.y - 0.2 * w.Lc;
    const left = r.x - 0.2 * w.Lc;
    const right = r.x + r.width + 0.2 * w.Lc;
    const dUp = w.y - up;
    const dL = w.x - left;
    const dR = right - w.x;
    const m = margin(w);
    if (dUp <= dL && dUp <= dR && up > m) {
      w.goalX = w.x;
      w.goalY = up;
    } else if (dL <= dR && left > m) {
      w.goalX = left;
      w.goalY = w.y;
    } else if (right < w.W - m) {
      w.goalX = right;
      w.goalY = w.y;
    } else {
      w.goalX = w.x;
      w.goalY = up;
    }
    w.goalX = clampX(w, w.goalX);
    w.goalY = clampY(w, w.goalY);
    w.overContentBoost = 2;
    w.overContentT = 0;
  }

  // Leg over: land, or another leg.
  if (w.bclock >= w.legUntil) {
    if (w.legPerch === 1 && windowPerch(w, s, w.landPerch)) {
      go(w, s, 'landing');
      return;
    }
    if (w.legPerch === 2) {
      floorPerch(w, s, w.x, w.y, false, w.landPerch);
      go(w, s, 'landing');
      return;
    }
    go(w, s, 'wander');
  }
}

function enterLanding(w: ZmeuWorld, s: ZmeuSenses): void {
  if (w.inspectWin) {
    // Inspecting the new window: '?' and fly to its ledge.
    w.inspectWin = false;
    if (!windowPerch(w, s, w.landPerch)) {
      go(w, s, 'wander');
      return;
    }
    emote(w, EM.question);
  }
  takeoff(w, s);
  w.poseWTarget = 0;
}

function updateLanding(w: ZmeuWorld, s: ZmeuSenses): void {
  const p = w.landPerch;
  if (p.window) {
    const win = s.win;
    if (!win || s.winMaximized) {
      go(w, s, 'wander');
      return;
    }
    p.x = win.x + p.fx * win.width;
    p.y = win.y;
  } else p.y = s.floor;
  if (w.phase === 0) {
    const hx = perchHeadX(w, p);
    const hy = perchHeadY(w, p) + (w.peekLand ? 0.1 * w.Lc : 0);
    const frac = w.fastLand ? T.entering : w.peekLand ? T.flee * 0.6 : T.cruise;
    navTo(w, s, hx, hy, frac, w.peekLand);
    routeTo(w, s, hx, hy);
    w.nav.bounds = false;
    w.nav.avoid = !w.peekLand;
    w.wingPreset = ZMEU_WING.cruise;
    if (hyp(hx - w.x, hy - w.y) < 0.3 * w.Lc) {
      copyPerch(w.perch, p);
      w.onPerch = true;
      w.poseKind = POSE_PERCH;
      w.poseW = 0;
      w.poseWTarget = 1;
      w.poseWRate = 1 / T.landSettleS;
      w.poseK = 7;
      w.coilMix = 0;
      w.peek = w.peekLand ? 1 : 0;
      nextPhase(w);
    } else if (w.stateAge > T.landTimeoutS) {
      w.fastLand = false;
      w.peekLand = false;
      go(w, s, 'wander');
    }
    return;
  }
  // Settle: flare, then fold into the perch pose.
  navPosed(w);
  w.wingPreset = w.phaseAge < T.landFlareS ? ZMEU_WING.flare : ZMEU_WING.perched;
  if (w.phaseAge >= T.landSettleS) {
    ev(w, EV.LAND);
    w.landedAt = w.bclock;
    w.fastLand = false;
    if (w.peekLand) {
      w.immuneUntil = Math.max(w.immuneUntil, w.bclock + T.fleeImmuneS);
      w.peekLand = false;
    }
    if (w.enterRoar) {
      w.enterRoar = false;
      w.roarShort = false;
      go(w, s, 'roar');
      return;
    }
    go(w, s, 'perched');
  }
}

function enterPerched(w: ZmeuWorld, s: ZmeuSenses): void {
  if (!w.onPerch) {
    go(w, s, 'wander');
    return;
  }
  const ps = w.prevState;
  if (ps === 'landing' || ps === 'waking' || ps === 'entering' || ps === 'drowsy' || w.perchUntil < w.bclock + 1) {
    const t = temperOf(s);
    w.perchUntil = w.bclock + w.rng.range(t.perchS[0], t.perchS[1]);
  }
  if (ps === 'drowsy') {
    // Woken before the coil closed: a little shake.
    w.animUntil = w.bclock + 0.4;
  }
  w.poseKind = POSE_PERCH;
  w.poseWTarget = 1;
  w.poseK = 7;
  w.coilMix = 0;
  if (w.subAt < w.bclock) w.subAt = w.bclock + w.rng.range(3, 7);
  if (w.puffAt < w.bclock) w.puffAt = w.bclock + w.rng.range(6, 10);
}

function updatePerched(w: ZmeuWorld, s: ZmeuSenses, bh: number): void {
  navPosed(w);
  w.poseKind = POSE_PERCH;
  w.poseWTarget = 1;
  w.poseWRate = 1 / T.landSettleS;
  w.wingPreset = ZMEU_WING.perched;
  if (w.coilMix > 0) w.coilMix = Math.max(0, w.coilMix - bh / 0.8);
  if (w.peek > 0 && w.stateAge > 2) w.peek = Math.max(0, w.peek - bh / 0.6);
  if (s.inputIdleS >= 30) w.eyeT = 0.6;

  // Idle sub-actions.
  if (w.bclock >= w.subAt) {
    const r = w.rng.next();
    w.subAt = w.bclock + w.rng.range(3, 7);
    if (r < 0.4) {
      w.subKind = 1; // glance
      w.subLeft = 1.0;
      w.glanceX = w.rng.range(0, w.W);
      w.glanceY = w.rng.range(0, w.floor);
      w.glanceUntil = w.bclock + 1.0;
    } else if (r < 0.6) {
      w.subKind = 2; // tail flick
      w.subLeft = 0.6;
    } else if (r < 0.75) {
      w.subKind = 3; // wing stretch
      w.subLeft = 0.8;
    } else if (r < 0.9) {
      w.subKind = 4; // groom (the emitter adds its spark)
      w.subLeft = 1.0;
    } else if (w.stateAge >= 60 || w.bclock - w.landedAt >= 60) {
      w.subKind = 5; // yawn
      w.subLeft = 1.2;
    } else {
      w.subKind = 0;
      w.subLeft = 0;
    }
    if (w.subLeft > 0) w.animUntil = Math.max(w.animUntil, w.bclock + w.subLeft);
  }
  if (w.subLeft > 0) {
    w.subLeft -= bh;
    switch (w.subKind) {
      case 2:
        w.wag = 1;
        break;
      case 3:
        w.wingPreset = ZMEU_WING.stretch;
        break;
      case 4:
        w.headOffset = -0.6;
        break;
      case 5:
        w.jawT = 0.5;
        w.eyeT = 0.4;
        break;
      default:
        break;
    }
  }
  if (w.bclock >= w.puffAt) {
    ev(w, EV.PUFF);
    w.puffAt = w.bclock + w.rng.range(6, 10);
  }
  if (w.bclock >= w.perchUntil) go(w, s, 'wander');
}

function enterCurious(w: ZmeuWorld, s: ZmeuSenses): void {
  w.curiousUntil = w.bclock + w.rng.range(3, 8);
  w.curiousPerched = w.onPerch && !w.callPending;
  if (w.callPending) {
    w.callPending = false;
    emote(w, EM.alert);
  }
  if (!w.curiousPerched) takeoff(w, s);
  w.tiltAt = w.bclock + 1.2;
}

function updateCurious(w: ZmeuWorld, s: ZmeuSenses): void {
  const t = temperOf(s);
  const on = cursorOn(s);
  const calling = w.callUntil > w.bclock;
  const tx = on ? s.cx : w.callX;
  const ty = on ? s.cy : w.callY;
  w.pupilT = 1.4;
  if (!on && calling) {
    w.glanceX = tx;
    w.glanceY = ty;
    w.glanceUntil = w.bclock + 0.1;
  }
  if (w.curiousPerched) {
    navPosed(w);
    w.poseKind = POSE_PERCH;
    w.poseWTarget = 1;
    w.wingPreset = ZMEU_WING.perched;
    const dx = tx - w.spine.x[0]!;
    const dy = ty - w.spine.y[0]!;
    const d = hyp(dx, dy);
    const reach = Math.min(0.12 * w.Lc, d * 0.3);
    if (d > 1e-6) {
      w.reachX = (dx / d) * reach;
      w.reachY = (dy / d) * reach;
    }
    if (w.bclock >= w.tiltAt) {
      w.tiltSign = -w.tiltSign;
      w.tiltAt = w.bclock + 1.2;
    }
    w.headOffset = w.tiltSign * 0.21;
  } else {
    const dp = Math.max(0.45 * w.Lc, 90);
    let ux = w.x - tx;
    let uy = w.y - ty;
    const win = s.win;
    if (win && !s.winMaximized) {
      ux = tx - (win.x + win.width / 2);
      uy = ty - (win.y + win.height / 2);
    }
    let ul = hyp(ux, uy);
    if (!(ul > 1e-6)) {
      ux = 1;
      uy = 0;
      ul = 1;
    }
    offContent(w, s, clampX(w, tx + (ux / ul) * dp), clampY(w, ty + (uy / ul) * dp), 0.15 * w.Lc);
    const hx = w.tmpV.x;
    const hy = w.tmpV.y;
    // Far away (a call): come at cruise speed; close by: hover speed.
    navTo(w, s, hx, hy, hyp(hx - w.x, hy - w.y) > 2 * dp ? T.cruise : T.hover);
    w.nav.avoid = false;
    w.wingPreset = ZMEU_WING.hover;
    w.poseKind = POSE_HOVER;
    w.poseK = 4;
    w.poseWTarget = w.speed < 0.1 * w.S ? 0.45 : 0;
    w.faceLock = tx >= w.x ? 1 : -1;
  }
  const lost = !on && !calling;
  if (w.bclock >= w.curiousUntil || lost) {
    w.curiousCooldownUntil = w.bclock + t.curiousCooldownS;
    w.stillNear = 0;
    w.callUntil = NEVER;
    w.reachX = 0;
    w.reachY = 0;
    go(w, s, w.curiousPerched && w.onPerch ? 'perched' : 'wander');
  }
}

function enterPet(w: ZmeuWorld): void {
  w.petSeenAt = w.bclock;
  w.heartAt = w.bclock;
}

function updatePet(w: ZmeuWorld, s: ZmeuSenses): void {
  if (w.petting) w.petSeenAt = w.bclock;
  w.happyT = 1;
  w.glowT = 1.15;
  if (w.bclock >= w.heartAt) {
    emote(w, EM.heart);
    w.heartAt = w.bclock + 1.5;
  }
  if (w.onPerch) {
    navPosed(w);
    w.poseKind = POSE_PERCH;
    w.poseWTarget = 1;
    w.wag = 1;
    w.wingPreset = ZMEU_WING.perched;
  } else {
    navTo(w, s, w.x, w.y, T.hover);
    w.wingPreset = ZMEU_WING.hover;
  }
  if (w.bclock - w.petSeenAt > 0.8 || w.stateAge > 8) {
    w.happyUntil = w.bclock + 3;
    go(w, s, w.onPerch ? 'perched' : 'wander');
  }
}

function enterStartled(w: ZmeuWorld, s: ZmeuSenses): void {
  ev(w, EV.STARTLE);
  emote(w, EM.alert);
  pushTime(w.fleeTimes, w.bclock);
  w.annoyance++;
  w.chaseC = 0;
  w.restTime = 0;
  takeoff(w, s);
  let ax = -w.headDirX;
  let ay = -w.headDirY;
  if (cursorOn(s)) {
    const dx = w.x - s.cx;
    const dy = w.y - s.cy;
    const d = hyp(dx, dy);
    if (d > 1e-6) {
      ax = dx / d;
      ay = dy / d;
    }
  }
  const v = (0.15 * w.Lc) / T.startleS;
  w.vx = ax * v + w.vx * 0.3;
  w.vy = ay * v + w.vy * 0.3;
  w.wingPreset = ZMEU_WING.startled;
  w.wingRate = 30;
  const t = temperOf(s);
  const n30 = countSince(w.fleeTimes, w.bclock - 30);
  const n20 = countSince(w.fleeTimes, w.bclock - 20);
  if (n30 >= 5) w.afterStartle = 'sulk';
  else if (n20 >= 3 && t.snort && !isQuiet(s) && !s.reducedMotion && w.bclock - w.lastSnortAt >= t.bigCooldownS && cursorOn(s)) w.afterStartle = 'snort';
  else w.afterStartle = 'flee';
}

function updateStartled(w: ZmeuWorld, s: ZmeuSenses, _bh: number, h: number): void {
  navScript(w);
  w.x += w.vx * h;
  w.y += w.vy * h;
  w.pupilT = 0.3;
  w.glowT = 1.6;
  w.wingPreset = ZMEU_WING.startled;
  w.wingRate = 30;
  if (w.stateAge >= T.startleS) go(w, s, w.afterStartle);
}

function enterFlee(w: ZmeuWorld, s: ZmeuSenses): void {
  takeoff(w, s);
  const on = cursorOn(s);
  const tx = on ? s.cx : w.x;
  const ty = on ? s.cy : w.y;
  const minD = 0.35 * w.S;
  let best = -Infinity;
  w.fleeToPerch = false;
  w.fleeTX = clampX(w, w.W - w.x);
  w.fleeTY = clampY(w, w.y);
  const fl = floorPerches(s, w.floors);
  for (let i = 0; i < fl.length; i++) {
    const p = fl[i]!;
    const hx = perchHeadX(w, p);
    const hy = perchHeadY(w, p);
    const d = hyp(hx - tx, hy - ty);
    if (d >= minD && d > best && !isBusy(w, p.x, p.y)) {
      best = d;
      w.fleeTX = hx;
      w.fleeTY = hy;
      w.fleeToPerch = true;
      copyPerch(w.fleePerch, p);
    }
  }
  if (windowPerch(w, s, w.tmpPerch)) {
    const hx = perchHeadX(w, w.tmpPerch);
    const hy = perchHeadY(w, w.tmpPerch);
    const d = hyp(hx - tx, hy - ty);
    if (d >= minD && d > best) {
      best = d;
      w.fleeTX = hx;
      w.fleeTY = hy;
      w.fleeToPerch = true;
      copyPerch(w.fleePerch, w.tmpPerch);
    }
  }
  const m = margin(w);
  for (let k = 0; k < 6; k++) {
    const x = w.rng.range(m, w.W - m);
    const y = w.rng.range(m, w.floor - m);
    const d = hyp(x - tx, y - ty);
    if (d >= minD && d > best) {
      best = d;
      w.fleeTX = x;
      w.fleeTY = y;
      w.fleeToPerch = false;
    }
  }
}

function updateFlee(w: ZmeuWorld, s: ZmeuSenses): void {
  navTo(w, s, w.fleeTX, w.fleeTY, T.flee, true);
  w.nav.serp = 1.5;
  w.nav.bounds = !w.fleeToPerch;
  w.wingPreset = ZMEU_WING.flee;
  if (hyp(w.fleeTX - w.x, w.fleeTY - w.y) < 0.06 * w.S || w.stateAge >= T.fleeMaxS) {
    w.immuneUntil = Math.max(w.immuneUntil, w.bclock + T.fleeImmuneS);
    w.curiousOffUntil = w.bclock + T.fleeCuriousOffS;
    if (w.fleeToPerch) {
      copyPerch(w.landPerch, w.fleePerch);
      w.peekLand = true;
      go(w, s, 'landing');
    } else go(w, s, 'wander');
  }
}

function enterHop(w: ZmeuWorld, s: ZmeuSenses): void {
  const L = w.Lc;
  const px = cursorOn(s) ? s.cx : w.x;
  const minD = Math.max(0.3 * L, 60);
  w.hopPerched = w.onPerch;
  w.hopDone = 0;
  w.hopArc = 0;
  w.restTime = -1.5;
  w.lastHopAt = w.bclock;
  ev(w, EV.HOP);
  if (w.hopPerched) {
    const p = w.perch;
    const f = p.facing;
    const xp = (px - p.x) * f;
    // Smallest move along the ledge that clears the pointer from the body ([−0.62, 0.22]·L around the anchor).
    const away = p.x >= px ? 1 : -1;
    let chosen = 0;
    for (let k = 0; k < 2; k++) {
      const sg = k === 0 ? away : -away;
      const need = sg * f > 0 ? xp + 0.62 * L : 0.22 * L - xp;
      const D = Math.max(minD, need);
      const nx = p.x + sg * D;
      if (nx >= p.x0 && nx <= p.x1 && !isBusy(w, nx, p.y)) {
        chosen = sg * D;
        break;
      }
    }
    if (chosen === 0) {
      // No room on the ledge: take off instead.
      go(w, s, 'wander');
      return;
    }
    markBusy(w, p.x, p.y);
    w.hopDX = chosen;
    w.hopArc = s.reducedMotion ? 0 : 0.15 * L;
  } else {
    w.hopDX = (w.x >= px ? 1 : -1) * minD;
  }
  // Smoothstep peaks at 1.5× the mean speed.
  w.hopDur = s.reducedMotion ? Math.max(T.hopS, (1.5 * Math.abs(w.hopDX)) / (T.cruise * w.S)) : T.hopS;
  w.animUntil = w.bclock + w.hopDur + 0.2;
}

function updateHop(w: ZmeuWorld, s: ZmeuSenses, _bh: number, h: number): void {
  navScript(w);
  w.wingPreset = w.hopPerched ? ZMEU_WING.hover : ZMEU_WING.cruise;
  const p = Math.min(1, w.phaseAge / w.hopDur);
  const e = smoothstep(0, 1, p);
  const dx = w.hopDX * e - w.hopDone;
  w.hopDone = w.hopDX * e;
  const arc = -w.hopArc * 4 * p * (1 - p);
  const dy = arc - w.hopArcDone;
  w.hopArcDone = arc;
  w.spine.translate(dx, dy);
  w.x += dx;
  w.y += dy;
  w.vx = dx / h;
  w.vy = dy / h;
  if (w.hopPerched) {
    w.perch.x += dx;
    if (w.perch.window && s.win && s.win.width > 0) w.perch.fx = (w.perch.x - s.win.x) / s.win.width;
    w.poseKind = POSE_PERCH;
    w.poseWTarget = 1;
  }
  if (p >= 1) {
    w.hopArcDone = 0;
    go(w, s, w.hopPerched && w.onPerch ? 'perched' : 'wander');
  }
}

function enterSnort(w: ZmeuWorld, s: ZmeuSenses): void {
  w.snortTX = s.cx;
  w.snortTY = s.cy;
  w.lastSnortAt = w.bclock;
  w.faceLock = s.cx >= w.x ? 1 : -1;
}

/** Mouth position (snout tip) from the head joint and direction. */
function mouthX(w: ZmeuWorld): number {
  return w.spine.x[0]! + w.headDirX * 0.74 * T.headFrac * w.Lc;
}

function mouthY(w: ZmeuWorld): number {
  return w.spine.y[0]! + w.headDirY * 0.74 * T.headFrac * w.Lc;
}

function aimBreath(w: ZmeuWorld, tx: number, ty: number): void {
  const mx = mouthX(w);
  const my = mouthY(w);
  const dx = tx - mx;
  const dy = ty - my;
  const d = hyp(dx, dy);
  if (d > 1e-6) {
    w.breathDX = dx / d;
    w.breathDY = dy / d;
  }
}

function updateSnort(w: ZmeuWorld, s: ZmeuSenses): void {
  if (cursorOn(s)) {
    w.snortTX = s.cx;
    w.snortTY = s.cy;
  }
  navTo(w, s, w.x, w.y, T.hover);
  w.nav.avoid = false;
  w.wingPreset = ZMEU_WING.hover;
  w.faceLock = w.snortTX >= w.x ? 1 : -1;
  w.glanceX = w.snortTX;
  w.glanceY = w.snortTY;
  w.glanceUntil = w.bclock + 0.1;
  w.slantT = 1;
  w.jawT = 0.3;
  if (w.phase === 0) {
    if (w.phaseAge >= 0.15) {
      nextPhase(w);
      ev(w, EV.SNORT);
      w.roastCursorUntil = w.clock + 1.5;
    }
    return;
  }
  w.breathPower = 0.5;
  aimBreath(w, w.snortTX, w.snortTY);
  if (w.phaseAge >= 0.6) go(w, s, 'flee');
}

function enterSulk(w: ZmeuWorld, s: ZmeuSenses): void {
  emote(w, EM.grumpy);
  takeoff(w, s);
  w.sulkSide = w.x < w.W / 2 ? -1 : 1;
  w.goalX = w.sulkSide < 0 ? -0.5 * w.S : w.W + 0.5 * w.S;
  w.goalY = clampY(w, w.y);
}

/** Every joint of the body is off the display (with a radius of margin). */
function offscreen(w: ZmeuWorld): boolean {
  const sp = w.spine;
  const r = T.radiusFrac * w.Lc;
  let x0 = Infinity;
  let x1 = -Infinity;
  let y0 = Infinity;
  let y1 = -Infinity;
  for (let i = 0; i < sp.n; i++) {
    const x = sp.x[i]!;
    const y = sp.y[i]!;
    if (x < x0) x0 = x;
    if (x > x1) x1 = x;
    if (y < y0) y0 = y;
    if (y > y1) y1 = y;
  }
  return x1 < -r || x0 > w.W + r || y1 < -r || y0 > w.H + r;
}

function updateSulk(w: ZmeuWorld, s: ZmeuSenses): void {
  navTo(w, s, w.goalX, w.goalY, T.entering, true);
  w.nav.bounds = false;
  w.nav.avoid = false;
  w.nav.slowR = 1;
  w.wingPreset = ZMEU_WING.cruise;
  w.slantT = 1;
  if (offscreen(w) || w.stateAge > 6) {
    w.absentUntil = w.bclock + T.sulkAbsentS;
    w.reenterEdge = w.sulkSide < 0 ? 'left' : 'right';
    w.reenterAt = w.y;
    w.fleeTimes.fill(NEVER);
    w.pokeTimes.fill(NEVER);
    w.annoyance = 0;
    go(w, s, 'absent');
  }
}

function enterBreathe(w: ZmeuWorld, s: ZmeuSenses): void {
  if (!breathPlan(s.win, w.x, w.y, s, w.rng, w.plan)) {
    go(w, s, 'wander');
    return;
  }
  takeoff(w, s);
  const i = w.breathKeyNext;
  w.breathKeys[i] = s.winKey;
  w.breathKeyAt[i] = w.bclock;
  w.breathKeyNext = (i + 1) % w.breathKeys.length;
  w.lastBreathAt = w.bclock;
  w.bursts = 0;
  w.breaths++;
}

function updateBreathe(w: ZmeuWorld, s: ZmeuSenses): void {
  const p = w.plan;
  const holdAt = w.phase === 0 ? T.cruise * 1.2 : T.hover;
  navTo(w, s, p.hoverX, p.hoverY, holdAt);
  if (w.phase === 0) routeTo(w, s, p.hoverX, p.hoverY);
  w.nav.avoid = w.phase === 0;
  w.wingPreset = w.phase === 0 ? ZMEU_WING.cruise : ZMEU_WING.hover;
  w.faceLock = p.x0 >= p.hoverX ? 1 : -1;
  w.glanceX = p.x0;
  w.glanceY = p.edgeY;
  w.glanceUntil = w.bclock + 0.1;
  if (w.phase > 0) {
    w.poseKind = POSE_HOVER;
    w.poseK = 4;
    w.poseWTarget = 0.4;
  }
  switch (w.phase) {
    case 0:
      if (hyp(p.hoverX - w.x, p.hoverY - w.y) < 0.06 * w.S || w.phaseAge > 3) nextPhase(w);
      return;
    case 1: // aim
      if (w.phaseAge >= 0.25) {
        nextPhase(w);
        ev(w, EV.CAUGHT_SPARKS);
      }
      return;
    case 2: {
      // inhale: charge the cracks, head back
      const k = Math.min(1, w.phaseAge / 0.5);
      w.chargeT = 1;
      w.chargeFront = 1 - k;
      w.headOffset = 0.3;
      w.glowT = 1.2;
      if (w.phaseAge >= 0.5) {
        nextPhase(w);
        ev(w, EV.KINDLE);
      }
      return;
    }
    case 3: {
      // blast along the top edge
      const u = Math.min(1, w.phaseAge / 1.2);
      w.jawT = 0.42;
      w.breathPower = 1;
      w.chargeT = 1;
      w.chargeFront = 0;
      w.glowT = 1.3;
      w.impactX = p.x0 + (p.x1 - p.x0) * u;
      w.impactY = p.edgeY;
      aimBreath(w, w.impactX, w.impactY);
      if (w.bursts < 4 && w.phaseAge >= w.bursts * 0.3) {
        ev(w, EV.BURST);
        w.bursts++;
      }
      if (w.phaseAge >= 1.2) {
        nextPhase(w);
        ev(w, EV.PUFF);
      }
      return;
    }
    default:
      // recover: a slow blink
      w.chargeFront = 1;
      if (w.phaseAge < 0.25) w.eyeT = 0.2;
      if (w.phaseAge >= 0.4) go(w, s, 'wander');
  }
}

function enterRoar(w: ZmeuWorld): void {
  w.roarPerched = w.onPerch;
  w.lastRoarAt = w.bclock;
}

function updateRoar(w: ZmeuWorld, s: ZmeuSenses): void {
  const short = w.roarShort;
  const tIn = short ? 0.1 : 0.3;
  const tRoar = short ? 0.4 : 0.8;
  const tOut = short ? 0.1 : 0.2;
  if (w.roarPerched) {
    navPosed(w);
    w.poseKind = w.phase === 1 ? POSE_ROAR_PERCH : POSE_PERCH;
    w.poseWTarget = 1;
  } else {
    navTo(w, s, w.x, w.y, T.hover);
    w.poseKind = w.phase === 1 ? POSE_ROAR_HOVER : POSE_HOVER;
    w.poseK = 6;
    w.poseWTarget = 0.5;
  }
  switch (w.phase) {
    case 0:
      w.headOffset = 0.25;
      w.wingPreset = w.roarPerched ? ZMEU_WING.perched : ZMEU_WING.hover;
      if (w.phaseAge >= tIn) {
        nextPhase(w);
        ev(w, EV.ROAR);
        w.roarRingAge = 0;
        w.lastRoarAt = w.bclock;
        w.roars++;
      }
      return;
    case 1: {
      const u = w.phaseAge / tRoar;
      w.jawT = 0.62 + 0.03 * Math.sin(2 * Math.PI * 9 * w.clock);
      w.headOffset = 0.105 * Math.sin(2 * Math.PI * 9 * w.clock) * (1 - u);
      w.wingPreset = ZMEU_WING.roar;
      w.glowT = 1.4;
      w.slantT = 0.6;
      if (w.phaseAge >= tRoar) nextPhase(w);
      return;
    }
    default:
      w.wingPreset = w.roarPerched ? ZMEU_WING.perched : ZMEU_WING.hover;
      if (w.phaseAge >= tOut) {
        w.roarShort = false;
        go(w, s, w.roarPerched && w.onPerch ? 'perched' : 'wander');
      }
  }
}

function enterDrowsy(w: ZmeuWorld): void {
  w.drowsyPerched = w.onPerch;
  w.coilDone = false;
  emote(w, EM.sleep);
}

function updateDrowsy(w: ZmeuWorld, s: ZmeuSenses, bh: number): void {
  w.sleepT = 0.3;
  switch (w.phase) {
    case 0: // yawn
      w.jawT = 0.5;
      w.eyeT = 0.5;
      if (w.onPerch) {
        navPosed(w);
        w.poseKind = POSE_PERCH;
        w.poseWTarget = 1;
        w.wingPreset = ZMEU_WING.perched;
      } else {
        navTo(w, s, w.x, w.y, T.hover);
        w.wingPreset = ZMEU_WING.hover;
      }
      if (w.phaseAge >= 1.2) {
        if (w.onPerch) {
          w.phase = 2;
          w.phaseAge = 0;
        } else {
          const reach = 0.9 * 5 * T.cruise * w.S;
          if (s.powerSleeping) floorPerch(w, s, w.x, w.y, true, w.landPerch);
          else sleepPerch(s, floorPerches(s, w.floors), w.x, w.y, reach, w.landPerch);
          nextPhase(w);
        }
      }
      return;
    case 1: {
      // fly to the sleep perch (≤ 5 s)
      const p = w.landPerch;
      p.y = s.floor;
      const hx = perchHeadX(w, p);
      const hy = perchHeadY(w, p);
      navTo(w, s, hx, hy, T.cruise);
      routeTo(w, s, hx, hy);
      w.nav.bounds = false;
      w.wingPreset = ZMEU_WING.cruise;
      if (hyp(hx - w.x, hy - w.y) < 0.3 * w.Lc || w.phaseAge > 5) {
        copyPerch(w.perch, p);
        w.onPerch = true;
        w.poseKind = POSE_PERCH;
        w.poseWTarget = 1;
        w.poseWRate = 1 / T.landSettleS;
        w.poseK = 7;
        nextPhase(w);
        if (s.powerSleeping || w.perch.window) nextPhase(w);
      }
      return;
    }
    case 2: {
      // two turns on the spot (floor only)
      navPosed(w);
      w.poseKind = POSE_PERCH;
      w.poseWTarget = 1;
      w.wingPreset = ZMEU_WING.perched;
      w.eyeT = 0.4;
      const before = w.phaseAge - bh;
      if ((before < 0.4 && w.phaseAge >= 0.4) || (before < 1.2 && w.phaseAge >= 1.2)) w.perch.facing = -w.perch.facing;
      if (w.phaseAge >= 1.6 || w.perch.window || s.powerSleeping) nextPhase(w);
      return;
    }
    default: {
      // coil
      navPosed(w);
      w.poseKind = POSE_PERCH;
      w.poseWTarget = 1;
      w.poseK = 4;
      w.wingPreset = ZMEU_WING.asleep;
      w.eyeT = 0.15;
      w.sleepT = 0.7;
      w.coilMix = Math.min(1, w.phaseAge / 1.5);
      if (w.phaseAge >= 1.5) {
        w.coilDone = true;
        w.sleptBase = 0;
        go(w, s, 'asleep');
      }
    }
  }
}

function enterAsleep(w: ZmeuWorld, s: ZmeuSenses): void {
  if (!w.onPerch) {
    const reach = 0.9 * 5 * T.cruise * w.S;
    snapPerch(w, sleepPerch(s, floorPerches(s, w.floors), w.x, w.y, reach, w.tmpPerch), true);
  }
  w.poseKind = POSE_COIL;
  w.poseWTarget = 1;
  w.poseK = 2.2;
  w.coilMix = 0;
  w.asleepSince = w.bclock;
  w.asleepWall = w.wallMs;
  w.sleptFor = w.sleptBase;
  w.zAt = w.bclock + 2 * T.breathPeriodS;
  w.twitchAt = w.bclock + w.rng.range(18, 30);
  w.emoteKind = EM.none;
  w.callUntil = NEVER;
}

export function sleptFor(w: ZmeuWorld): number {
  let wall = 0;
  if (Number.isFinite(w.wallMs) && Number.isFinite(w.asleepWall)) wall = ((w.wallMs - w.asleepWall) / 1000) * w.timerScale;
  return w.sleptBase + Math.max(w.bclock - w.asleepSince, wall);
}

function updateAsleep(w: ZmeuWorld): void {
  navPosed(w);
  w.poseKind = POSE_COIL;
  w.poseWTarget = 1;
  w.poseK = 2.2;
  w.wingPreset = ZMEU_WING.asleep;
  const b = 0.5 - 0.5 * Math.cos((2 * Math.PI * w.clock) / T.breathPeriodS);
  w.eyeT = w.peekEyeUntil > w.bclock ? 0.5 : 0;
  w.sleepT = 1;
  w.crustT = 0.92;
  w.glowT = 0.28 + 0.14 * b;
  w.jawT = 0.03;
  if (w.bclock >= w.zAt) {
    emote(w, EM.sleep);
    w.zAt = w.bclock + 2 * T.breathPeriodS;
  }
  if (w.bclock >= w.twitchAt) {
    w.twitchAt = w.bclock + w.rng.range(18, 30);
    w.twitchUntil = w.bclock + 0.3;
  }
  if (w.twitchUntil > w.bclock) w.wag = 1;
  w.sleptFor = sleptFor(w);
}

function enterWaking(w: ZmeuWorld, s: ZmeuSenses): void {
  const t = temperOf(s);
  w.wakeSleptFor = w.state === 'waking' && w.prevState === 'asleep' ? sleptFor(w) : 0;
  w.flash = 1;
  w.emoteKind = EM.none;
  if (w.wakePoked) {
    if (t.roarOnWake) w.wakeRoar = true;
    else {
      w.wakeRoar = false;
      emote(w, EM.grumpy);
      ev(w, EV.PUFF);
    }
    w.roarShort = true;
  } else {
    w.wakeRoar = t.roarOnWake && w.wakeSleptFor >= T.longSleepS && w.bclock - w.lastRoarAt >= T.wakeRoarGapS;
    w.roarShort = false;
  }
  w.wakePoked = false;
  if (!w.onPerch) {
    snapPerch(w, floorPerch(w, s, w.x, w.y, true, w.tmpPerch), true);
  }
}

function updateWaking(w: ZmeuWorld, s: ZmeuSenses): void {
  navPosed(w);
  w.poseWTarget = 1;
  w.crustT = 0.85;
  switch (w.phase) {
    case 0: // eye flash, lids open
      w.poseKind = POSE_COIL;
      w.poseK = 2.2;
      w.eyeT = Math.min(1, w.phaseAge / 0.3);
      w.glowT = w.phaseAge < 0.15 ? 2 : 1;
      w.wingPreset = ZMEU_WING.asleep;
      if (w.phaseAge >= 0.3) {
        nextPhase(w);
        w.poseKind = POSE_PERCH;
        w.coilMix = 1;
        w.poseK = 4;
      }
      return;
    case 1: // uncoil
      w.poseKind = POSE_PERCH;
      w.coilMix = Math.max(0, 1 - w.phaseAge / 0.8);
      w.wingPreset = ZMEU_WING.perched;
      if (w.phaseAge >= 0.8) nextPhase(w);
      return;
    case 2: // stretch
      w.poseKind = POSE_PERCH;
      w.coilMix = 0;
      w.poseK = 7;
      w.stretch = 1;
      w.wingPreset = ZMEU_WING.stretch;
      if (w.phaseAge >= 0.4) {
        nextPhase(w);
        ev(w, EV.WAKE_SHAKE);
      }
      return;
    default: // shake (and a chirp when there is no roar)
      w.poseKind = POSE_PERCH;
      w.wingPreset = ZMEU_WING.perched;
      w.headOffset = 0.1 * Math.sin(2 * Math.PI * 6 * w.clock);
      if (!w.wakeRoar) w.jawT = 0.3;
      if (w.phaseAge >= 0.3) {
        w.stillNear = 0.7;
        if (w.wakeRoar) {
          w.wakeRoar = false;
          go(w, s, 'roar');
        } else go(w, s, 'perched');
      }
  }
}

function enterCheer(w: ZmeuWorld, s: ZmeuSenses): void {
  takeoff(w, s);
  w.cheerNext = w.bclock + 1;
  w.cheerLeft = 0;
}

function updateCheer(w: ZmeuWorld, s: ZmeuSenses, bh: number): void {
  const bt = s.burnTarget;
  if (!bt) {
    go(w, s, 'wander');
    return;
  }
  const hx = Math.min(0.9 * w.W, Math.max(0.1 * w.W, bt.x));
  const hy = Math.max(margin(w), 0.12 * w.H);
  navTo(w, s, hx, hy, T.cruise);
  w.wingPreset = ZMEU_WING.hover;
  w.poseKind = POSE_HOVER;
  w.poseK = 4;
  w.poseWTarget = 0.4;
  w.faceLock = bt.x >= w.x ? 1 : -1;
  w.glanceX = bt.x;
  w.glanceY = bt.y;
  w.glanceUntil = w.bclock + 0.1;
  w.happyT = 0.6;
  if (w.bclock >= w.cheerNext) {
    ev(w, EV.IGNITE);
    w.igniteX = bt.x;
    w.igniteY = bt.y;
    w.cheerTX = bt.x;
    w.cheerTY = bt.y;
    w.cheerLeft = 0.8;
    w.cheerNext = w.bclock + 3.5;
  }
  if (w.cheerLeft > 0) {
    w.cheerLeft -= bh;
    w.breathPower = 1;
    w.jawT = 0.42;
    aimBreath(w, w.cheerTX, w.cheerTY);
  }
}

function enterLeaving(w: ZmeuWorld, s: ZmeuSenses): void {
  w.leaveDepart = !w.enabled || w.homeVia === null;
  const sky = w.homeVia === 'sky';
  w.leaveBall = w.leaveDepart || sky;
  w.leaveEdge = sky ? 'top' : (w.homeEdge ?? 'top');
  w.leaveAt = sky ? w.x : w.homeAt;
  w.leaveSeq = w.homeSeq;
  takeoff(w, s);
  w.poseWTarget = 0;
  w.callPending = false;
}

function updateLeaving(w: ZmeuWorld, s: ZmeuSenses, _bh: number, h: number): void {
  w.ballT = w.leaveBall ? 1 : 0;
  w.wingPreset = ZMEU_WING.flee;
  if (w.leaveDepart) {
    navScript(w);
    const v = speedPx(w, s, T.leaving);
    const k = 1 - Math.exp(-6 * h);
    w.vx += (0 - w.vx) * k;
    w.vy += (-v - w.vy) * k;
    w.x += w.vx * h;
    w.y += w.vy * h;
  } else {
    const S = w.S;
    let tx = w.leaveAt;
    let ty = -0.5 * S;
    if (w.leaveEdge === 'left') {
      tx = -0.5 * S;
      ty = w.leaveAt;
    } else if (w.leaveEdge === 'right') {
      tx = w.W + 0.5 * S;
      ty = w.leaveAt;
    } else if (w.leaveEdge === 'bottom') {
      ty = w.H + 0.5 * S;
    }
    navTo(w, s, tx, ty, T.leaving, true);
    w.nav.bounds = false;
    w.nav.avoid = false;
    w.nav.slowR = 1;
  }
  if (offscreen(w) || w.stateAge >= T.leaveMaxS) {
    if (!w.leaveDepart && !w.leaveForced) {
      ev(w, EV.EXITED);
      w.exitSeq = w.leaveSeq;
    }
    go(w, s, 'absent');
  }
}

const ENTER: Record<ZmeuState, EnterFn> = {
  absent: enterAbsent,
  entering: enterEntering,
  wander: enterWander,
  landing: enterLanding,
  perched: enterPerched,
  curious: enterCurious,
  pet: enterPet,
  startled: enterStartled,
  flee: enterFlee,
  hop: enterHop,
  snort: enterSnort,
  sulk: enterSulk,
  breathe: enterBreathe,
  roar: enterRoar,
  drowsy: enterDrowsy,
  asleep: enterAsleep,
  waking: enterWaking,
  cheer: enterCheer,
  leaving: enterLeaving,
};

const UPDATE: Record<ZmeuState, UpdateFn> = {
  absent: updateAbsent,
  entering: updateEntering,
  wander: updateWander,
  landing: updateLanding,
  perched: updatePerched,
  curious: updateCurious,
  pet: updatePet,
  startled: updateStartled,
  flee: updateFlee,
  hop: updateHop,
  snort: updateSnort,
  sulk: updateSulk,
  breathe: updateBreathe,
  roar: updateRoar,
  drowsy: updateDrowsy,
  asleep: updateAsleep,
  waking: updateWaking,
  cheer: updateCheer,
  leaving: updateLeaving,
};
