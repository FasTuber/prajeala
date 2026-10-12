/**
 * Zmeul — the desktop fire dragon. Shared, pure pieces: size, temper tuning,
 * and the contract main uses to tell overlays where the dragon lives (one
 * dragon per app, on one "home" display at a time).
 *
 * The home-display logic (stepZmeuHome & co.) also lives here so it can be
 * unit-tested without Electron.
 */
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
