/**
 * Zmeul's pure core: a seeded, substepped (1/120 s) simulation of the dragon
 * that App feeds with senses and input and reads back as plain numbers and
 * typed arrays. No DOM, no GL, no wall clock of its own (App passes
 * `performance.now()` so frozen time still counts as sleep), and no
 * allocation per frame.
 */
import { ZMEU_TEMPERS } from '../../../shared/settings';
import type { ZmeuHomeFrame } from '../../../shared/zmeu';
import { ZMEU_EDGES, ZMEU_VIAS, zmeuLength } from '../../../shared/zmeu';
import { Random, smoothstep } from '../../util/math';
import { noise1 } from '../../util/noise';
import { afterMotion, bodyShape, decide, go, perceiveFrame, resetBody, sleptFor, snapPerch, think } from './brain';
import { bodyDistance, classifyClick } from './gestures';
import type { ZmeuView } from './mesh';
import { offscreenOk, segLength, stepBody } from './motion';
import { copyPerch, floorPerches, pickWindowPerch } from './perches';
import type { ZmeuSenses } from './senses';
import type { ZmeuState } from './tuning';
import { ZMEU_EVENT, ZMEU_JOINTS, ZMEU_TUNING as T, ZmeuEmote, isZmeuState } from './tuning';
import type { ZmeuBreathOut, ZmeuEmoteOut, ZmeuLightOut, ZmeuPoseOut } from './world';
import { ZmeuWorld } from './world';
import { hyp } from './vec';

export type ZmeuPointerType = 'down' | 'up';

function num(v: unknown, d: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : d;
}

function clampNum(v: unknown, lo: number, hi: number, d: number): number {
  const n = num(v, d);
  return n < lo ? lo : n > hi ? hi : n;
}

const BIG = 1e6;

export class ZmeuCore implements ZmeuView {
  private readonly w: ZmeuWorld;

  /** Head, face, wings and glow for the renderer. */
  readonly pose: ZmeuPoseOut = {
    headX: 0,
    headY: 0,
    dirX: 1,
    dirY: 0,
    facing: 1,
    jaw: 0.03,
    eyeOpen: 1,
    pupil: 1,
    slant: 0,
    happy: 0,
    lookX: 0,
    lookY: 0,
    wingPhi: 0,
    wingAmp: 0,
    wingBias: 0,
    wingFold: 0,
    wingSpan: 1,
    wingVel: 0,
    glow: 1,
    crust: 0.8,
    charge: 0,
    chargeFront: 1,
    sleep: 0,
    fade: 0,
    ball: 0,
    speed: 0,
    vx: 0,
    vy: 0,
    L: 270,
    flash: 0,
  };
  /** Fire breath: power 0..1 at the mouth (x, y) along (dirX, dirY); age in seconds. */
  readonly breath: ZmeuBreathOut = { power: 0, x: 0, y: 0, dirX: 1, dirY: 0, age: 0 };
  readonly emote: ZmeuEmoteOut = { kind: ZmeuEmote.none, age: 0 };
  /** Torch light: CSS px centre, radius in screen heights (0 = none). */
  readonly light: ZmeuLightOut = { x: 0, y: 0, radius: 0 };

  constructor(seed: number = T.seed) {
    this.w = new ZmeuWorld(seed >>> 0);
  }

  // ------------------------------------------------------------ outputs

