/**
 * Zmeul's home display: main is the single authority on which overlay draws
 * the dragon. Wraps the pure stepZmeuHome (src/shared/zmeu.ts) with the IPC
 * and the timers:
 *
 * - show / hide → a ZmeuHomeFrame to every overlay (home: true to one of them);
 * - migrate → phase one: only the old home hears `home: false` with the exit
 *   edge; phase two (its `zmeuExited` report, or ZMEU_EXIT_TIMEOUT_MS) sends
 *   `home: true` with the entry edge to the new home;
 * - one unref'd timer wakes the logic at the next deadline (dwell end,
 *   suppression move, exit timeout); cursor moves only cost a display lookup;
 * - a page that loads well after the arrival (crash reload, overlay rebuild on
 *   a display-metrics change) fades the dragon in (`puff`) instead of replaying
 *   the hello / edge / sky entry it already saw.
 */
import { IPC } from '../shared/ipc';
import {
  ZMEU_EXIT_TIMEOUT_MS,
  createZmeuHomeState,
  nextZmeuHomeDeadline,
  settleZmeuHandoff,
  stepZmeuHome,
  zmeuDisplayAt,
  type ZmeuDisplay,
  type ZmeuEdge,
  type ZmeuExitReport,
  type ZmeuHomeAction,
  type ZmeuHomeFrame,
  type ZmeuHomeState,
  type ZmeuVia,
} from '../shared/zmeu';
import type { Point } from './geometry';
import { createLogger } from './log';
import type { Overlay, OverlayManager } from './overlay-manager';

const log = createLogger('zmeu');

/**
 * How long after a home decision a freshly loaded page still gets its entry
 * (startup: the hello reaches pages that are still loading). Later loads puff in.
 */
export const ZMEU_ARRIVAL_REPLAY_MS = 10_000;
const PUFF_IN: Readonly<Arrival> = { via: 'puff', edge: null, at: 0 };

/** The slice of OverlayManager the director uses (tests pass a fake). */
export type ZmeuOverlays = Pick<OverlayManager, 'list' | 'sendTo'>;

export interface ZmeuDirectorDeps {
  overlays: ZmeuOverlays;
  /** Zmeul on (and licensed) and the fire enabled. Power sleep does not count: it naps in place. */
  active(): boolean;
  /** Lock screen / suspend (governor paused): the dragon is frozen where it is, no home changes. */
  held?(): boolean;
  /** Displays hidden by game mode. */
  suppressed(): ReadonlySet<number>;
  /** Global DIP cursor position. */
  readCursor(): Point | null;
  primaryId(): number;
  /** Monotonic ms (tests). */
  now?(): number;
}

interface Arrival {
  via: ZmeuVia | null;
  edge: ZmeuEdge | null;
  at: number;
}

export class ZmeuDirector {
  private readonly st: ZmeuHomeState = createZmeuHomeState();
  /** How the dragon arrived on its current home (re-sent to a page that loads soon after). */
  private arrival: Arrival = { via: null, edge: null, at: 0 };
  /** When that arrival was decided (see ZMEU_ARRIVAL_REPLAY_MS). */
  private arrivalAt = Number.NEGATIVE_INFINITY;
  /** Phase one of a handoff: what the old home was told. */
  private exit: Arrival | null = null;
  /** A call that waits for the handoff it started. */
  private callAfterArrival = false;
  private timer: NodeJS.Timeout | null = null;
  private timerAt = Number.POSITIVE_INFINITY;
  /** Display under the cursor at the last noteCursor (cheap change detection). */
  private cursorDisplay: number | null = null;
  /** Overlay rects as of the last step ('overlays-changed' always syncs): noteCursor allocates nothing. */
  private rects: ZmeuDisplay[] = [];
  private disposed = false;

  constructor(private readonly deps: ZmeuDirectorDeps) {}

  /** Re-evaluates the home after any change (settings, licence, power, game mode, topology). */
  sync(reason: string): void {
    if (this.disposed) return;
    this.apply(this.step(), reason);
  }

  /** Cursor moved: O(displays); runs the logic only when it crosses into another display. */
  noteCursor(p: Point): void {
    if (this.disposed || !this.st.wasActive) return;
    const under = zmeuDisplayAt(this.rects, p);
    if (under === this.cursorDisplay) return;
    this.cursorDisplay = under;
    this.sync('cursor');
  }

  /** Phase two of a handoff: the old home reports the dragon has flown off. */
  onExited(overlay: Overlay, r: ZmeuExitReport): void {
    const p = this.st.pending;
    if (this.disposed || !p || overlay.id !== this.st.home || r.seq !== this.st.seq) return;
    this.settle('exited');
  }

  /** The frame for one overlay right now (getZmeuHome invoke, freshly loaded page). */
  frameFor(overlay: Overlay): ZmeuHomeFrame {
    const st = this.st;
    if (overlay.id === st.home) {
      if (st.pending) return { seq: st.seq, home: false, via: this.exit?.via ?? null, edge: this.exit?.edge ?? null, at: this.exit?.at ?? 0 };
      const fresh = this.now() - this.arrivalAt < ZMEU_ARRIVAL_REPLAY_MS;
      return { seq: st.seq, home: true, ...(fresh ? this.arrival : PUFF_IN) };
    }
    return notHome(st.seq);
  }

