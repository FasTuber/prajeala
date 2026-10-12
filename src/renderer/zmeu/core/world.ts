/**
 * All mutable dragon state in one preallocated bag: body physics, brain
 * memory, perception and the per-frame outputs. The brain (brain.ts) and the
 * body (motion.ts) mutate it; ZmeuCore exposes it read-only. Nothing here
 * allocates after construction.
 */
import type { Rect } from '../../../shared/ipc';
import type { ZmeuEdge, ZmeuVia } from '../../../shared/zmeu';
import { Random } from '../../util/math';
import { CursorRing } from './gestures';
import type { ZmeuBreathPlan, ZmeuPerch } from './perches';
import { createPerch } from './perches';
import type { ZmeuSenses, ZmeuPoint } from './senses';
import { createZmeuSenses } from './senses';
import { Spine } from './spine';
import type { SteerLimits, Vec2 } from './steering';
import type { ZmeuEmote, ZmeuState, ZmeuWingPreset } from './tuning';
import { ZMEU_JOINTS, ZMEU_TUNING as T, ZMEU_WING } from './tuning';

/** How the head moves this substep. */
export const NAV_STILL = 0;
export const NAV_FLY = 1;
export const NAV_POSED = 2;
export const NAV_SCRIPT = 3;

/** Spine pose kinds. */
export const POSE_NONE = 0;
export const POSE_PERCH = 1;
export const POSE_COIL = 2;
export const POSE_HOVER = 3;
export const POSE_ROAR_PERCH = 4;
export const POSE_ROAR_HOVER = 5;

export interface ZmeuNav {
  mode: number;
  tx: number;
  ty: number;
  vmax: number;
  amax: number;
  omega: number;
  slowR: number;
  /** Wander jitter on/off, serpentine multiplier (0 = off). */
  jitter: boolean;
  serp: number;
  bounds: boolean;
  avoid: boolean;
}

/** Pose outputs (ZmeuCore.pose). */
export interface ZmeuPoseOut {
  headX: number;
  headY: number;
  dirX: number;
  dirY: number;
  facing: number;
  jaw: number;
  eyeOpen: number;
  pupil: number;
  slant: number;
  happy: number;
  lookX: number;
  lookY: number;
  wingPhi: number;
  wingAmp: number;
  wingBias: number;
  wingFold: number;
  wingSpan: number;
  wingVel: number;
  glow: number;
  crust: number;
  charge: number;
  chargeFront: number;
  sleep: number;
  fade: number;
  ball: number;
  speed: number;
  vx: number;
  vy: number;
  L: number;
  /** Wake eye flash / torch-style eye streak, 0..1. */
  flash: number;
}

export interface ZmeuBreathOut {
  power: number;
  x: number;
  y: number;
  dirX: number;
  dirY: number;
  age: number;
}

export interface ZmeuEmoteOut {
  kind: ZmeuEmote;
  age: number;
}

export interface ZmeuLightOut {
  /** CSS px, and radius in screen heights (0 = off). */
  x: number;
  y: number;
  radius: number;
}

/** "Long ago" for brain-clock timestamps. */
export const NEVER = -1e9;

export class ZmeuWorld {
  rng: Random;

  // Senses: a sanitised copy of the caller's object, with owned rect/point storage.
  readonly sn: ZmeuSenses = createZmeuSenses();
  readonly winStore: Rect = { x: 0, y: 0, width: 0, height: 0 };
  readonly burnStore: ZmeuPoint = { x: 0, y: 0 };
  sensed = false;

  // Clocks: animation (never wraps) and brain (scaled by timerScale, frozen by hold).
  clock = 0;
  bclock = 0;
  timerScale = 1;
  hold = false;
  wallMs = NaN;

  // Behaviour state.
  state: ZmeuState = 'absent';
  prevState: ZmeuState = 'absent';
  stateAge = 0;
  phase = 0;
  phaseAge = 0;

  // Home and enable.
  home = false;
  enabled = true;
  homeSeq = 0;
  homeVia: ZmeuVia | null = null;
  homeEdge: ZmeuEdge | null = null;
  homeAt = 0;
  homeSince = 0;

