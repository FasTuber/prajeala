/**
 * Zmeul — the desktop fire dragon. Shared, pure pieces: size, temper tuning,
 * and the contract main uses to tell overlays where the dragon lives (one
 * dragon per app, on one "home" display at a time).
 *
 * The home-display logic (stepZmeuHome & co.) also lives here so it can be
 * unit-tested without Electron.
 */
import type { Rect } from './ipc';
import type { ZmeuSize, ZmeuTemper } from './settings';

/** Dragon length as a fraction of the short screen side. */
export const ZMEU_SIZE_FACTOR: Readonly<Record<ZmeuSize, number>> = Object.freeze({ small: 0.18, medium: 0.25, large: 0.34 });
export const ZMEU_MIN_LENGTH = 150;
export const ZMEU_MAX_LENGTH = 520;

/** Dragon length L in CSS px for a display of w × h CSS px. */
export function zmeuLength(size: ZmeuSize, w: number, h: number): number {
  const s = Math.min(Number.isFinite(w) ? w : 0, Number.isFinite(h) ? h : 0);
  const f = ZMEU_SIZE_FACTOR[size] ?? ZMEU_SIZE_FACTOR.medium;
  return Math.min(ZMEU_MAX_LENGTH, Math.max(ZMEU_MIN_LENGTH, f * s));
}

export interface TemperTuning {
  /** Seconds spent on a perch, [min, max]. */
  perchS: readonly [number, number];
  /** Seconds per wander leg, [min, max]. */
  wanderS: readonly [number, number];
  curiousCooldownS: number;
  /** Chance to breathe fire on a newly focused window. */
  breathChance: number;
  /** Cooldown for big actions (breath, roar outside waking, snort, loop). */
  bigCooldownS: number;
  /** Snorts at the cursor after being chased three times (otherwise only flees). */
  snort: boolean;
  /** Longest stretch the dragon may fly over window content. */
  overContentMaxS: number;
  /** Chance of a loop-de-loop per wander leg. */
  loopChance: number;
  /** Roars when woken after a long sleep (otherwise yawns). */
  roarOnWake: boolean;
}

export const ZMEU_TEMPER: Readonly<Record<ZmeuTemper, TemperTuning>> = Object.freeze({
  calm: {
    perchS: [40, 90],
    wanderS: [6, 10],
    curiousCooldownS: 40,
    breathChance: 0,
    bigCooldownS: 180,
    snort: false,
    overContentMaxS: 1.0,
    loopChance: 0.05,
    roarOnWake: false,
  },
  playful: {
    perchS: [20, 50],
    wanderS: [8, 14],
    curiousCooldownS: 20,
    breathChance: 0.3,
    bigCooldownS: 60,
    snort: true,
    overContentMaxS: 1.5,
    loopChance: 0.15,
    roarOnWake: true,
  },
  wild: {
    perchS: [10, 30],
    wanderS: [10, 18],
    curiousCooldownS: 8,
    breathChance: 0.55,
    bigCooldownS: 25,
    snort: true,
    overContentMaxS: 2.5,
    loopChance: 0.25,
    roarOnWake: true,
  },
});

export type ZmeuEdge = 'left' | 'right' | 'top' | 'bottom';
/** How the dragon arrives: across a shared edge, as a fireball from the sky, fading in, or the first hello. */
export type ZmeuVia = 'edge' | 'sky' | 'puff' | 'hello';
export const ZMEU_EDGES: readonly ZmeuEdge[] = ['left', 'right', 'top', 'bottom'];
export const ZMEU_VIAS: readonly ZmeuVia[] = ['edge', 'sky', 'puff', 'hello'];

/** main → overlay: is the dragon on this display, and how does it arrive / leave. */
export interface ZmeuHomeFrame {
  /** Increases with every home decision; overlays ignore older frames. */
  seq: number;
  home: boolean;
  via: ZmeuVia | null;
  edge: ZmeuEdge | null;
  /** Local CSS px along `edge` (y for left/right, x for top/bottom). */
  at: number;
}

/** overlay → main: the dragon finished flying off this display (handoff phase one). */
export interface ZmeuExitReport {
  seq: number;
}

export const ZMEU_MIGRATE_DWELL_MS = 8000;
export const ZMEU_MIGRATE_COOLDOWN_MS = 20000;
export const ZMEU_EXIT_TIMEOUT_MS = 3500;
export const ZMEU_SUPPRESS_MOVE_MS = 3000;

