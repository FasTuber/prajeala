import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { IPC } from '../src/shared/ipc';
import type { Overlay } from '../src/main/overlay-manager';
import { ZMEU_ARRIVAL_REPLAY_MS, ZmeuDirector, type ZmeuOverlays } from '../src/main/zmeu-director';
import { ZMEU_SIZES, ZMEU_TEMPERS } from '../src/shared/settings';
import {
  ZMEU_EXIT_TIMEOUT_MS,
  ZMEU_MIGRATE_COOLDOWN_MS,
  ZMEU_MIGRATE_DWELL_MS,
  ZMEU_SUPPRESS_MOVE_MS,
  ZMEU_TEMPER,
  createZmeuHomeState,
  handoffEdges,
  nextZmeuHomeDeadline,
  pickInitialHome,
  sanitizeZmeuExit,
  sanitizeZmeuHomeFrame,
  settleZmeuHandoff,
  stepZmeuHome,
  zmeuLength,
  type ZmeuDisplay,
  type ZmeuHomeFrame,
  type ZmeuHomeInput,
  type ZmeuHomeState,
} from '../src/shared/zmeu';

vi.mock('../src/main/log', () => {
  const quiet = (): undefined => undefined;
  return { createLogger: () => ({ debug: quiet, info: quiet, warn: quiet, error: quiet, at: quiet }) };
});

const A: ZmeuDisplay = { id: 1, bounds: { x: 0, y: 0, width: 1920, height: 1080 } };
const B: ZmeuDisplay = { id: 2, bounds: { x: 1920, y: 0, width: 1920, height: 1080 } };
const C: ZmeuDisplay = { id: 3, bounds: { x: 0, y: 1080, width: 1920, height: 1080 } };
const onA = { x: 500, y: 400 };
const onB = { x: 2500, y: 300 };
const none: ReadonlySet<number> = new Set();

function input(patch: Partial<ZmeuHomeInput> = {}): ZmeuHomeInput {
  return { displays: [A, B], suppressed: none, cursor: onA, now: 0, active: true, primaryId: 1, ...patch };
}

/** Active, at home on A since t = 0 (hello). */
function activeOnA(): ZmeuHomeState {
  const st = createZmeuHomeState();
  expect(stepZmeuHome(st, input())).toEqual({ kind: 'show', to: 1, via: 'hello' });
  return st;
}

describe('zmeuLength', () => {
  it('is 0.25 of the short side at medium: 270 px at 1080p', () => {
    expect(zmeuLength('medium', 1920, 1080)).toBe(270);
  });

  it('clamps to [150, 520]', () => {
    expect(zmeuLength('small', 640, 480)).toBe(150);
    expect(zmeuLength('large', 7680, 4320)).toBe(520);
    expect(zmeuLength('medium', Number.NaN, 1080)).toBe(150);
  });

  it('grows with the size setting', () => {
    for (const [w, h] of [
      [1920, 1080],
      [2560, 1440],
      [1280, 720],
    ] as const) {
      const lengths = ZMEU_SIZES.map((s) => zmeuLength(s, w, h));
      for (let i = 1; i < lengths.length; i++) expect(lengths[i]!).toBeGreaterThanOrEqual(lengths[i - 1]!);
    }
  });
});

describe('ZMEU_TEMPER', () => {
  it('is monotonic: calm waits longest, wild is the boldest', () => {
    const [calm, playful, wild] = ZMEU_TEMPERS.map((k) => ZMEU_TEMPER[k]);
    expect(calm!.bigCooldownS).toBeGreaterThanOrEqual(playful!.bigCooldownS);
    expect(playful!.bigCooldownS).toBeGreaterThanOrEqual(wild!.bigCooldownS);
    expect(calm!.curiousCooldownS).toBeGreaterThanOrEqual(playful!.curiousCooldownS);
    expect(playful!.curiousCooldownS).toBeGreaterThanOrEqual(wild!.curiousCooldownS);
    expect(calm!.breathChance).toBe(0);
    expect(playful!.breathChance).toBeLessThanOrEqual(wild!.breathChance);
    expect(calm!.snort).toBe(false);
  });
});

