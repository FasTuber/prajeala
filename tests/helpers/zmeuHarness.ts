/**
 * Seeded simulation harness for the Zmeul core: drives ZmeuCore exactly as
 * App does (senses object, cursor samples, pointer buttons, keys, then
 * step(dt, senses, wallMs) and takeEvents()), with a scripted world.
 */
import type { ZmeuSize, ZmeuTemper } from '../../src/shared/settings';
import type { ZmeuHomeFrame } from '../../src/shared/zmeu';
import { zmeuLength } from '../../src/shared/zmeu';
import { Random } from '../../src/renderer/util/math';
import { ZmeuCore } from '../../src/renderer/zmeu/core/ZmeuCore';
import type { ZmeuSenses } from '../../src/renderer/zmeu/core/senses';
import { createZmeuSenses } from '../../src/renderer/zmeu/core/senses';
import type { ZmeuState } from '../../src/renderer/zmeu/core/tuning';

export interface HarnessClick {
  type: 'down' | 'up' | 'click';
  x: number;
  y: number;
}

/** What a script returns each frame. Sense fields persist until changed; cursor persists (null = unknown). */
export type HarnessInput = Partial<ZmeuSenses> & {
  clicks?: HarnessClick[];
  keys?: number;
  cursor?: { x: number; y: number } | null;
  home?: ZmeuHomeFrame;
  enabled?: boolean;
};

export interface SimOptions {
  seconds: number;
  /** Fixed frame dt, or 'jitter' for seeded dt in [jitter[0], jitter[1]]. */
  dt?: number | 'jitter';
  jitter?: [number, number];
  W?: number;
  H?: number;
  floor?: number;
  seed?: number;
  temper?: ZmeuTemper;
  size?: ZmeuSize;
  /** Initial home frame (default: home via puff). null = not home. */
  home?: ZmeuHomeFrame | null;
  enabled?: boolean;
  script?: (t: number, core: ZmeuCore, senses: ZmeuSenses) => HarnessInput | void;
  setup?: (core: ZmeuCore, senses: ZmeuSenses) => void;
  onFrame?: (t: number, core: ZmeuCore, events: number, senses: ZmeuSenses) => void;
  /** Snapshot period (s). */
  snapEvery?: number;
}

export interface TimelineEntry {
  t: number;
  state: ZmeuState;
  events: number;
  impactX: number;
  impactY: number;
  igniteX: number;
  igniteY: number;
  exitSeq: number;
}

export interface Snapshot {
  t: number;
  state: ZmeuState;
  x: number;
  y: number;
  speed: number;
  visible: boolean;
  petFps: number;
  wantsFluid: boolean;
  happy: number;
  ball: number;
  onPerch: boolean;
}

export interface SimResult {
  timeline: TimelineEntry[];
  snapshots: Snapshot[];
  resets: number;
  core: ZmeuCore;
  senses: ZmeuSenses;
  /** Seconds spent in each state. */
  time: Partial<Record<ZmeuState, number>>;
  /** Number of entries into each state. */
  entries: Partial<Record<ZmeuState, number>>;
  /** Count of each event bit over the run. */
  eventCount: (bit: number) => number;
}

export const HOME_PUFF: ZmeuHomeFrame = { seq: 1, home: true, via: 'puff', edge: null, at: 0 };
export const HOME_HELLO: ZmeuHomeFrame = { seq: 1, home: true, via: 'hello', edge: null, at: 0 };