export const ZMEU_NOT_HOME: ZmeuHomeFrame = Object.freeze({ seq: 0, home: false, via: null, edge: null, at: 0 });

// ───────────────────────────── home display (main) ─────────────────────────────
//
// Main is the single authority on where the dragon lives. Every decision bumps
// `seq`; overlays ignore frames older than the last one they saw. A move between
// displays is a two-phase handoff: the old overlay flies out and reports
// `zmeuExited`, then main sends `home: true` to the new one (or after
// ZMEU_EXIT_TIMEOUT_MS when the report never comes). Never two dragons.

type Point = { x: number; y: number };

export interface ZmeuDisplay {
  id: number;
  /** Global DIP bounds. */
  bounds: Rect;
}

/** Where to fly out of one display and into the next (`at` is local CSS px along the edge). */
export interface ZmeuRoute {
  via: 'edge' | 'sky';
  exit: { edge: ZmeuEdge; at: number };
  enter: { edge: ZmeuEdge; at: number };
}

export interface ZmeuHandoff {
  to: number;
  via: ZmeuVia;
  /** Entry edge and position on the target display. */
  edge: ZmeuEdge | null;
  at: number;
  /** When the old display was told to fly out (for the exit timeout). */
  since: number;
}

export interface ZmeuHomeState {
  /** The display the dragon lives on (during a handoff: the one it is leaving). */
  home: number | null;
  seq: number;
  /** Another eligible display the cursor rests on, and since when. */
  candidate: number | null;
  candidateSince: number;
  /** Last arrival anywhere (hello, puff, migrate): starts the migration cooldown. */
  lastMoveAt: number;
  /** A handoff waiting for the old overlay's exit report. */
  pending: ZmeuHandoff | null;
  wasActive: boolean;
  /** When the home display got suppressed (game mode); −1 while it is not. */
  suppressedSince: number;
}

export type ZmeuHomeAction =
  | { kind: 'none' }
  | { kind: 'show'; to: number; via: ZmeuVia }
  | { kind: 'hide'; from: number }
  | { kind: 'migrate'; from: number; to: number; via: 'edge' | 'sky'; exit: ZmeuRoute['exit']; enter: ZmeuRoute['enter'] };

export interface ZmeuHomeInput {
  displays: readonly ZmeuDisplay[];
  suppressed: ReadonlySet<number>;
  /** Global DIP cursor position. */
  cursor: Point | null;
  /** Monotonic milliseconds. */
  now: number;
  /** Zmeul on, licensed and the fire enabled. */
  active: boolean;
  /**
   * Lock screen / suspend: every overlay is hidden and the dragon is frozen where
   * it is. No show, move or dwell until it ends (a hide still goes through).
   */
  held?: boolean;
  primaryId: number;
  /** "Call the dragon": skip the dwell and the cooldown. */
  force?: 'call';
}

/** Shared edges shorter than this are not worth flying through: take the sky route. */
const ZMEU_EDGE_MIN_SPAN = 40;
const ZMEU_EDGE_TOLERANCE = 2;
const NONE: ZmeuHomeAction = Object.freeze({ kind: 'none' });

export function createZmeuHomeState(): ZmeuHomeState {
  return {
    home: null,
    seq: 0,
    candidate: null,
    candidateSince: 0,
    lastMoveAt: Number.NEGATIVE_INFINITY,
    pending: null,
    wasActive: false,
    suppressedSince: -1,
  };
}