describe('handoffEdges', () => {
  it('side by side: exit right, enter left, at the cursor height on both', () => {
    const r = handoffEdges(A.bounds, B.bounds, { x: 1930, y: 640 });
    expect(r).toEqual({ via: 'edge', exit: { edge: 'right', at: 640 }, enter: { edge: 'left', at: 640 } });
    // and back
    expect(handoffEdges(B.bounds, A.bounds, { x: 100, y: 200 })).toEqual({
      via: 'edge',
      exit: { edge: 'left', at: 200 },
      enter: { edge: 'right', at: 200 },
    });
  });

  it('a left neighbour with negative x', () => {
    const left = { x: -1280, y: 100, width: 1280, height: 1024 };
    const r = handoffEdges(A.bounds, left, { x: -300, y: 500 });
    expect(r).toEqual({ via: 'edge', exit: { edge: 'left', at: 500 }, enter: { edge: 'right', at: 400 } });
  });

  it('stacked: exit bottom, enter top, at the cursor x', () => {
    expect(handoffEdges(A.bounds, C.bounds, { x: 777, y: 1500 })).toEqual({
      via: 'edge',
      exit: { edge: 'bottom', at: 777 },
      enter: { edge: 'top', at: 777 },
    });
    expect(handoffEdges(C.bounds, A.bounds, { x: 777, y: 20 })).toMatchObject({ exit: { edge: 'top' }, enter: { edge: 'bottom' } });
  });

  it('different heights with an offset: at is clamped into each span', () => {
    const tall = { x: 1920, y: -400, width: 1080, height: 1920 };
    // cursor high up on the tall display, above the top of A
    const r = handoffEdges(A.bounds, tall, { x: 2200, y: -300 });
    expect(r.via).toBe('edge');
    expect(r.exit).toEqual({ edge: 'right', at: 0 });
    expect(r.enter).toEqual({ edge: 'left', at: 100 });
    // cursor below A's bottom
    const low = handoffEdges(A.bounds, tall, { x: 2200, y: 1400 });
    expect(low.exit.at).toBe(1080);
    expect(low.enter.at).toBe(1800);
  });

  it('a 10 px gap takes the sky', () => {
    const gap = { x: 1930, y: 0, width: 1920, height: 1080 };
    const r = handoffEdges(A.bounds, gap, { x: 2000, y: 500 });
    expect(r.via).toBe('sky');
    expect(r.exit.edge).toBe('top');
    expect(r.enter.edge).toBe('top');
    // cursor x local to the target, kept within 10–90 % of its width
    expect(r.enter.at).toBe(192);
    expect(handoffEdges(A.bounds, gap, { x: 3000, y: 500 }).enter.at).toBe(1070);
  });

  it('a shared edge under 40 px takes the sky', () => {
    const corner = { x: 1920, y: 1050, width: 1920, height: 1080 };
    expect(handoffEdges(A.bounds, corner, { x: 2000, y: 1500 }).via).toBe('sky');
    const diagonal = { x: 1920, y: 1080, width: 1920, height: 1080 };
    expect(handoffEdges(A.bounds, diagonal, { x: 2000, y: 1500 }).via).toBe('sky');
  });

  it('tolerates a 2 px misalignment', () => {
    const nudged = { x: 1922, y: 0, width: 1920, height: 1080 };
    expect(handoffEdges(A.bounds, nudged, { x: 2000, y: 10 }).via).toBe('edge');
  });
});

describe('pickInitialHome', () => {
  it("prefers the cursor's display, then the primary, skipping suppressed ones", () => {
    expect(pickInitialHome([A, B], onB, none, 1)).toBe(2);
    expect(pickInitialHome([A, B], null, none, 1)).toBe(1);
    expect(pickInitialHome([A, B], { x: -50, y: -50 }, none, 2)).toBe(2);
    expect(pickInitialHome([A, B], onB, new Set([2]), 1)).toBe(1);
    expect(pickInitialHome([A, B], onA, new Set([1]), 1)).toBe(2);
    expect(pickInitialHome([A, B], onA, new Set([1, 2]), 1)).toBeNull();
    expect(pickInitialHome([], onA, none, 1)).toBeNull();
  });

  it('falls back to any display when the primary has no overlay', () => {
    expect(pickInitialHome([B], null, none, 1)).toBe(2);
  });
});