  get state(): ZmeuState {
    return this.w.state;
  }
  /** Seconds in the current state (brain clock). */
  get stateAge(): number {
    return this.w.stateAge;
  }
  get visible(): boolean {
    return this.w.visible;
  }
  /** The dragon needs the fluid sim this frame (mane, breath, ball or a fluid one-shot). */
  get wantsFluid(): boolean {
    return this.w.wantsFluid;
  }
  get manePower(): number {
    return this.w.manePower;
  }
  /** −1 not visible, 0 frozen, 8 asleep, 15 still, 30 near or animating. */
  get petFps(): number {
    return this.w.petFps;
  }
  /** Pending event bits (ZMEU_EVENT); see takeEvents(). */
  get events(): number {
    return this.w.events;
  }
  get impactX(): number {
    return this.w.impactX;
  }
  get impactY(): number {
    return this.w.impactY;
  }
  get igniteX(): number {
    return this.w.igniteX;
  }
  get igniteY(): number {
    return this.w.igniteY;
  }
  /** Seq of the home frame the last handoff exit answers (valid when EXITED fired). */
  get exitSeq(): number {
    return this.w.exitSeq;
  }
  /** Display spine (physics joints + undulation), CSS px; the emitter uses the same arrays. */
  get bodyX(): Float32Array {
    return this.w.bodyX;
  }
  get bodyY(): Float32Array {
    return this.w.bodyY;
  }
  /** Roll per joint, −1..1 (sign = which side is the back). */
  get roll(): Float32Array {
    return this.w.roll;
  }
  /** Age of the roar ring (s), −1 when none. */
  get roarRingAge(): number {
    return this.w.roarRingAge;
  }
  /** Draw the FireCursor halo while `clock < roastCursorUntil`. */
  get roastCursorUntil(): number {
    return this.w.roastCursorUntil;
  }
  /** The core's own non-wrapping animation clock (s). */
  get clock(): number {
    return this.w.clock;
  }
  get resets(): number {
    return this.w.resets;
  }
  /** Seconds asleep so far (core clock or wall time, whichever is larger). */
  get sleptFor(): number {
    return this.w.state === 'asleep' ? this.w.sleptFor : 0;
  }
  get home(): boolean {
    return this.w.home;
  }
  get homeSeq(): number {
    return this.w.homeSeq;
  }
  /** Debug: steering target, perch anchor and counters. */
  get navX(): number {
    return this.w.nav.tx;
  }
  get navY(): number {
    return this.w.nav.ty;
  }
  get fleeX(): number {
    return this.w.fleeTX;
  }
  get fleeY(): number {
    return this.w.fleeTY;
  }
  get onPerch(): boolean {
    return this.w.onPerch;
  }
  get anchorX(): number {
    return this.w.perch.x;
  }
  get anchorY(): number {
    return this.w.perch.y;
  }
  get perchOnWindow(): boolean {
    return this.w.onPerch && this.w.perch.window;
  }
  get loops(): number {
    return this.w.loops;
  }

  // ------------------------------------------------------------ control

  reseed(seed: number): void {
    this.w.rng = new Random(num(seed, T.seed) >>> 0);
  }

  /** A home frame from main (App filters stale seqs). */
  setHome(f: ZmeuHomeFrame): void {
    const w = this.w;
    if (!f || typeof f !== 'object') return;
    const home = f.home === true;
    w.homeSeq = Number.isInteger(f.seq) ? f.seq : w.homeSeq;
    w.homeVia = f.via !== null && ZMEU_VIAS.includes(f.via) ? f.via : null;
    w.homeEdge = f.edge !== null && ZMEU_EDGES.includes(f.edge) ? f.edge : null;
    w.homeAt = num(f.at, 0);
    if (home && !w.home) w.homeSince = w.bclock;
    w.home = home;
    if (!home && w.homeVia !== null) {
      // A handoff frame. Already gone (sulking, or not arrived yet): report at once
      // instead of letting main wait out its exit timeout. Mid-flight: answer the newest seq.
      if (w.state === 'absent') {
        w.events |= ZMEU_EVENT.EXITED;
        w.exitSeq = w.homeSeq;
      } else if (w.state === 'leaving') {
        w.leaveForced = false;
        if (!w.leaveDepart) w.leaveSeq = w.homeSeq;
      }
    }
  }

  /** Effective `zmeu` setting; off makes the dragon depart (no EXITED). */
  setEnabled(on: boolean): void {
    const w = this.w;
    if (on && !w.enabled) w.homeSince = w.bclock;
    w.enabled = on;
  }

  /** Mock only: freezes the brain timers (animation keeps running). */
  hold(on: boolean): void {
    this.w.hold = on;
  }

  /** Mock only: multiplies the brain timers (naps show up quickly). */
  setTimerScale(k: number): void {
    this.w.timerScale = clampNum(k, 0, 1000, 1);
  }

