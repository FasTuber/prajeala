import { describe, expect, it } from 'vitest';

import {
  FOCUS_BLAZE_MS,
  FOCUS_MAX_MINUTES,
  FocusClock,
  IDLE_FOCUS,
  clampFocusMinutes,
  countdownDigit,
  extrapolate,
  focusHeat,
  formatClock,
  fuseProgress,
  sanitizeFocusFrame,
} from '../src/shared/focus';

describe('focus helpers', () => {
  it('clamps minutes', () => {
    expect(clampFocusMinutes(25)).toBe(25);
    expect(clampFocusMinutes('15')).toBe(15);
    expect(clampFocusMinutes(0)).toBe(1);
    expect(clampFocusMinutes(9999)).toBe(FOCUS_MAX_MINUTES);
    expect(clampFocusMinutes('x', 10)).toBe(10);
    expect(clampFocusMinutes(NaN)).toBe(25);
    expect(clampFocusMinutes('', 40)).toBe(40);
    expect(clampFocusMinutes('  ', 40)).toBe(40);
  });

  it('formats the clock, rounding up', () => {
    expect(formatClock(25 * 60_000)).toBe('25:00');
    expect(formatClock(4 * 60_000 + 4_001)).toBe('4:05');
    expect(formatClock(1)).toBe('0:01');
    expect(formatClock(0)).toBe('0:00');
    expect(formatClock(-5)).toBe('0:00');
    expect(formatClock(3_723_000)).toBe('1:02:03');
  });

  it('burns the fuse from 0 to 1', () => {
    expect(fuseProgress(1000, 1000)).toBe(0);
    expect(fuseProgress(250, 1000)).toBe(0.75);
    expect(fuseProgress(0, 1000)).toBe(1);
    expect(fuseProgress(2000, 1000)).toBe(0);
    expect(fuseProgress(5, 0)).toBe(1);
  });

  it('heats up towards the end, monotonically', () => {
    const d = 25 * 60_000;
    expect(focusHeat(d, d)).toBeCloseTo(0.35);
    let last = 0;
    for (let r = d; r >= 0; r -= 5000) {
      const h = focusHeat(r, d);
      expect(h).toBeGreaterThanOrEqual(last - 1e-9);
      expect(h).toBeLessThanOrEqual(1);
      last = h;
    }
    expect(focusHeat(0, d)).toBeCloseTo(1);
  });

  it('counts the last ten seconds', () => {
    expect(countdownDigit(10_001)).toBeNull();
    expect(countdownDigit(10_000)).toBe(10);
    expect(countdownDigit(9_000.5)).toBe(10);
    expect(countdownDigit(1)).toBe(1);
    expect(countdownDigit(0)).toBeNull();
  });

  it('extrapolates frames', () => {
    const f = { ...IDLE_FOCUS, phase: 'running' as const, durationMs: 10_000, remainingMs: 5000 };
    expect(extrapolate(f, 1000).remainingMs).toBe(4000);
    expect(extrapolate(f, 9000).remainingMs).toBe(0);
    expect(extrapolate({ ...f, phase: 'paused' }, 1000).remainingMs).toBe(5000);
    expect(extrapolate({ ...f, phase: 'blaze', remainingMs: 0, blazeMs: 200 }, 300).blazeMs).toBe(500);
  });

  it('sanitizes frames from IPC', () => {
    expect(sanitizeFocusFrame(null)).toEqual(IDLE_FOCUS);
    expect(sanitizeFocusFrame({ phase: 'evil', id: -3, remainingMs: Infinity, cancelled: 'yes' })).toEqual(IDLE_FOCUS);
    const ok = { phase: 'running', id: 2, durationMs: 60_000, remainingMs: 30_000, blazeMs: 0, cancelled: false, doneText: 'GATA!' };
    expect(sanitizeFocusFrame(ok)).toEqual(ok);
    expect(sanitizeFocusFrame({ ...ok, doneText: 'x'.repeat(50) }).doneText).toHaveLength(12);
  });
});

describe('FocusClock', () => {
  it('runs, finishes, blazes and ends', () => {
    const c = new FocusClock();
    c.start(60_000, 1000);
    expect(c.phase).toBe('running');
    expect(c.id).toBe(1);
    expect(c.remaining(31_000)).toBe(30_000);
    expect(c.tick(60_999)).toBeNull();
    expect(c.tick(61_000)).toBe('finished');
    expect(c.phase).toBe('blaze');
    expect(c.frame(62_000).blazeMs).toBe(1000);
    expect(c.tick(61_000 + FOCUS_BLAZE_MS - 1)).toBeNull();
    expect(c.tick(61_000 + FOCUS_BLAZE_MS)).toBe('ended');
    expect(c.phase).toBe('idle');
    expect(c.frame(70_000).cancelled).toBe(false);
  });

  it('pauses and resumes', () => {
    const c = new FocusClock();
    c.start(10_000, 0);
    expect(c.pause(4000)).toBe(true);
    expect(c.pause(4000)).toBe(false);
    expect(c.remaining(100_000)).toBe(6000);
    expect(c.tick(100_000)).toBeNull();
    expect(c.resume(100_000)).toBe(true);
    expect(c.remaining(103_000)).toBe(3000);
    expect(c.tick(106_000)).toBe('finished');
  });

  it('cancels and marks the fuse as snuffed out', () => {
    const c = new FocusClock();
    expect(c.cancel()).toBe(false);
    c.start(10_000, 0);
    expect(c.cancel()).toBe(true);
    expect(c.phase).toBe('idle');
    expect(c.frame(1).cancelled).toBe(true);
    c.start(10_000, 0);
    expect(c.id).toBe(2);
    expect(c.frame(1).cancelled).toBe(false);
  });

  it('still shows the whole blaze after a late tick', () => {
    const c = new FocusClock();
    c.start(1000, 0);
    expect(c.tick(60_000)).toBe('finished');
    expect(c.frame(60_000).blazeMs).toBe(0);
    expect(c.tick(60_000 + FOCUS_BLAZE_MS - 1)).toBeNull();
  });
});