describe('stepZmeuHome', () => {
  it('shows via hello once on becoming active, then stays quiet', () => {
    const st = createZmeuHomeState();
    expect(stepZmeuHome(st, input({ active: false }))).toEqual({ kind: 'none' });
    expect(st.seq).toBe(0);
    expect(stepZmeuHome(st, input({ cursor: onB, now: 5 }))).toEqual({ kind: 'show', to: 2, via: 'hello' });
    expect(st).toMatchObject({ home: 2, seq: 1, wasActive: true, lastMoveAt: 5 });
    expect(stepZmeuHome(st, input({ cursor: onB, now: 6 }))).toEqual({ kind: 'none' });
    expect(st.seq).toBe(1);
  });

  it('waits for a display when none is eligible yet', () => {
    const st = createZmeuHomeState();
    expect(stepZmeuHome(st, input({ displays: [] }))).toEqual({ kind: 'none' });
    expect(st.wasActive).toBe(false);
    expect(stepZmeuHome(st, input())).toMatchObject({ kind: 'show', via: 'hello' });
  });

  it('migrates after an 8 s dwell, not a millisecond earlier', () => {
    const st = activeOnA();
    const t0 = 30_000;
    expect(stepZmeuHome(st, input({ cursor: onB, now: t0 })).kind).toBe('none');
    expect(st.candidate).toBe(2);
    expect(stepZmeuHome(st, input({ cursor: { x: 3000, y: 900 }, now: t0 + ZMEU_MIGRATE_DWELL_MS - 1 })).kind).toBe('none');
    const a = stepZmeuHome(st, input({ cursor: onB, now: t0 + ZMEU_MIGRATE_DWELL_MS }));
    expect(a).toEqual({
      kind: 'migrate',
      from: 1,
      to: 2,
      via: 'edge',
      exit: { edge: 'right', at: 300 },
      enter: { edge: 'left', at: 300 },
    });
    expect(st.pending).toEqual({ to: 2, via: 'edge', edge: 'left', at: 300, since: t0 + ZMEU_MIGRATE_DWELL_MS });
    // home stays the old display until the handoff settles
    expect(st.home).toBe(1);
  });

  it('resets the dwell when the cursor comes back home', () => {
    const st = activeOnA();
    stepZmeuHome(st, input({ cursor: onB, now: 30_000 }));
    stepZmeuHome(st, input({ cursor: onA, now: 35_000 }));
    expect(st.candidate).toBeNull();
    expect(stepZmeuHome(st, input({ cursor: onB, now: 36_000 })).kind).toBe('none');
    expect(stepZmeuHome(st, input({ cursor: onB, now: 38_000 })).kind).toBe('none');
    expect(stepZmeuHome(st, input({ cursor: onB, now: 44_000 })).kind).toBe('migrate');
  });

  it('holds the 20 s cooldown after a move', () => {
    const st = activeOnA(); // arrived at t = 0
    stepZmeuHome(st, input({ cursor: onB, now: 1_000 }));
    expect(stepZmeuHome(st, input({ cursor: onB, now: 9_000 })).kind).toBe('none');
    expect(stepZmeuHome(st, input({ cursor: onB, now: ZMEU_MIGRATE_COOLDOWN_MS - 1 })).kind).toBe('none');
    expect(stepZmeuHome(st, input({ cursor: onB, now: ZMEU_MIGRATE_COOLDOWN_MS })).kind).toBe('migrate');
    // settled on B at 21 s: back to A only 20 s later, even with a long dwell
    settleZmeuHandoff(st, 21_000);
    expect(st.home).toBe(2);
    stepZmeuHome(st, input({ cursor: onA, now: 21_000 }));
    expect(stepZmeuHome(st, input({ cursor: onA, now: 40_999 })).kind).toBe('none');
    expect(stepZmeuHome(st, input({ cursor: onA, now: 41_000 }))).toMatchObject({ kind: 'migrate', from: 2, to: 1 });
  });

  it('never migrates while a handoff is pending', () => {
    const st = activeOnA();
    stepZmeuHome(st, input({ cursor: onB, now: 20_000 }));
    expect(stepZmeuHome(st, input({ cursor: onB, now: 28_000 })).kind).toBe('migrate');
    const seq = st.seq;
    expect(stepZmeuHome(st, input({ cursor: onA, now: 60_000 })).kind).toBe('none');
    expect(stepZmeuHome(st, input({ cursor: onA, now: 90_000 })).kind).toBe('none');
    expect(stepZmeuHome(st, input({ cursor: onB, now: 90_000, force: 'call' })).kind).toBe('none');
    expect(st.seq).toBe(seq);
  });

  it('hides once when inactive, and never migrates while inactive', () => {
    const st = activeOnA();
    expect(stepZmeuHome(st, input({ active: false, now: 10 }))).toEqual({ kind: 'hide', from: 1 });
    expect(st).toMatchObject({ home: null, wasActive: false, pending: null, seq: 2 });
    expect(stepZmeuHome(st, input({ active: false, cursor: onB, now: 30_000 }))).toEqual({ kind: 'none' });
    expect(stepZmeuHome(st, input({ active: false, cursor: onB, now: 60_000 }))).toEqual({ kind: 'none' });
    expect(st.seq).toBe(2);
    // back on: hello again
    expect(stepZmeuHome(st, input({ cursor: onB, now: 61_000 }))).toEqual({ kind: 'show', to: 2, via: 'hello' });
  });

  it('cancels a pending handoff when deactivated', () => {
    const st = activeOnA();
    stepZmeuHome(st, input({ cursor: onB, now: 20_000 }));
    stepZmeuHome(st, input({ cursor: onB, now: 28_000 }));
    expect(stepZmeuHome(st, input({ active: false, now: 28_500 }))).toEqual({ kind: 'hide', from: 1 });
    expect(st.pending).toBeNull();
  });

  it('moves via puff after the home is suppressed for 3 s', () => {
    const st = activeOnA();
    const game = new Set([1]);
    expect(stepZmeuHome(st, input({ suppressed: game, now: 1_000 })).kind).toBe('none');
    expect(st.suppressedSince).toBe(1_000);
    expect(stepZmeuHome(st, input({ suppressed: game, now: 1_000 + ZMEU_SUPPRESS_MOVE_MS - 1 })).kind).toBe('none');
    expect(stepZmeuHome(st, input({ suppressed: game, now: 1_000 + ZMEU_SUPPRESS_MOVE_MS }))).toEqual({ kind: 'show', to: 2, via: 'puff' });
    expect(st.home).toBe(2);
  });

  it('stays put when suppression ends early or nowhere else is eligible', () => {
    const st = activeOnA();
    stepZmeuHome(st, input({ suppressed: new Set([1]), now: 1_000 }));
    stepZmeuHome(st, input({ now: 2_000 }));
    expect(st.suppressedSince).toBe(-1);
    expect(stepZmeuHome(st, input({ suppressed: new Set([1]), now: 4_500 })).kind).toBe('none');
    expect(stepZmeuHome(st, input({ suppressed: new Set([1, 2]), now: 9_000 })).kind).toBe('none');
    expect(st.home).toBe(1);
    // single display, suppressed: the dragon waits there
    const solo = createZmeuHomeState();
    stepZmeuHome(solo, input({ displays: [A] }));
    expect(stepZmeuHome(solo, input({ displays: [A], suppressed: new Set([1]), now: 10_000 })).kind).toBe('none');
    expect(stepZmeuHome(solo, input({ displays: [A], suppressed: new Set([1]), now: 20_000 })).kind).toBe('none');
  });

  it('re-homes via puff when the home display is removed', () => {
    const st = activeOnA();
    expect(stepZmeuHome(st, input({ displays: [B], cursor: { x: 10, y: 10 }, now: 5_000 }))).toEqual({ kind: 'show', to: 2, via: 'puff' });
    expect(st.home).toBe(2);
    expect(st.lastMoveAt).toBe(5_000);
  });

  it('re-homes via puff when a handoff target disappears', () => {
    const st = activeOnA();
    stepZmeuHome(st, input({ cursor: onB, now: 20_000 }));
    stepZmeuHome(st, input({ cursor: onB, now: 28_000 }));
    expect(stepZmeuHome(st, input({ displays: [A], cursor: onB, now: 29_000 }))).toEqual({ kind: 'show', to: 1, via: 'puff' });
    expect(st.pending).toBeNull();
  });

  it("force: 'call' skips the dwell and the cooldown, over the sky", () => {
    const st = activeOnA();
    const a = stepZmeuHome(st, input({ cursor: onB, now: 10, force: 'call' }));
    expect(a).toMatchObject({ kind: 'migrate', from: 1, to: 2, via: 'sky', exit: { edge: 'top' }, enter: { edge: 'top', at: 580 } });
    // with the cursor at home there is nothing to migrate
    const st2 = activeOnA();
    expect(stepZmeuHome(st2, input({ cursor: onA, now: 10, force: 'call' })).kind).toBe('none');
  });

  it("force: 'call' moves off a suppressed home at once", () => {
    const st = activeOnA();
    expect(stepZmeuHome(st, input({ suppressed: new Set([1]), cursor: onB, now: 100, force: 'call' }))).toEqual({
      kind: 'show',
      to: 2,
      via: 'puff',
    });
  });

  it('held (lock screen): no hello, no move, and the dwell restarts afterwards', () => {
    const fresh = createZmeuHomeState();
    expect(stepZmeuHome(fresh, input({ held: true }))).toEqual({ kind: 'none' });
    expect(fresh.wasActive).toBe(false);
    expect(stepZmeuHome(fresh, input({ now: 5 }))).toMatchObject({ kind: 'show', via: 'hello' });

    const st = activeOnA();
    const seq = st.seq;
    stepZmeuHome(st, input({ cursor: onB, now: 30_000 }));
    // locked across the dwell end, and with the home removed: frozen, not a single frame
    expect(stepZmeuHome(st, input({ cursor: onB, now: 31_000, held: true }))).toEqual({ kind: 'none' });
    expect(stepZmeuHome(st, input({ cursor: onB, now: 40_000, held: true }))).toEqual({ kind: 'none' });
    expect(stepZmeuHome(st, input({ displays: [B], cursor: onB, now: 41_000, held: true }))).toEqual({ kind: 'none' });
    expect(st).toMatchObject({ home: 1, seq, wasActive: true, candidate: null });
    expect(nextZmeuHomeDeadline(st, 41_000)).toBeNull();
    // unlocked: the cursor has to rest a full dwell again
    expect(stepZmeuHome(st, input({ cursor: onB, now: 50_000 })).kind).toBe('none');
    expect(stepZmeuHome(st, input({ cursor: onB, now: 50_000 + ZMEU_MIGRATE_DWELL_MS - 1 })).kind).toBe('none');
    expect(stepZmeuHome(st, input({ cursor: onB, now: 50_000 + ZMEU_MIGRATE_DWELL_MS })).kind).toBe('migrate');
    // switching Zmeul off still hides while held
    expect(stepZmeuHome(st, input({ active: false, held: true, now: 60_000 }))).toEqual({ kind: 'hide', from: 1 });
  });

  it('increments seq exactly once per action', () => {
    const st = createZmeuHomeState();
    const kinds: string[] = [];
    const seqs: number[] = [];
    const run = (patch: Partial<ZmeuHomeInput>): void => {
      const before = st.seq;
      const a = stepZmeuHome(st, input(patch));
      expect(st.seq - before).toBe(a.kind === 'none' ? 0 : 1);
      if (a.kind !== 'none') {
        kinds.push(a.kind);
        seqs.push(st.seq);
      }
    };
    run({ now: 0 }); // hello
    for (let t = 1_000; t <= 40_000; t += 1_000) run({ cursor: onB, now: t }); // migrate at 20 s
    settleZmeuHandoff(st, 41_000);
    run({ suppressed: new Set([2]), now: 42_000 });
    run({ suppressed: new Set([2]), now: 45_000 }); // puff back to A
    run({ active: false, now: 46_000 }); // hide
    run({ active: false, now: 47_000 });
    expect(kinds).toEqual(['show', 'migrate', 'show', 'hide']);
    expect(seqs).toEqual([1, 2, 3, 4]);
  });
});