  /** Returns and clears the pending event bits. */
  takeEvents(): number {
    const e = this.w.events;
    this.w.events = 0;
    return e;
  }

  /** Advances the dragon by dt seconds (clamped to 0.25 s, split into 1/120 s substeps). */
  step(dt: number, s: Readonly<ZmeuSenses>, wallMs: number): void {
    const w = this.w;
    const d = Number.isFinite(dt) && dt > 0 ? Math.min(dt, T.maxDt) : 0;
    if (Number.isFinite(wallMs)) w.wallMs = wallMs;
    this.sense(s);
    if (d > 0) {
      perceiveFrame(w, w.sn, d);
      const n = Math.max(1, Math.ceil(d * T.substepHz - 1e-6));
      const h = d / n;
      for (let i = 0; i < n; i++) {
        w.clock += h;
        think(w, w.sn, h, i === 0);
        if (w.state !== 'absent') {
          stepBody(w, h);
          afterMotion(w, w.sn);
          this.safety();
        }
      }
    }
    this.finalize(d);
  }

  /** A cursor sample (local CSS px, seconds). True when it woke the dragon or un-froze the frame. */
  noteCursor(x: number, y: number, tS: number): boolean {
    const w = this.w;
    if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
    const t = Number.isFinite(tS) ? tS : w.ringNow;
    let sp = Infinity;
    if (w.ring.count > 0) {
      const k = w.ring.slot(0);
      const dt = t - w.ring.t[k]!;
      if (dt > 1e-3) sp = hyp(x - w.ring.x[k]!, y - w.ring.y[k]!) / dt;
    }
    w.ring.push(x, y, t);
    w.ringNow = t;
    w.ringClock = w.clock;
    if (w.downActive) w.downMoved = Math.max(w.downMoved, hyp(x - w.downX, y - w.downY));
    w.inputPulse = true;
    return this.inputWake(x, y, sp, false);
  }

  /** A global pointer button (local CSS px). True when it woke the dragon. */
  onPointer(type: ZmeuPointerType, x: number, y: number, inside: boolean, _button: string, tS: number): boolean {
    const w = this.w;
    w.inputPulse = true;
    if (Number.isFinite(tS)) {
      w.ringNow = Math.max(w.ringNow, tS);
      w.ringClock = w.clock;
    }
    const fx = Number.isFinite(x) ? x : -BIG;
    const fy = Number.isFinite(y) ? y : -BIG;
    if (type === 'down') {
      w.downActive = true;
      w.downX = fx;
      w.downY = fy;
      w.downMoved = 0;
      const vis = w.state !== 'absent' && inside;
      w.downDist = vis ? bodyDistance(bodyShape(w), fx, fy) : Infinity;
      w.downHit = vis && w.downDist < T.hitPad;
      if (w.state === 'asleep' && !w.sn.powerSleeping) {
        w.wakePoked = w.downHit;
        return this.inputWake(NaN, NaN, Infinity, true);
      }
      return false;
    }
    if (type === 'up' && w.downActive) {
      w.downActive = false;
      const moved = Math.max(w.downMoved, hyp(fx - w.downX, fy - w.downY));
      const c = classifyClick(w.downHit, w.downDist, moved, w.Lc);
      if (c === 'poke') {
        w.pokeNow = true;
        let oldest = 0;
        for (let i = 1; i < w.pokeTimes.length; i++) if (w.pokeTimes[i]! < w.pokeTimes[oldest]!) oldest = i;
        w.pokeTimes[oldest] = w.bclock;
      } else if (c === 'notice') {
        w.glanceX = w.downX;
        w.glanceY = w.downY;
        w.glanceUntil = w.bclock + 1;
        w.animUntil = Math.max(w.animUntil, w.bclock + 1);
      }
    }
    return false;
  }

  /** A key press (count only, never the key). True when it woke the dragon. */
  noteKey(tS: number): boolean {
    const w = this.w;
    w.keyPulse = true;
    w.inputPulse = true;
    if (Number.isFinite(tS)) {
      w.ringNow = Math.max(w.ringNow, tS);
      w.ringClock = w.clock;
    }
    return this.inputWake(NaN, NaN, Infinity, true);
  }

