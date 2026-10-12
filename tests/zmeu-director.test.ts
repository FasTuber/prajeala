import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { IPC, type DisplayInfo } from '../src/shared/ipc';
import { ZMEU_EXIT_TIMEOUT_MS, ZMEU_MIGRATE_DWELL_MS, type ZmeuHomeFrame } from '../src/shared/zmeu';
import type { Overlay } from '../src/main/overlay-manager';
import { ZmeuDirector, type ZmeuOverlays } from '../src/main/zmeu-director';

vi.mock('../src/main/log', () => {
  const quiet = (): undefined => undefined;
  return { createLogger: () => ({ debug: quiet, info: quiet, warn: quiet, error: quiet, at: quiet }) };
});

interface Sent {
  to: number;
  channel: string;
  payload: unknown;
}

function display(id: number, x: number, index: number): DisplayInfo {
  const bounds = { x, y: 0, width: 1920, height: 1080 };
  return { id, bounds, workArea: bounds, scaleFactor: 1, isPrimary: index === 0, index, total: 2 };
}

function setup(opts: { displays?: DisplayInfo[] } = {}) {
  const infos = opts.displays ?? [display(1, 0, 0), display(2, 1920, 1)];
  const list = infos.map((info) => ({ id: info.id, info }) as unknown as Overlay);
  const sent: Sent[] = [];
  const overlays: ZmeuOverlays = {
    list: () => list,
    sendTo: <T>(overlay: Overlay, channel: string, payload: T) => {
      sent.push({ to: overlay.id, channel, payload });
    },
  };
  const env = { active: true, held: false, suppressed: new Set<number>(), cursor: { x: 500, y: 400 } as { x: number; y: number } | null };
  const director = new ZmeuDirector({
    overlays,
    active: () => env.active,
    held: () => env.held,
    suppressed: () => env.suppressed,
    readCursor: () => env.cursor,
    primaryId: () => 1,
    now: () => Date.now(),
  });
  const homes = (): Array<{ to: number } & ZmeuHomeFrame> =>
    sent.filter((s) => s.channel === IPC.zmeuHome).map((s) => ({ to: s.to, ...(s.payload as ZmeuHomeFrame) }));
  const calls = (): Sent[] => sent.filter((s) => s.channel === IPC.zmeuCall);
  const overlay = (id: number): Overlay => list.find((o) => o.id === id)!;
  return { director, env, sent, homes, calls, overlay };
}