function contains(r: Rect, p: Point): boolean {
  return p.x >= r.x && p.y >= r.y && p.x < r.x + r.width && p.y < r.y + r.height;
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** The display under the cursor, if any. */
export function zmeuDisplayAt(displays: readonly ZmeuDisplay[], p: Point | null): number | null {
  if (!p) return null;
  for (const d of displays) if (contains(d.bounds, p)) return d.id;
  return null;
}

/** First home: the cursor's display, else the primary, else any — never a suppressed one. */
export function pickInitialHome(
  displays: readonly ZmeuDisplay[],
  cursor: Point | null,
  suppressed: ReadonlySet<number>,
  primaryId: number,
): number | null {
  const under = zmeuDisplayAt(displays, cursor);
  if (under !== null && !suppressed.has(under)) return under;
  if (!suppressed.has(primaryId) && displays.some((d) => d.id === primaryId)) return primaryId;
  for (const d of displays) if (!suppressed.has(d.id)) return d.id;
  return null;
}

/**
 * How to fly from `from` to `to` (global DIP rects). Displays sharing an edge
 * (±2 px, overlap ≥ 40 px) get an edge crossing at the cursor's height (or x),
 * clamped into each display and made local. Anything else is the fireball
 * "sky" route: up and out of the old display, down onto the cursor's x on the
 * new one (kept within 10–90 % of its width). The sky exit `at` is only a hint:
 * the renderer leaves straight up from wherever the head is.
 */
export function handoffEdges(from: Rect, to: Rect, cursor: Point): ZmeuRoute {
  const vOverlap = Math.min(from.y + from.height, to.y + to.height) - Math.max(from.y, to.y);
  const hOverlap = Math.min(from.x + from.width, to.x + to.width) - Math.max(from.x, to.x);
  const near = (a: number, b: number): boolean => Math.abs(a - b) <= ZMEU_EDGE_TOLERANCE;
  const alongY = (): { a: number; b: number } => ({
    a: clamp(cursor.y, from.y, from.y + from.height) - from.y,
    b: clamp(cursor.y, to.y, to.y + to.height) - to.y,
  });
  const alongX = (): { a: number; b: number } => ({
    a: clamp(cursor.x, from.x, from.x + from.width) - from.x,
    b: clamp(cursor.x, to.x, to.x + to.width) - to.x,
  });
  if (vOverlap >= ZMEU_EDGE_MIN_SPAN) {
    if (near(to.x, from.x + from.width)) {
      const { a, b } = alongY();
      return { via: 'edge', exit: { edge: 'right', at: a }, enter: { edge: 'left', at: b } };
    }
    if (near(to.x + to.width, from.x)) {
      const { a, b } = alongY();
      return { via: 'edge', exit: { edge: 'left', at: a }, enter: { edge: 'right', at: b } };
    }
  }
  if (hOverlap >= ZMEU_EDGE_MIN_SPAN) {
    if (near(to.y, from.y + from.height)) {
      const { a, b } = alongX();
      return { via: 'edge', exit: { edge: 'bottom', at: a }, enter: { edge: 'top', at: b } };
    }
    if (near(to.y + to.height, from.y)) {
      const { a, b } = alongX();
      return { via: 'edge', exit: { edge: 'top', at: a }, enter: { edge: 'bottom', at: b } };
    }
  }
  return skyRoute(from, to, cursor);
}

function skyRoute(from: Rect, to: Rect, cursor: Point): ZmeuRoute {
  return {
    via: 'sky',
    exit: { edge: 'top', at: clamp(cursor.x - from.x, 0.1 * from.width, 0.9 * from.width) },
    enter: { edge: 'top', at: clamp(cursor.x - to.x, 0.1 * to.width, 0.9 * to.width) },
  };
}

/**
 * One home decision. Mutates `st` (and bumps `seq` once per non-`none` action);
 * pure otherwise. Rules, in order:
 *  - not active → hide (once);
 *  - held (lock screen) → nothing, and the dwell restarts afterwards;
 *  - just became active → show via `hello`;
 *  - home (or a handoff target) gone → show on the initial home via `puff`;
 *  - home suppressed ≥ 3 s (or a call) and another display eligible → move via `puff`;
 *  - cursor resting ≥ 8 s on another eligible display, 20 s after the last move → migrate;
 *    `force: 'call'` skips both waits and always takes the sky route.
 * While a handoff is pending nothing else migrates; the caller settles it.
 */
export function stepZmeuHome(st: ZmeuHomeState, input: ZmeuHomeInput): ZmeuHomeAction {
  const { displays, suppressed, cursor, now, primaryId } = input;
  const force = input.force === 'call';

  if (!input.active) {
    const from = st.home;
    const was = st.wasActive;
    st.home = null;
    st.wasActive = false;
    st.pending = null;
    st.candidate = null;
    st.suppressedSince = -1;
    if (!was || from === null) return NONE;
    st.seq++;
    return { kind: 'hide', from };
  }

  if (input.held) {
    st.candidate = null;
    return NONE;
  }

  const settleAt = (to: number): void => {
    st.home = to;
    st.lastMoveAt = now;
    st.pending = null;
    st.candidate = null;
    st.suppressedSince = -1;
    st.seq++;
  };

  if (!st.wasActive) {
    const to = pickInitialHome(displays, cursor, suppressed, primaryId);
    if (to === null) return NONE;
    st.wasActive = true;
    settleAt(to);
    return { kind: 'show', to, via: 'hello' };
  }

  const exists = (id: number | null): boolean => id !== null && displays.some((d) => d.id === id);
  if (!exists(st.home) || (st.pending && !exists(st.pending.to))) {
    const to = pickInitialHome(displays, cursor, suppressed, primaryId);
    if (to === null) {
      st.home = null;
      st.pending = null;
      st.candidate = null;
      st.suppressedSince = -1;
      return NONE;
    }
    settleAt(to);
    return { kind: 'show', to, via: 'puff' };
  }
  const home = st.home as number;
  if (st.pending) return NONE;

  if (suppressed.has(home)) {
    if (st.suppressedSince < 0) st.suppressedSince = now;
    if (force || now - st.suppressedSince >= ZMEU_SUPPRESS_MOVE_MS) {
      const to = pickInitialHome(displays, cursor, suppressed, primaryId);
      if (to !== null && to !== home) {
        settleAt(to);
        return { kind: 'show', to, via: 'puff' };
      }
    }
    // A hidden overlay cannot fly out: no dwell migration from here.
    st.candidate = null;
    return NONE;
  }
  st.suppressedSince = -1;

  const under = zmeuDisplayAt(displays, cursor);
  const candidate = under !== null && under !== home && !suppressed.has(under) ? under : null;
  if (candidate !== st.candidate) {
    st.candidate = candidate;
    st.candidateSince = now;
  }
  if (candidate === null || !cursor) return NONE;
  if (!force && (now - st.candidateSince < ZMEU_MIGRATE_DWELL_MS || now - st.lastMoveAt < ZMEU_MIGRATE_COOLDOWN_MS)) return NONE;

  const fromBounds = displays.find((d) => d.id === home)?.bounds;
  const toBounds = displays.find((d) => d.id === candidate)?.bounds;
  if (!fromBounds || !toBounds) return NONE;
  const route = force ? skyRoute(fromBounds, toBounds, cursor) : handoffEdges(fromBounds, toBounds, cursor);
  st.seq++;
  st.lastMoveAt = now;
  st.candidate = null;
  st.pending = { to: candidate, via: route.via, edge: route.enter.edge, at: route.enter.at, since: now };
  return { kind: 'migrate', from: home, to: candidate, via: route.via, exit: route.exit, enter: route.enter };
}

/**
 * Second phase of a handoff (exit reported, or timed out): the target becomes
 * home. Returns the settled handoff, or null when none was pending.
 */
export function settleZmeuHandoff(st: ZmeuHomeState, now: number): ZmeuHandoff | null {
  const p = st.pending;
  if (!p) return null;
  st.home = p.to;
  st.pending = null;
  st.lastMoveAt = now;
  st.candidate = null;
  st.suppressedSince = -1;
  return p;
}

/**
 * When stepZmeuHome (or the exit timeout) next has something to do on its own,
 * or null. A suppression or dwell deadline already passed at `now` (the step
 * that just ran had nowhere to go) is not one: only a topology, suppression or
 * cursor change can unblock it, and those sync anyway. The exit timeout always is.
 */
export function nextZmeuHomeDeadline(st: ZmeuHomeState, now: number): number | null {
  if (!st.wasActive) return null;
  if (st.pending) return st.pending.since + ZMEU_EXIT_TIMEOUT_MS;
  let at: number | null = null;
  if (st.suppressedSince >= 0) at = st.suppressedSince + ZMEU_SUPPRESS_MOVE_MS;
  else if (st.candidate !== null) at = Math.max(st.candidateSince + ZMEU_MIGRATE_DWELL_MS, st.lastMoveAt + ZMEU_MIGRATE_COOLDOWN_MS);
  return at !== null && at > now ? at : null;
}

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null;
}

function isSeq(v: unknown): v is number {
  return typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
}

/** Validates a home frame from IPC (renderer side): null when anything is off. */
export function sanitizeZmeuHomeFrame(x: unknown): ZmeuHomeFrame | null {
  if (!isRecord(x)) return null;
  const { seq, home, via, edge, at } = x;
  if (!isSeq(seq) || typeof home !== 'boolean') return null;
  if (typeof at !== 'number' || !Number.isFinite(at)) return null;
  if (via !== null && !(ZMEU_VIAS as readonly unknown[]).includes(via)) return null;
  if (edge !== null && !(ZMEU_EDGES as readonly unknown[]).includes(edge)) return null;
  return { seq, home, via: via as ZmeuVia | null, edge: edge as ZmeuEdge | null, at };
}

/** Validates an exit report from an overlay (main side). */
export function sanitizeZmeuExit(x: unknown): ZmeuExitReport | null {
  if (!isRecord(x) || !isSeq(x.seq)) return null;
  return { seq: x.seq };
}