  /** "Call the dragon": to the cursor on the home display, or a fireball flight to the cursor's display first. */
  call(): void {
    if (this.disposed || !this.deps.active() || this.deps.held?.()) return;
    this.apply(this.step('call'), 'call');
    if (this.st.pending) this.callAfterArrival = true;
    else if (this.st.home !== null) this.sendCall(this.st.home);
  }

  dispose(): void {
    this.disposed = true;
    this.clearTimer();
  }

  // ── internals ──────────────────────────────────────────────────────────

  private now(): number {
    return this.deps.now ? this.deps.now() : performance.now();
  }

  private displays(): ZmeuDisplay[] {
    return this.deps.overlays.list().map((o) => ({ id: o.id, bounds: o.info.bounds }));
  }

  private step(force?: 'call'): ZmeuHomeAction {
    const cursor = this.deps.readCursor();
    const displays = this.displays();
    this.rects = displays;
    this.cursorDisplay = zmeuDisplayAt(displays, cursor);
    return stepZmeuHome(this.st, {
      displays,
      suppressed: this.deps.suppressed(),
      cursor,
      now: this.now(),
      active: this.deps.active(),
      held: this.deps.held?.() ?? false,
      primaryId: this.deps.primaryId(),
      ...(force ? { force } : {}),
    });
  }

  private apply(action: ZmeuHomeAction, reason: string): void {
    const seq = this.st.seq;
    switch (action.kind) {
      case 'none':
        break;
      case 'show':
        this.exit = null;
        this.callAfterArrival = false;
        this.arrival = { via: action.via, edge: null, at: 0 };
        this.arrivalAt = this.now();
        log.info(`home → display ${action.to} via ${action.via} (seq ${seq}, ${reason})`);
        this.broadcast();
        break;
      case 'hide':
        this.exit = null;
        this.callAfterArrival = false;
        this.arrival = { via: null, edge: null, at: 0 };
        log.info(`dragon leaves display ${action.from} (seq ${seq}, ${reason})`);
        this.broadcast();
        break;
      case 'migrate': {
        this.exit = { via: action.via, edge: action.exit.edge, at: action.exit.at };
        log.info(`handoff ${action.from} → ${action.to} via ${action.via} (${action.exit.edge} → ${action.enter.edge}, seq ${seq}, ${reason})`);
        const from = this.overlay(action.from);
        if (from) this.deps.overlays.sendTo<ZmeuHomeFrame>(from, IPC.zmeuHome, this.frameFor(from));
        break;
      }
    }
    this.arm();
  }

  /** The exit was reported (or timed out): the target becomes home and hears how to enter. */
  private settle(reason: string): void {
    const p = settleZmeuHandoff(this.st, this.now());
    if (!p) return;
    this.exit = null;
    this.arrival = { via: p.via, edge: p.edge, at: p.at };
    this.arrivalAt = this.now();
    log.info(`handoff done → display ${p.to} (${reason})`);
    const target = this.overlay(p.to);
    if (target) this.deps.overlays.sendTo<ZmeuHomeFrame>(target, IPC.zmeuHome, this.frameFor(target));
    if (this.callAfterArrival) {
      this.callAfterArrival = false;
      this.sendCall(p.to);
    }
    // The new home may be suppressed by now, or the cursor resting on a third display:
    // re-evaluate so those timers start (a cursor that does not cross displays never syncs).
    this.sync('settled');
  }

  private broadcast(): void {
    for (const overlay of this.deps.overlays.list()) {
      this.deps.overlays.sendTo<ZmeuHomeFrame>(overlay, IPC.zmeuHome, this.frameFor(overlay));
    }
  }

  private sendCall(displayId: number): void {
    const overlay = this.overlay(displayId);
    if (!overlay) return;
    const b = overlay.info.bounds;
    const c = this.deps.readCursor();
    const p = c && Number.isFinite(c.x) && Number.isFinite(c.y) ? c : null;
    // A cursor on another (unlit) display: the nearest point of this one.
    const x = p ? Math.min(Math.max(p.x - b.x, 0), b.width) : b.width / 2;
    const y = p ? Math.min(Math.max(p.y - b.y, 0), b.height) : b.height / 2;
    this.deps.overlays.sendTo(overlay, IPC.zmeuCall, { x, y });
  }

  private overlay(id: number): Overlay | undefined {
    return this.deps.overlays.list().find((o) => o.id === id);
  }

  /** One timer at the next deadline (dwell end, suppression move, exit timeout). */
  private arm(): void {
    const at = nextZmeuHomeDeadline(this.st, this.now());
    if (at === null) {
      this.clearTimer();
      return;
    }
    if (this.timer && at === this.timerAt) return;
    this.clearTimer();
    this.timerAt = at;
    // +1 ms: wake strictly after the deadline, not a rounding error before it.
    this.timer = setTimeout(() => this.onTimer(), Math.max(0, at - this.now()) + 1);
    this.timer.unref?.();
  }

  private clearTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.timerAt = Number.POSITIVE_INFINITY;
  }

  private onTimer(): void {
    this.timer = null;
    this.timerAt = Number.POSITIVE_INFINITY;
    if (this.disposed) return;
    const p = this.st.pending;
    if (p && this.now() - p.since >= ZMEU_EXIT_TIMEOUT_MS) {
      log.debug('no exit report from the old home: handing off anyway');
      this.settle('timeout');
      return;
    }
    this.sync('timer');
  }
}

function notHome(seq: number): ZmeuHomeFrame {
  return { seq, home: false, via: null, edge: null, at: 0 };
}