  /** "Cheamă zmeul": come and look at (x, y). */
  call(x: number, y: number): void {
    const w = this.w;
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    w.callX = x;
    w.callY = y;
    w.callUntil = w.bclock + 8;
    w.callPending = true;
    w.inputPulse = true;
    if (w.state === 'asleep') go(w, w.sn, 'waking');
    else if (w.state === 'drowsy') go(w, w.sn, w.onPerch ? 'perched' : 'wander');
    this.refreshPetFps();
  }

  /** The overlay was hidden for `hiddenS`: after ≥ 300 s it fell asleep while you were away. */
  resumeAfter(hiddenS: number): void {
    const w = this.w;
    if (!(Number.isFinite(hiddenS) && hiddenS >= T.longSleepS)) return;
    const st = w.state;
    if (st === 'absent' || st === 'leaving' || st === 'entering' || st === 'sulk' || st === 'asleep') return;
    w.sleptBase = hiddenS;
    go(w, w.sn, 'asleep');
    this.finalize(0);
  }

  /** Mock / tests: jump straight into a state with a sensible body. */
  forceState(state: ZmeuState, s: Readonly<ZmeuSenses>): void {
    const w = this.w;
    if (!isZmeuState(state)) return;
    this.sense(s);
    const sn = w.sn;
    // The current window counts as already seen (no 'new window' reaction to the setup itself).
    if (sn.win) {
      w.prevWin.x = sn.win.x;
      w.prevWin.y = sn.win.y;
      w.prevWin.width = sn.win.width;
      w.prevWin.height = sn.win.height;
      w.hadWin = true;
    } else w.hadWin = false;
    w.prevWinKey = sn.winKey;
    if (state === 'absent') {
      go(w, sn, 'absent');
      this.finalize(0);
      return;
    }
    const perchy = state === 'perched' || state === 'curious' || state === 'pet' || state === 'hop' || state === 'roar' || state === 'drowsy' || state === 'waking' || state === 'asleep';
    if (perchy) {
      if (!w.onPerch) {
        const p = pickWindowPerch(sn, w.rng, w.tmpPerch) ?? floorPerches(sn, w.floors)[1]!;
        snapPerch(w, p, state === 'asleep' || state === 'waking');
        w.landedAt = w.bclock;
      }
    } else if (w.state === 'absent') {
      w.spine.reset(w.W / 2, 0.35 * w.H, 1, 0, segLength(w.Lc));
      w.x = w.W / 2;
      w.y = 0.35 * w.H;
      w.vx = 0;
      w.vy = 0;
    }
    if (state === 'landing') {
      if (!pickWindowPerch(sn, w.rng, w.landPerch)) copyPerch(w.landPerch, floorPerches(sn, w.floors)[2]!);
    }
    w.fade = 1;
    w.fadeT = 1;
    if (state === 'asleep') w.sleptBase = 0;
    // Still home and enabled, decide() would turn a forced departure straight back.
    if (state === 'leaving') w.leaveForced = true;
    go(w, sn, state);
    this.finalize(0);
  }

  /** Debug HUD fragment; App adds the frame mode and splat count. */
  hudLine(): string {
    const w = this.w;
    return `zmeu ${w.state} ${w.stateAge.toFixed(1)}s · home ${w.home ? 'y' : 'n'} seq ${w.homeSeq} · resets ${w.resets}`;
  }

  /** Pure decision for the current world (tests / debug). */
  peekDecision(): ZmeuState | null {
    return decide(this.w, this.w.sn);
  }

  // ------------------------------------------------------------ internals

  /** Input while asleep: a slow cursor right next to it only opens one eye; anything else wakes it. */
  private inputWake(x: number, y: number, speed: number, any: boolean): boolean {
    const w = this.w;
    if (w.state !== 'asleep' || w.sn.powerSleeping) return false;
    const wasFrozen = w.petFps === 0;
    if (!any && speed < T.stillNearSpeed && hyp(x - w.x, y - w.y) < 0.5 * w.Lc) {
      w.peekEyeUntil = w.bclock + 1;
      this.refreshPetFps();
      return wasFrozen;
    }
    go(w, w.sn, 'waking');
    this.refreshPetFps();
    return true;
  }