  // Head agent (CSS px, px/s) and body.
  x = 0;
  y = 0;
  vx = 0;
  vy = 0;
  dirX = 1;
  dirY = 0;
  speed = 0;
  facing = 1;
  headAng = 0;
  headDirX = 1;
  headDirY = 0;
  headOffset = 0;
  readonly spine = new Spine();
  readonly tx = new Float64Array(ZMEU_JOINTS);
  readonly ty = new Float64Array(ZMEU_JOINTS);
  readonly cx2 = new Float64Array(ZMEU_JOINTS);
  readonly cy2 = new Float64Array(ZMEU_JOINTS);
  Lc = 270;
  W = 1920;
  H = 1080;
  S = 1080;
  floor = 1080;
  poseKind = POSE_NONE;
  poseW = 0;
  poseWTarget = 0;
  poseWRate = 1 / 0.3;
  poseK = 7;
  coilMix = 0;
  peek = 0;
  reachX = 0;
  reachY = 0;
  wag = 0;
  wFly = 1;
  stretch = 0;

  // Perches.
  onPerch = false;
  readonly perch: ZmeuPerch = createPerch();
  readonly landPerch: ZmeuPerch = createPerch();
  readonly fleePerch: ZmeuPerch = createPerch();
  readonly tmpPerch: ZmeuPerch = createPerch();
  readonly floors: readonly ZmeuPerch[] = [createPerch(), createPerch(), createPerch(), createPerch()];
  landedAt = NEVER;
  perchUntil = 0;

  // Navigation.
  readonly nav: ZmeuNav = { mode: NAV_STILL, tx: 0, ty: 0, vmax: 0, amax: 0, omega: 0, slowR: 1, jitter: false, serp: 0, bounds: true, avoid: true };
  readonly desired: Vec2 = { x: 0, y: 0 };
  readonly tmpV: Vec2 = { x: 0, y: 0 };
  readonly lim: SteerLimits = { vmax: 0, amax: 0, omega: 0 };
  theta = 0;
  goalX = 0;
  goalY = 0;
  legUntil = 0;
  legPerch = 0;
  loopAt = -1;
  loopLeft = 0;
  loopSign = 1;
  glideLeft = 0;
  straightT = 0;
  lastTurnAng = 0;
  overContentT = 0;
  overContentBoost = 0;

  // Wings.
  wingPreset: ZmeuWingPreset = ZMEU_WING.cruise;
  wingRate = 6;
  psi = 0;
  phi = 0;
  wf = 2;
  wamp = 0.85;
  wbias = 0.25;
  wfold = 0;
  wspan = 1;
  wingVel = 0;
  flapBoostUntil = NEVER;

  // Face targets and values.
  jawT = 0.03;
  jaw = 0.03;
  eyeT = 1;
  eyeOpen = 1;
  pupilT = 1;
  pupil = 1;
  slantT = 0;
  slant = 0;
  happyT = 0;
  happy = 0;
  glowT = 1;
  glow = 1;
  crustT = 0.8;
  crust = 0.8;
  chargeT = 0;
  charge = 0;
  chargeFront = 1;
  sleepT = 0;
  sleep = 0;
  fade = 0;
  fadeRate = 2;
  fadeT = 1;
  ball = 0;
  ballT = 0;
  flash = 0;
  lookX = 0;
  lookY = 0;
  gazeOn = false;
  gazeX = 0;
  gazeY = 0;
  glanceX = 0;
  glanceY = 0;
  glanceUntil = NEVER;
  faceLock = 0;
  tiltAt = 0;
  tiltSign = 1;
  shakeAmp = 0;

  // Idle life.
  blinkAt = 3;
  blinkLeft = 0;
  blinkDouble = false;
  subAt = 5;
  subKind = 0;
  subLeft = 0;
  puffAt = 8;
  twitchAt = 20;
  twitchUntil = NEVER;
  zAt = 0;
  peekEyeUntil = NEVER;
  animUntil = NEVER;

  // Emote, breath, ring, light.
  emoteKind: ZmeuEmote = 0;
  emoteAge = 0;
  lastEmoteAt = NEVER;
  breathPower = 0;
  breathX = 0;
  breathY = 0;
  breathDX = 1;
  breathDY = 0;
  breathAge = 0;
  roarRingAge = -1;
  lightX = 0;
  lightY = 0;
  lightR = 0;