describe('settleZmeuHandoff / nextZmeuHomeDeadline', () => {
  it('settles the pending handoff onto the target', () => {
    const st = activeOnA();
    expect(settleZmeuHandoff(st, 1)).toBeNull();
    stepZmeuHome(st, input({ cursor: onB, now: 20_000 }));
    expect(nextZmeuHomeDeadline(st, 20_000)).toBe(28_000);
    stepZmeuHome(st, input({ cursor: onB, now: 28_000 }));
    expect(nextZmeuHomeDeadline(st, 28_000)).toBe(28_000 + ZMEU_EXIT_TIMEOUT_MS);
    // the exit timeout stays a deadline even once it is overdue (the caller settles it)
    expect(nextZmeuHomeDeadline(st, 40_000)).toBe(28_000 + ZMEU_EXIT_TIMEOUT_MS);
    const seq = st.seq;
    expect(settleZmeuHandoff(st, 29_000)).toMatchObject({ to: 2, via: 'edge', edge: 'left' });
    expect(st).toMatchObject({ home: 2, pending: null, lastMoveAt: 29_000, seq });
    expect(nextZmeuHomeDeadline(st, 29_000)).toBeNull();
  });

  it('reports the dwell end, held back by the cooldown', () => {
    const st = activeOnA(); // moved at 0
    stepZmeuHome(st, input({ cursor: onB, now: 1_000 }));
    expect(nextZmeuHomeDeadline(st, 1_000)).toBe(ZMEU_MIGRATE_COOLDOWN_MS);
    stepZmeuHome(st, input({ suppressed: new Set([1]), now: 2_000 }));
    expect(nextZmeuHomeDeadline(st, 2_000)).toBe(2_000 + ZMEU_SUPPRESS_MOVE_MS);
    expect(nextZmeuHomeDeadline(createZmeuHomeState(), 0)).toBeNull();
  });

  it('drops a suppression deadline that passed with nowhere to go (no timer spin)', () => {
    const st = createZmeuHomeState();
    const solo = { displays: [A], suppressed: new Set([1]) };
    stepZmeuHome(st, input({ displays: [A] }));
    stepZmeuHome(st, input({ ...solo, now: 1_000 }));
    expect(nextZmeuHomeDeadline(st, 1_000)).toBe(1_000 + ZMEU_SUPPRESS_MOVE_MS);
    // the move is due but there is no other display: nothing to wake up for
    expect(stepZmeuHome(st, input({ ...solo, now: 1_000 + ZMEU_SUPPRESS_MOVE_MS })).kind).toBe('none');
    expect(nextZmeuHomeDeadline(st, 1_000 + ZMEU_SUPPRESS_MOVE_MS)).toBeNull();
    // a second display appears (that syncs): the move happens at once
    expect(stepZmeuHome(st, input({ suppressed: new Set([1]), now: 9_000 }))).toEqual({ kind: 'show', to: 2, via: 'puff' });
  });
});