  /** Sanitises the caller's senses into the world's copy and rescales on display resizes. */
  private sense(src: Readonly<ZmeuSenses>): void {
    const w = this.w;
    const d = w.sn;
    const W = clampNum(src.width, 64, 16384, d.width);
    const H = clampNum(src.height, 64, 16384, d.height);
    if (w.sensed && (Math.abs(W - w.W) > 0.5 || Math.abs(H - w.H) > 0.5)) this.rescale(W / w.W, H / w.H);
    d.width = W;
    d.height = H;
    d.floor = clampNum(src.floor, H * 0.5, H, H);
    d.S = Math.min(W, H);
    const L = num(src.L, NaN);
    d.L = L > 0 ? Math.min(1200, Math.max(40, L)) : zmeuLength('medium', W, H);
    const cx = num(src.cx, NaN);
    const cy = num(src.cy, NaN);
    d.cursorKnown = src.cursorKnown === true && Number.isFinite(cx) && Number.isFinite(cy);
    d.cursorInside = d.cursorKnown && src.cursorInside === true;
    d.cx = d.cursorKnown ? Math.min(BIG, Math.max(-BIG, cx)) : 0;
    d.cy = d.cursorKnown ? Math.min(BIG, Math.max(-BIG, cy)) : 0;
    d.cvx = clampNum(src.cvx, -2e4, 2e4, 0);
    d.cvy = clampNum(src.cvy, -2e4, 2e4, 0);
    d.cspeed = clampNum(src.cspeed, 0, 3e4, hyp(d.cvx, d.cvy));
    d.inputIdleS = clampNum(src.inputIdleS, 0, 1e9, 0);
    d.typingRecent = src.typingRecent === true;
    d.buttonHeld = src.buttonHeld === true;
    d.focusTicking = src.focusTicking === true;
    const r = src.win;
    if (r && Number.isFinite(r.x) && Number.isFinite(r.y) && Number.isFinite(r.width) && Number.isFinite(r.height) && r.width > 0 && r.height > 0) {
      const ws = w.winStore;
      ws.x = Math.min(BIG, Math.max(-BIG, r.x));
      ws.y = Math.min(BIG, Math.max(-BIG, r.y));
      ws.width = Math.min(BIG, r.width);
      ws.height = Math.min(BIG, r.height);
      d.win = ws;
    } else d.win = null;
    d.winKey = Number.isFinite(src.winKey) ? src.winKey | 0 : 0;
    d.winMaximized = src.winMaximized === true;
    d.buttonsZone = src.buttonsZone === 'left90' ? 'left90' : 'right150';
    d.powerSleeping = src.powerSleeping === true;
    d.torch = src.torch === true;
    d.othersActive = src.othersActive === true;
    const b = src.burnTarget;
    if (b && Number.isFinite(b.x) && Number.isFinite(b.y)) {
      w.burnStore.x = Math.min(W, Math.max(0, b.x));
      w.burnStore.y = Math.min(H, Math.max(0, b.y));
      d.burnTarget = w.burnStore;
    } else d.burnTarget = null;
    d.reducedMotion = src.reducedMotion === true;
    // Not `in ZMEU_TEMPER`: that also accepts inherited keys such as 'constructor'.
    d.temper = ZMEU_TEMPERS.includes(src.temper) ? src.temper : 'playful';
    d.idleSleepS = clampNum(src.idleSleepS, 0, 1e7, 0);
    w.W = W;
    w.H = H;
    w.S = d.S;
    w.floor = d.floor;
    if (!w.sensed) {
      w.Lc = d.L;
      w.sensed = true;
    }
  }

