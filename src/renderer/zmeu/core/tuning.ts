/**
 * Zmeul core tuning: the dragon's states, events, emotes and every number its
 * body and brain use. Units: L = dragon length (CSS px), S = short screen
 * side, H = screen height; speeds in S/s. Pure data, no DOM and no GL.
 */

export const ZMEU_JOINTS = 24;
/** Vertex capacity of the strip mesh (body + both wings). */
export const ZMEU_MESH_CAPACITY = 160;
/** Floats per mesh vertex: [x, y, u, v, roll, heat, radiusPx, kind]. */
export const ZMEU_MESH_STRIDE = 8;

export const ZMEU_STATES = [
  'absent',
  'entering',
  'wander',
  'landing',
  'perched',
  'curious',
  'pet',
  'startled',
  'flee',
  'hop',
  'snort',
  'sulk',
  'breathe',
  'roar',
  'drowsy',
  'asleep',
  'waking',
  'cheer',
  'leaving',
] as const;
export type ZmeuState = (typeof ZMEU_STATES)[number];

export function isZmeuState(x: unknown): x is ZmeuState {
  return typeof x === 'string' && (ZMEU_STATES as readonly string[]).includes(x);
}

/** Emote glyphs drawn above the head (sprite part 2). */
export const ZmeuEmote = Object.freeze({ none: 0, alert: 1, question: 2, heart: 3, sleep: 4, grumpy: 5 } as const);
export type ZmeuEmote = (typeof ZmeuEmote)[keyof typeof ZmeuEmote];

/** One-shot events, OR-ed into `core.events` and consumed with `takeEvents()`. */
export const ZMEU_EVENT = Object.freeze({
  ROAR: 1,
  STARTLE: 2,
  SNORT: 4,
  LAND: 8,
  TAKEOFF: 16,
  PUFF: 32,
  IGNITE: 64,
  KINDLE: 128,
  BURST: 256,
  EXITED: 512,
  WAKE_SHAKE: 1024,
  /** Inhale before a breath: sparks are sucked toward the mouth. */
  CAUGHT_SPARKS: 2048,
  /** The sky fireball unfurls into the dragon (radial splat + 15 sparks). */
  UNFURL: 4096,
  /** Make-way hop (dust smoke splat). */
  HOP: 8192,
} as const);

/** Wing preset: flap frequency (Hz), amplitude, bias (rad), fold (0..1), span multiplier. */
export interface ZmeuWingPreset {
  readonly f: number;
  readonly amp: number;
  readonly bias: number;
  readonly fold: number;
  readonly span: number;
}

export const ZMEU_WING = Object.freeze({
  cruise: { f: 2.0, amp: 0.85, bias: 0.25, fold: 0, span: 1 },
  flee: { f: 3.4, amp: 1.0, bias: 0.3, fold: 0, span: 1 },
  hover: { f: 2.6, amp: 0.9, bias: 0.35, fold: 0, span: 1 },
  flare: { f: 3.0, amp: 1.1, bias: 0.4, fold: 0, span: 1 },
  glide: { f: 0, amp: 0, bias: 0.35, fold: 0, span: 1 },
  perched: { f: 0.25, amp: 0.04, bias: -0.2, fold: 1, span: 1 },
  roar: { f: 9, amp: 0.05, bias: 1.05, fold: 0, span: 1 },
  startled: { f: 0, amp: 0, bias: 1.3, fold: 0, span: 1.1 },
  asleep: { f: 0, amp: 0, bias: -0.2, fold: 1, span: 0.5 },
  stretch: { f: 0.6, amp: 0.12, bias: 0.9, fold: 0, span: 1.1 },
} satisfies Record<string, ZmeuWingPreset>);

export const ZMEU_TUNING = Object.freeze({
  /** Body length, head length, base radius and wing span as fractions of L. */
  bodyFrac: 0.86,
  headFrac: 0.17,
  radiusFrac: 0.05,
  wingFrac: 0.4,
  /** Radius profile stops (u = 0 neck … 1 tail tip) in units of R. */
  radiusU: [0, 0.08, 0.2, 0.35, 0.5, 0.68, 0.85, 1] as readonly number[],
  radiusR: [0.62, 0.85, 1.0, 0.95, 0.78, 0.5, 0.26, 0.1] as readonly number[],
  /** Speeds in S/s. */
  cruise: 0.32,
  glide: 0.26,
  hover: 0.15,
  flee: 0.9,
  entering: 0.5,
  leaving: 0.9,
  ball: 1.0,
  skyFall: 0.9,
  /** Accelerations in S/s², turn rates in rad/s. */
  accel: 1.4,
  accelFast: 3.0,
  turn: 3.5,
  turnFast: 7,
  loopTurn: 5.7,
  loopS: 0.9,
  /** Clock. */
  substepHz: 120,
  maxDt: 0.25,
  /** Seed base: `seed ^ (display.index · seedDisplayMul)`. */
  seed: 0x7a6d6575,
  seedDisplayMul: 0x9e37,
  /** Steering. */
  slowRadius: 0.15,
  carrotAhead: 0.25,
  carrotRadius: 0.12,
  serpentine: 0.03,
  serpentineHz: 1.1,
  boundsMargin: 0.08,
  avoidRadius: 0.2,
  bob: 0.008,
  /** Spine bend limits (rad): joints 1–6, then the rest. */
  bendNeck: (40 * Math.PI) / 180,
  bendTail: (30 * Math.PI) / 180,
  /** Display undulation. */
  undAmp: 0.03,
  undHz: 1.2,
  undPhase: 0.45,
  /** Senses / gestures. */
  stillNearSpeed: 120,
  stillNearRange: 1.6,
  curiousAt: 1.2,
  chaseRange: 0.25,
  chaseThreshold: 250,
  chaseScale: 400,
  chaseDecay: 0.6,
  panicRange: 0.06,
  panicSpeed: 300,
  restPad: 8,
  restSpeed: 60,
  restS: 0.6,
  petPad: 0.1,
  hitPad: 8,
  noticeRange: 0.6,
  dragPx: 6,
  /** Timings (s). */
  startleS: 0.18,
  fleeMaxS: 2.5,
  fleeImmuneS: 2,
  fleeCuriousOffS: 4,
  hopS: 0.35,
  hopBusyS: 120,
  landSettleS: 0.8,
  landFlareS: 0.35,
  landTimeoutS: 4.5,
  sulkAbsentS: 45,
  leaveMaxS: 3,
  frozenAfterS: 300,
  longSleepS: 300,
  wakeRoarGapS: 600,
  breathKeyGapS: 120,
  loopGapS: 30,
  warmAfterLandS: 4,
  breathPeriodS: 4.2,
} as const);

/** Default seed for a display, as the spec prescribes. */
export function zmeuSeed(displayIndex: number): number {
  const i = Number.isFinite(displayIndex) ? Math.max(0, Math.floor(displayIndex)) : 0;
  return (ZMEU_TUNING.seed ^ Math.imul(i, ZMEU_TUNING.seedDisplayMul)) >>> 0;
}
