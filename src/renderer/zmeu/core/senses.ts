/**
 * What the dragon perceives each frame. App fills one preallocated object
 * (createZmeuSenses) from its own state and hands it to `ZmeuCore.step`; the
 * core never reads the DOM. Rects and points are plain objects App reuses.
 */
import type { Rect } from '../../../shared/ipc';
import type { ZmeuTemper } from '../../../shared/settings';
import { zmeuLength } from '../../../shared/zmeu';

export interface ZmeuPoint {
  x: number;
  y: number;
}

export interface ZmeuSenses {
  /** Display, CSS px: size, the floor line (top of the taskbar), S = min(w, h), dragon length L. */
  width: number;
  height: number;
  floor: number;
  S: number;
  L: number;
  /** Cursor (CursorState): position, smoothed velocity and speed in px/s. */
  cursorKnown: boolean;
  cursorInside: boolean;
  cx: number;
  cy: number;
  cvx: number;
  cvy: number;
  cspeed: number;
  /** Seconds since the last cursor move, click or key, whichever is most recent. */
  inputIdleS: number;
  /** A key within the last 4 s. */
  typingRecent: boolean;
  buttonHeld: boolean;
  focusTicking: boolean;
  /** Active window in local px (null when it is ours, off this display or empty). */
  win: Rect | null;
  /** Hash of the owning app (not the title: a title-only change is the same window). */
  winKey: number;
  winMaximized: boolean;
  buttonsZone: 'right150' | 'left90';
  powerSleeping: boolean;
  torch: boolean;
  /** Another emitter was active last frame (the sim is warm anyway). */
  othersActive: boolean;
  /** A burn-front point while Arde tot runs, refreshed by App every 3.5 s. */
  burnTarget: ZmeuPoint | null;
  reducedMotion: boolean;
  temper: ZmeuTemper;
  /** `settings.idleSleep ? idleSleepSeconds : 0`. */
  idleSleepS: number;
}

/** A senses object with sane defaults for a 1920×1080 display. */
export function createZmeuSenses(width = 1920, height = 1080): ZmeuSenses {
  return {
    width,
    height,
    floor: height,
    S: Math.min(width, height),
    L: zmeuLength('medium', width, height),
    cursorKnown: false,
    cursorInside: false,
    cx: 0,
    cy: 0,
    cvx: 0,
    cvy: 0,
    cspeed: 0,
    inputIdleS: 0,
    typingRecent: false,
    buttonHeld: false,
    focusTicking: false,
    win: null,
    winKey: 0,
    winMaximized: false,
    buttonsZone: 'right150',
    powerSleeping: false,
    torch: false,
    othersActive: false,
    burnTarget: null,
    reducedMotion: false,
    temper: 'playful',
    idleSleepS: 0,
  };
}