  /** Keeps the dragon where it was, proportionally, when the display changes size. */
  private rescale(sx: number, sy: number): void {
    const w = this.w;
    if (!(sx > 0 && sy > 0 && Number.isFinite(sx) && Number.isFinite(sy))) return;
    w.spine.scale(sx, sy);
    w.x *= sx;
    w.y *= sy;
    w.goalX *= sx;
    w.goalY *= sy;
    w.fleeTX *= sx;
    w.fleeTY *= sy;
    w.perch.x *= sx;
    w.perch.y *= sy;
    w.landPerch.x *= sx;
    w.landPerch.y *= sy;
    w.fleePerch.x *= sx;
    w.fleePerch.y *= sy;
    w.perch.x0 *= sx;
    w.perch.x1 *= sx;
    w.plan.hoverX *= sx;
    w.plan.hoverY *= sy;
    w.plan.x0 *= sx;
    w.plan.x1 *= sx;
    w.plan.edgeY *= sy;
    w.callX *= sx;
    w.callY *= sy;
    for (let i = 0; i < ZMEU_JOINTS; i++) {
      w.bodyX[i] = w.bodyX[i]! * sx;
      w.bodyY[i] = w.bodyY[i]! * sy;
    }
  }

  /** Any non-finite value, or a head far off the display outside leaving/entering → reset. */
  private safety(): void {
    const w = this.w;
    const S = w.S;
    const bad =
      !Number.isFinite(w.x) ||
      !Number.isFinite(w.y) ||
      !Number.isFinite(w.vx) ||
      !Number.isFinite(w.vy) ||
      !Number.isFinite(w.headAng) ||
      !Number.isFinite(w.phi) ||
      !Number.isFinite(w.Lc) ||
      !w.spine.tailFinite();
    const out = !offscreenOk(w) && (w.x < -0.5 * S || w.x > w.W + 0.5 * S || w.y < -0.5 * S || w.y > w.H + 0.5 * S);
    if (bad || out) resetBody(w, w.sn);
  }

  private refreshPetFps(): void {
    const w = this.w;
    const s = w.sn;
    const st = w.state;
    if (st === 'absent' || !w.visible) {
      w.petFps = -1;
      return;
    }
    if (st === 'asleep') {
      w.petFps = sleptFor(w) >= T.frozenAfterS && w.peekEyeUntil <= w.bclock ? 0 : 8;
      return;
    }
    if (st === 'drowsy' && w.phase >= 3) {
      w.petFps = 8;
      return;
    }
    const near = s.cursorKnown && s.cursorInside && hyp(s.cx - w.x, s.cy - w.y) < 2 * w.Lc;
    const still = st === 'perched' || (st === 'curious' && w.curiousPerched);
    const anim = w.animUntil > w.bclock || w.emoteKind !== ZmeuEmote.none || w.blinkLeft > 0 || w.glanceUntil > w.bclock || w.fade < 1;
    w.petFps = near || anim || !still ? 30 : 15;
  }

  private maneFor(): number {
    const w = this.w;
    const s = w.sn;
    if (w.ball > 0.5) return 0;
    switch (w.state) {
      case 'wander':
      case 'entering':
      case 'landing':
      case 'leaving':
      case 'sulk':
        return 0.9;
      case 'flee':
        return 1;
      case 'curious':
        return w.curiousPerched ? 0.6 : 0.75;
      case 'perched':
      case 'hop':
        return w.bclock - w.landedAt <= T.warmAfterLandS || s.othersActive ? 0.6 : 0;
      case 'pet':
        return 0.7;
      case 'breathe':
      case 'cheer':
      case 'snort':
        return 1;
      case 'roar':
        return 1.2;
      case 'startled':
        return 1.1;
      case 'waking':
        return Math.max(0, Math.min(1, (w.stateAge - 1.0) / 0.8));
      case 'drowsy':
        return w.phase === 0 ? 0.5 * Math.max(0, 1 - w.phaseAge / 1.2) : 0;
      default:
        return 0;
    }
  }

  private lightRadius(): number {
    const w = this.w;
    if (w.ball > 0.5) return 0.16;
    switch (w.state) {
      case 'absent':
        return 0;
      case 'curious':
      case 'pet':
        return 0.14;
      case 'breathe':
      case 'roar':
      case 'cheer':
        return 0.22;
      case 'asleep':
        return 0.06 + 0.015 * (0.5 - 0.5 * Math.cos((2 * Math.PI * w.clock) / T.breathPeriodS));
      default:
        return 0.12;
    }
  }