describe('sanitizers', () => {
  it('accepts well-formed frames and exit reports', () => {
    expect(sanitizeZmeuHomeFrame({ seq: 3, home: true, via: 'edge', edge: 'left', at: 120.5, extra: 1 })).toEqual({
      seq: 3,
      home: true,
      via: 'edge',
      edge: 'left',
      at: 120.5,
    });
    expect(sanitizeZmeuHomeFrame({ seq: 0, home: false, via: null, edge: null, at: 0 })).toEqual({ seq: 0, home: false, via: null, edge: null, at: 0 });
    expect(sanitizeZmeuExit({ seq: 7, junk: 'x' })).toEqual({ seq: 7 });
  });

  it('rejects NaN, strings, unknown edges / vias and non-integer seq', () => {
    const ok = { seq: 1, home: true, via: 'sky', edge: 'top', at: 10 };
    for (const bad of [
      null,
      undefined,
      'frame',
      42,
      { ...ok, seq: 1.5 },
      { ...ok, seq: -1 },
      { ...ok, seq: '1' },
      { ...ok, seq: Number.NaN },
      { ...ok, home: 'yes' },
      { ...ok, via: 'portal' },
      { ...ok, via: undefined },
      { ...ok, edge: 'middle' },
      { ...ok, edge: 3 },
      { ...ok, at: Number.NaN },
      { ...ok, at: Number.POSITIVE_INFINITY },
      { ...ok, at: '10' },
    ]) {
      expect(sanitizeZmeuHomeFrame(bad)).toBeNull();
    }
    for (const bad of [null, 'x', {}, { seq: 2.5 }, { seq: '2' }, { seq: Number.NaN }, { seq: -3 }]) {
      expect(sanitizeZmeuExit(bad)).toBeNull();
    }
  });
});