  // Outputs.
  events = 0;
  impactX = 0;
  impactY = 0;
  igniteX = 0;
  igniteY = 0;
  exitSeq = -1;
  roastCursorUntil = NEVER;
  resets = 0;
  manePower = 0;
  wantsFluid = false;
  petFps = -1;
  visible = false;
  readonly bodyX = new Float32Array(ZMEU_JOINTS);
  readonly bodyY = new Float32Array(ZMEU_JOINTS);
  readonly roll = new Float32Array(ZMEU_JOINTS);

  // Perception.
  readonly ring = new CursorRing();
  ringNow = 0;
  ringClock = 0;
  stillNear = 0;
  chaseC = 0;
  panic = false;
  petting = false;
  restTime = 0;
  inputPulse = false;
  keyPulse = false;
  wakePulse = false;
  pokeNow = false;
  noticeNow = false;
  readonly pokeTimes = new Float64Array(3).fill(NEVER);
  readonly fleeTimes = new Float64Array(8).fill(NEVER);
  annoyance = 0;
  immuneUntil = NEVER;
  curiousCooldownUntil = NEVER;
  curiousOffUntil = NEVER;
  winNew = false;
  winRoll = 1;
  readonly prevWin: Rect = { x: 0, y: 0, width: 0, height: 0 };
  hadWin = false;
  prevWinKey = 0;
  typingHop = false;
  /**
   * The window perch is no longer valid (sticky until the dragon leaves or takes a
   * perch): 1 = its window changed app, moved too far, resized or went away; 2 = it
   * jumped more than 0.3·S (startle first). States that cannot react at once (hop,
   * waking, pet, roar) handle it when they end, and the dragon never rides a lost perch.
   */
  perchLost = 0;
  inspectWin = false;

  // Pointer.
  downActive = false;
  downX = 0;
  downY = 0;
  downMoved = 0;
  downHit = false;
  downDist = 0;

  // Cooldowns (brain clock).
  lastBreathAt = NEVER;
  lastRoarAt = NEVER;
  lastSnortAt = NEVER;
  lastLoopAt = NEVER;
  readonly breathKeys = new Float64Array(8);
  readonly breathKeyAt = new Float64Array(8).fill(NEVER);
  breathKeyNext = 0;
  readonly busyX = new Float64Array(4);
  readonly busyY = new Float64Array(4);
  readonly busyUntil = new Float64Array(4).fill(NEVER);
  busyNext = 0;

  // Sleep.
  asleepSince = 0;
  asleepWall = NaN;
  sleptBase = 0;
  sleptFor = 0;
  wakeSleptFor = 0;
  wakePoked = false;
  wakeRoar = false;
  drowsyPerched = false;
  coilDone = false;

  // Entering / leaving.
  absentUntil = NEVER;
  reenterEdge: ZmeuEdge | null = null;
  reenterAt = 0;
  enterVia: ZmeuVia = 'puff';
  enterRoar = false;
  leaveDepart = true;
  leaveEdge: ZmeuEdge = 'top';
  leaveAt = 0;
  leaveSeq = -1;
  leaveBall = false;
  /** Mock forceState('leaving'): fly off even though still home, then come back. */
  leaveForced = false;

  // State scratch.
  callX = 0;
  callY = 0;
  callUntil = NEVER;
  callPending = false;
  readonly plan: ZmeuBreathPlan = { hoverX: 0, hoverY: 0, x0: 0, x1: 0, edgeY: 0, side: 1 };
  bursts = 0;
  nextBurstAt = 0;
  cheerNext = 0;
  cheerLeft = 0;
  lastIgniteAt = NEVER;
  cheerTX = 0;
  cheerTY = 0;
  snortTX = 0;
  snortTY = 0;
  hopDX = 0;
  hopArc = 0;
  hopDur: number = T.hopS;
  hopDone = 0;
  hopPerched = false;
  hopArcDone = 0;
  lastHopAt = NEVER;
  fleeTX = 0;
  fleeTY = 0;
  fleeToPerch = false;
  peekLand = false;
  fastLand = false;
  sulkSide = 1;
  petSeenAt = 0;
  heartAt = 0;
  happyUntil = NEVER;
  curiousUntil = 0;
  curiousPerched = false;
  afterStartle: ZmeuState = 'flee';
  roarShort = false;
  roarPerched = false;
  stateTimer = 0;

  // Counters (tests, HUD).
  loops = 0;
  breaths = 0;
  roars = 0;

  constructor(seed: number) {
    this.rng = new Random(seed);
  }
}