  /** Per-frame outputs: display spine, pose, breath, emote, light, fluid wish and pet fps. */
  private finalize(_dt: number): void {
    const w = this.w;
    w.visible = w.state !== 'absent';
    const sp = w.spine;
    const L = w.Lc;
    const n = ZMEU_JOINTS;
    if (w.visible) {
      const cruise = T.cruise * w.S;
      const amp = T.undAmp * L * (0.4 + 0.6 * Math.min(1.5, w.speed / cruise)) * w.wFly;
      // sin(2π·1.2·t − 0.45·i), stepped by a rotation per joint.
      const ph = 2 * Math.PI * T.undHz * w.clock;
      let sn = Math.sin(ph);
      let cs = Math.cos(ph);
      const rc = Math.cos(T.undPhase);
      const rs = Math.sin(T.undPhase);
      for (let i = 0; i < n; i++) {
        const a = i > 0 ? i - 1 : 0;
        const b = i < n - 1 ? i + 1 : n - 1;
        const tx = sp.x[a]! - sp.x[b]!;
        const ty = sp.y[a]! - sp.y[b]!;
        const l = hyp(tx, ty) || 1;
        const u = i / (n - 1);
        const off = amp > 0 && u > 0 ? amp * sn * smoothstep(0, 0.3, u) : 0;
        w.bodyX[i] = sp.x[i]! + (ty / l) * off;
        w.bodyY[i] = sp.y[i]! - (tx / l) * off;
        w.roll[i] = sp.roll[i]!;
        const ns = sn * rc - cs * rs;
        cs = cs * rc + sn * rs;
        sn = ns;
      }
    }
    const p = this.pose;
    p.headX = w.bodyX[0]!;
    p.headY = w.bodyY[0]!;
    p.dirX = w.headDirX;
    p.dirY = w.headDirY;
    p.facing = w.facing;
    p.jaw = w.jaw;
    p.eyeOpen = w.eyeOpen;
    p.pupil = w.pupil;
    p.slant = w.slant;
    p.happy = w.happy;
    p.lookX = w.lookX;
    p.lookY = w.lookY;
    p.wingPhi = w.phi;
    p.wingAmp = w.wamp;
    p.wingBias = w.wbias;
    p.wingFold = w.wfold;
    p.wingSpan = w.wspan * (1 + 0.1 * w.stretch);
    p.wingVel = w.wingVel;
    p.glow = w.glow;
    p.crust = w.crust;
    p.charge = w.charge;
    p.chargeFront = w.chargeFront;
    p.sleep = w.sleep;
    p.fade = w.visible ? w.fade : 0;
    p.ball = w.ball;
    p.speed = w.speed;
    p.vx = w.vx;
    p.vy = w.vy;
    p.L = L;
    p.flash = w.flash;

    const hd = T.headFrac * L;
    const br = this.breath;
    br.power = w.visible ? w.breathPower : 0;
    br.x = p.headX + w.headDirX * 0.74 * hd;
    br.y = p.headY + w.headDirY * 0.74 * hd;
    br.dirX = w.breathDX;
    br.dirY = w.breathDY;
    br.age = w.breathAge;

    this.emote.kind = w.emoteKind;
    this.emote.age = w.emoteAge;

    const li = this.light;
    const flick = 0.93 + 0.07 * noise1(w.clock * 5, 77);
    li.radius = w.visible ? this.lightRadius() * flick : 0;
    li.x = br.power > 0 ? br.x : w.bodyX[3]!;
    li.y = br.power > 0 ? br.y : w.bodyY[3]!;

    w.manePower = w.visible ? this.maneFor() : 0;
    const fluidShots = ZMEU_EVENT.ROAR | ZMEU_EVENT.STARTLE | ZMEU_EVENT.LAND | ZMEU_EVENT.UNFURL | ZMEU_EVENT.HOP;
    w.wantsFluid = w.visible && (w.manePower > 0 || w.breathPower > 0 || w.ball > 0.05 || (w.events & fluidShots) !== 0);
    this.refreshPetFps();
  }
}