export function simulate(o: SimOptions): SimResult {
  const W = o.W ?? 1920;
  const H = o.H ?? 1080;
  const senses = createZmeuSenses(W, H);
  senses.floor = o.floor ?? H;
  senses.temper = o.temper ?? 'playful';
  const size = o.size ?? 'medium';
  senses.L = zmeuLength(size, W, H);
  const core = new ZmeuCore(o.seed ?? 1);
  core.setEnabled(o.enabled ?? true);
  const home = o.home === undefined ? HOME_PUFF : o.home;
  if (home) core.setHome(home);
  o.setup?.(core, senses);

  const jit = new Random(((o.seed ?? 1) * 7919) >>> 0);
  const [j0, j1] = o.jitter ?? [1 / 240, 0.25];
  const snapEvery = o.snapEvery ?? 0.1;
  const timeline: TimelineEntry[] = [];
  const snapshots: Snapshot[] = [];
  const time: Partial<Record<ZmeuState, number>> = {};
  const entries: Partial<Record<ZmeuState, number>> = {};
  const counts = new Map<number, number>();
  let t = 0;
  let lastInput = 0;
  let lastKey = -1e9;
  let cursor: { x: number; y: number } | null = null;
  let nextSnap = 0;
  let lastState: ZmeuState | null = null;

  while (t < o.seconds - 1e-9) {
    const dt = o.dt === 'jitter' ? jit.range(j0, j1) : (o.dt ?? 1 / 60);
    t += dt;
    const input = o.script?.(t, core, senses) ?? undefined;
    let moved = false;
    if (input) {
      const { clicks, keys, cursor: c, home: hf, enabled, ...rest } = input;
      Object.assign(senses, rest);
      if (hf) core.setHome(hf);
      if (enabled !== undefined) core.setEnabled(enabled);
      if (c === null) cursor = null;
      else if (c) {
        if (cursor) {
          senses.cvx = (c.x - cursor.x) / dt;
          senses.cvy = (c.y - cursor.y) / dt;
        }
        moved = !cursor || c.x !== cursor.x || c.y !== cursor.y;
        cursor = { x: c.x, y: c.y };
      }
      if (keys) {
        for (let k = 0; k < keys; k++) core.noteKey(t);
        lastKey = t;
        lastInput = t;
      }
      if (clicks) {
        for (const ck of clicks) {
          if (ck.type === 'down' || ck.type === 'click') core.onPointer('down', ck.x, ck.y, true, 'left', t);
          if (ck.type === 'up' || ck.type === 'click') core.onPointer('up', ck.x, ck.y, true, 'left', t);
        }
        lastInput = t;
      }
    }
    if (cursor) {
      senses.cursorKnown = true;
      senses.cursorInside = true;
      senses.cx = cursor.x;
      senses.cy = cursor.y;
      if (!moved) {
        senses.cvx = 0;
        senses.cvy = 0;
      } else {
        core.noteCursor(cursor.x, cursor.y, t);
        lastInput = t;
      }
      senses.cspeed = Math.hypot(senses.cvx, senses.cvy);
    } else {
      senses.cursorKnown = false;
      senses.cursorInside = false;
      senses.cvx = 0;
      senses.cvy = 0;
      senses.cspeed = 0;
    }
    if (!input || input.inputIdleS === undefined) senses.inputIdleS = t - lastInput;
    if (!input || input.typingRecent === undefined) senses.typingRecent = t - lastKey < 4;

    core.step(dt, senses, t * 1000);
    const ev = core.takeEvents();
    const st = core.state;
    time[st] = (time[st] ?? 0) + dt;
    if (st !== lastState) entries[st] = (entries[st] ?? 0) + 1;
    if (ev) {
      for (let b = 1; b <= ev; b <<= 1) if (ev & b) counts.set(b, (counts.get(b) ?? 0) + 1);
    }
    if (st !== lastState || ev) {
      timeline.push({ t, state: st, events: ev, impactX: core.impactX, impactY: core.impactY, igniteX: core.igniteX, igniteY: core.igniteY, exitSeq: core.exitSeq });
    }
    lastState = st;
    if (t >= nextSnap) {
      nextSnap += snapEvery;
      snapshots.push({
        t,
        state: st,
        x: core.pose.headX,
        y: core.pose.headY,
        speed: core.pose.speed,
        visible: core.visible,
        petFps: core.petFps,
        wantsFluid: core.wantsFluid,
        happy: core.pose.happy,
        ball: core.pose.ball,
        onPerch: core.onPerch,
      });
    }
    o.onFrame?.(t, core, ev, senses);
  }
  return {
    timeline,
    snapshots,
    resets: core.resets,
    core,
    senses,
    time,
    entries,
    eventCount: (bit) => counts.get(bit) ?? 0,
  };
}

/** First timeline time at which `state` is entered (or −1). */
export function firstEntry(r: SimResult, state: ZmeuState, after = 0): number {
  for (const e of r.timeline) if (e.state === state && e.t >= after) return e.t;
  return -1;
}

/** A point on the body (joint i of the display spine). */
export function bodyPoint(core: ZmeuCore, i: number): { x: number; y: number } {
  return { x: core.bodyX[i]!, y: core.bodyY[i]! };
}