describe('ZmeuDirector', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('says hello on the cursor display and tells every overlay', () => {
    const { director, homes, overlay } = setup();
    director.sync('test');
    expect(homes()).toEqual([
      { to: 1, seq: 1, home: true, via: 'hello', edge: null, at: 0 },
      { to: 2, seq: 1, home: false, via: null, edge: null, at: 0 },
    ]);
    expect(director.frameFor(overlay(1))).toEqual({ seq: 1, home: true, via: 'hello', edge: null, at: 0 });
    // nothing changed: no new frames
    director.sync('again');
    expect(homes()).toHaveLength(2);
  });

  it('hands off in two phases: exit to the old home, then enter on the new one', () => {
    const { director, env, homes, overlay } = setup();
    director.sync('start');
    vi.advanceTimersByTime(30_000);
    env.cursor = { x: 2500, y: 300 };
    director.noteCursor(env.cursor);
    expect(homes()).toHaveLength(2);
    vi.advanceTimersByTime(ZMEU_MIGRATE_DWELL_MS + 5);
    // phase one: only the old home hears about it
    expect(homes().slice(2)).toEqual([{ to: 1, seq: 2, home: false, via: 'edge', edge: 'right', at: 300 }]);
    expect(director.frameFor(overlay(2))).toMatchObject({ home: false, via: null });
    // a stale or foreign exit report is ignored
    director.onExited(overlay(1), { seq: 1 });
    director.onExited(overlay(2), { seq: 2 });
    expect(homes()).toHaveLength(3);
    // phase two
    director.onExited(overlay(1), { seq: 2 });
    expect(homes().slice(3)).toEqual([{ to: 2, seq: 2, home: true, via: 'edge', edge: 'left', at: 300 }]);
    expect(director.frameFor(overlay(2))).toEqual({ seq: 2, home: true, via: 'edge', edge: 'left', at: 300 });
    expect(director.frameFor(overlay(1))).toEqual({ seq: 2, home: false, via: null, edge: null, at: 0 });
    // the exit timeout no longer fires a second arrival
    vi.advanceTimersByTime(ZMEU_EXIT_TIMEOUT_MS * 2);
    expect(homes()).toHaveLength(4);
  });

  it('enters the new display after the exit timeout when no report comes', () => {
    const { director, env, homes } = setup();
    director.sync('start');
    vi.advanceTimersByTime(30_000);
    env.cursor = { x: 2500, y: 300 };
    director.noteCursor(env.cursor);
    vi.advanceTimersByTime(ZMEU_MIGRATE_DWELL_MS + 5);
    expect(homes()).toHaveLength(3);
    vi.advanceTimersByTime(ZMEU_EXIT_TIMEOUT_MS - 10);
    expect(homes()).toHaveLength(3);
    vi.advanceTimersByTime(20);
    expect(homes()[3]).toMatchObject({ to: 2, home: true, via: 'edge' });
  });

  it('calls the dragon to the cursor on its home display', () => {
    const { director, calls } = setup();
    director.sync('start');
    director.call();
    expect(calls()).toEqual([{ to: 1, channel: IPC.zmeuCall, payload: { x: 500, y: 400 } }]);
  });

  it('calls across displays: a sky handoff first, then the call on arrival', () => {
    const { director, env, homes, calls, overlay } = setup();
    director.sync('start');
    env.cursor = { x: 2500, y: 300 };
    director.call();
    expect(homes()[2]).toMatchObject({ to: 1, home: false, via: 'sky', edge: 'top' });
    expect(calls()).toHaveLength(0);
    director.onExited(overlay(1), { seq: 2 });
    expect(homes()[3]).toMatchObject({ to: 2, home: true, via: 'sky', edge: 'top', at: 580 });
    expect(calls()).toEqual([{ to: 2, channel: IPC.zmeuCall, payload: { x: 580, y: 300 } }]);
  });

  it('does nothing while inactive, and hides everywhere when switched off', () => {
    const { director, env, homes, calls } = setup();
    env.active = false;
    director.sync('start');
    director.call();
    expect(homes()).toHaveLength(0);
    expect(calls()).toHaveLength(0);
    env.active = true;
    director.sync('on');
    env.active = false;
    director.sync('off');
    expect(homes().slice(2)).toEqual([
      { to: 1, seq: 2, home: false, via: null, edge: null, at: 0 },
      { to: 2, seq: 2, home: false, via: null, edge: null, at: 0 },
    ]);
  });

  it('moves off a display suppressed by game mode after 3 s', () => {
    const { director, env, homes } = setup();
    director.sync('start');
    env.suppressed = new Set([1]);
    director.sync('game mode');
    expect(homes()).toHaveLength(2);
    vi.advanceTimersByTime(3_010);
    expect(homes().slice(2)).toEqual([
      { to: 1, seq: 2, home: false, via: null, edge: null, at: 0 },
      { to: 2, seq: 2, home: true, via: 'puff', edge: null, at: 0 },
    ]);
  });

  it('waits on a suppressed single display without spinning a timer', () => {
    const { director, env, homes } = setup({ displays: [display(1, 0, 0)] });
    director.sync('start');
    env.suppressed = new Set([1]);
    director.sync('game mode');
    const spy = vi.spyOn(globalThis, 'setTimeout');
    vi.advanceTimersByTime(60_000);
    // one wake-up at the 3 s mark finds nowhere to go, then nothing until something changes
    expect(spy.mock.calls.length).toBeLessThanOrEqual(1);
    expect(vi.getTimerCount()).toBe(0);
    expect(homes()).toHaveLength(1);
    spy.mockRestore();
  });

  it('moves on again when a handoff lands on a display that got suppressed meanwhile', () => {
    const { director, env, homes, overlay } = setup();
    director.sync('start');
    env.cursor = { x: 2500, y: 300 };
    director.call(); // sky handoff 1 → 2
    env.suppressed = new Set([2]); // a fullscreen app opens on 2 during the flight
    director.sync('game mode');
    director.onExited(overlay(1), { seq: 2 });
    expect(homes()[3]).toMatchObject({ to: 2, home: true, via: 'sky' });
    vi.advanceTimersByTime(3_010);
    expect(homes().slice(4)).toEqual([
      { to: 1, seq: 3, home: true, via: 'puff', edge: null, at: 0 },
      { to: 2, seq: 3, home: false, via: null, edge: null, at: 0 },
    ]);
  });

  it('starts the dwell for a third display the cursor rests on when a handoff lands', () => {
    const three = [display(1, 0, 0), display(2, 1920, 1), display(3, 3840, 2)];
    const { director, env, homes, overlay } = setup({ displays: three });
    director.sync('start');
    vi.advanceTimersByTime(30_000);
    env.cursor = { x: 2500, y: 300 };
    director.noteCursor(env.cursor);
    vi.advanceTimersByTime(ZMEU_MIGRATE_DWELL_MS + 5); // handoff 1 → 2 starts
    env.cursor = { x: 4000, y: 300 };
    director.noteCursor(env.cursor); // crosses to 3 during the flight (ignored while pending)
    director.onExited(overlay(1), { seq: 2 });
    // three hello frames, the exit, then the arrival
    expect(homes()[4]).toMatchObject({ to: 2, home: true });
    // no further cursor crossing: the director still migrates to 3 after cooldown + dwell
    vi.advanceTimersByTime(25_000);
    expect(homes()[5]).toMatchObject({ to: 2, seq: 3, home: false, via: 'edge', edge: 'right' });
  });

  it('freezes on the lock screen: no frames on lock or unlock, calls ignored', () => {
    const { director, env, homes, calls } = setup();
    director.sync('start');
    env.held = true;
    director.sync('power');
    env.cursor = { x: 2500, y: 300 };
    director.noteCursor(env.cursor);
    director.call();
    vi.advanceTimersByTime(60_000);
    env.held = false;
    director.sync('power');
    expect(homes()).toHaveLength(2);
    expect(calls()).toHaveLength(0);
    // a full dwell after unlocking, not at once
    vi.advanceTimersByTime(ZMEU_MIGRATE_DWELL_MS - 10);
    expect(homes()).toHaveLength(2);
    vi.advanceTimersByTime(20);
    expect(homes()[2]).toMatchObject({ to: 1, home: false, via: 'edge' });
  });

  it('never sends a non-finite call position', () => {
    const { director, env, calls } = setup();
    director.sync('start');
    env.cursor = { x: Number.NaN, y: 400 };
    director.call();
    expect(calls()).toEqual([{ to: 1, channel: IPC.zmeuCall, payload: { x: 960, y: 540 } }]);
  });

  it('stops its timers on dispose', () => {
    const { director, env, homes } = setup();
    director.sync('start');
    env.cursor = { x: 2500, y: 300 };
    director.noteCursor(env.cursor);
    director.dispose();
    vi.advanceTimersByTime(60_000);
    expect(homes()).toHaveLength(2);
    expect(vi.getTimerCount()).toBe(0);
  });
});