// The main-side wrapper (src/main/zmeu-director.ts) on top of the pure logic above:
// what a reloaded page hears, and the allocation-free cursor path.
describe('ZmeuDirector frames and cursor path', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function setup() {
    const list = [A, B].map((d) => ({ id: d.id, info: { id: d.id, bounds: d.bounds } }) as unknown as Overlay);
    const sent: Array<{ to: number; channel: string; payload: unknown }> = [];
    let listCalls = 0;
    const overlays: ZmeuOverlays = {
      list: () => {
        listCalls++;
        return list;
      },
      sendTo: <T>(overlay: Overlay, channel: string, payload: T) => {
        sent.push({ to: overlay.id, channel, payload });
      },
    };
    const env = { cursor: onA as { x: number; y: number } | null };
    const director = new ZmeuDirector({
      overlays,
      active: () => true,
      suppressed: () => none,
      readCursor: () => env.cursor,
      primaryId: () => 1,
      now: () => Date.now(),
    });
    const overlay = (id: number): Overlay => list.find((o) => o.id === id)!;
    const homes = (): ZmeuHomeFrame[] => sent.filter((s) => s.channel === IPC.zmeuHome).map((s) => s.payload as ZmeuHomeFrame);
    return { director, env, overlay, homes, listCalls: () => listCalls };
  }

  it('replays the hello to a page loading right after it, and puffs in a page reloaded later', () => {
    const { director, overlay } = setup();
    director.sync('start');
    // startup: the page is still loading when hello is decided
    vi.advanceTimersByTime(ZMEU_ARRIVAL_REPLAY_MS - 1);
    expect(director.frameFor(overlay(1))).toEqual({ seq: 1, home: true, via: 'hello', edge: null, at: 0 });
    // crash reload / overlay rebuild an hour later: no second hello (and roar)
    vi.advanceTimersByTime(3_600_000);
    expect(director.frameFor(overlay(1))).toEqual({ seq: 1, home: true, via: 'puff', edge: null, at: 0 });
    expect(director.frameFor(overlay(2))).toEqual({ seq: 1, home: false, via: null, edge: null, at: 0 });
  });

  it('a reloaded old home still hears its exit, and the new home only replays the edge entry while fresh', () => {
    const { director, env, overlay } = setup();
    director.sync('start');
    vi.advanceTimersByTime(30_000);
    env.cursor = onB;
    director.noteCursor(onB);
    vi.advanceTimersByTime(ZMEU_MIGRATE_DWELL_MS + 5);
    vi.advanceTimersByTime(ZMEU_EXIT_TIMEOUT_MS - 100);
    // still pending: a fresh page of the old home answers the exit at once (no puff there)
    expect(director.frameFor(overlay(1))).toEqual({ seq: 2, home: false, via: 'edge', edge: 'right', at: 300 });
    director.onExited(overlay(1), { seq: 2 });
    expect(director.frameFor(overlay(2))).toEqual({ seq: 2, home: true, via: 'edge', edge: 'left', at: 300 });
    vi.advanceTimersByTime(ZMEU_ARRIVAL_REPLAY_MS);
    expect(director.frameFor(overlay(2))).toEqual({ seq: 2, home: true, via: 'puff', edge: null, at: 0 });
  });

  it('cursor moves within one display touch neither the overlay list nor IPC, and crossings still migrate', () => {
    const { director, env, homes, listCalls } = setup();
    director.sync('start');
    vi.advanceTimersByTime(30_000);
    const calls = listCalls();
    const frames = homes().length;
    for (let i = 0; i < 500; i++) director.noteCursor({ x: 100 + i, y: 300 + (i % 50) });
    expect(listCalls()).toBe(calls);
    expect(homes()).toHaveLength(frames);
    env.cursor = onB;
    director.noteCursor(onB);
    for (let i = 0; i < 500; i++) director.noteCursor({ x: 2000 + i, y: 300 });
    vi.advanceTimersByTime(ZMEU_MIGRATE_DWELL_MS + 5);
    expect(homes().at(-1)).toEqual({ seq: 2, home: false, via: 'edge', edge: 'right', at: 300 });
  });
});
