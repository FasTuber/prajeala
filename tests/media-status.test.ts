import { describe, expect, it } from 'vitest';

import { AUDIO_FRAME_HZ, SILENT_FRAME, sanitizeAudioFrame, type AudioFrame } from '../src/shared/audio-contract';
import {
  CaptureStatusTracker,
  FrameThrottle,
  PendingOnsets,
  SILENCE_REPORT_MS,
  TickGrid,
  clampSensitivity,
  statusForCaptureError,
  statusForEndedTrack,
} from '../src/shared/media-status';

const domError = (name: string, message = `${name} happened`) => Object.assign(new Error(message), { name });

describe('statusForCaptureError', () => {
  it('maps permission refusals to denied', () => {
    expect(statusForCaptureError(domError('NotAllowedError', 'Permission denied'))).toEqual({
      status: 'denied',
      detail: 'Permission denied',
    });
    expect(statusForCaptureError(domError('SecurityError')).status).toBe('denied');
  });

  it('maps missing / unusable devices to unsupported', () => {
    for (const name of ['NotFoundError', 'NotSupportedError', 'NotReadableError', 'OverconstrainedError']) {
      expect(statusForCaptureError(domError(name)).status).toBe('unsupported');
    }
  });

  it('maps everything else to error with the message as detail', () => {
    expect(statusForCaptureError(domError('AbortError', 'boom'))).toEqual({ status: 'error', detail: 'boom' });
    expect(statusForCaptureError(new TypeError('bad constraints'))).toEqual({ status: 'error', detail: 'bad constraints' });
    expect(statusForCaptureError('weird')).toEqual({ status: 'error', detail: 'weird' });
    expect(statusForCaptureError(null)).toEqual({ status: 'error', detail: 'unknown error' });
  });

  it('falls back to the error name when the message is empty', () => {
    expect(statusForCaptureError(domError('NotAllowedError', ''))).toEqual({ status: 'denied', detail: 'NotAllowedError' });
  });
});

describe('statusForEndedTrack', () => {
  it('treats macOS track ends and stopped system sharing as revoked access', () => {
    expect(statusForEndedTrack('mic', true).status).toBe('denied');
    expect(statusForEndedTrack('system', true).status).toBe('denied');
    expect(statusForEndedTrack('system', false).status).toBe('denied');
  });

  it('treats a vanished microphone elsewhere as an error', () => {
    expect(statusForEndedTrack('mic', false).status).toBe('error');
  });
});

describe('CaptureStatusTracker', () => {
  it('goes starting → ok on the first frame, silent or not', () => {
    const a = new CaptureStatusTracker();
    expect(a.status).toBe('starting');
    expect(a.frame(false, 0)).toBe('ok');
    expect(a.frame(false, 16)).toBeNull();

    const b = new CaptureStatusTracker();
    expect(b.frame(true, 0)).toBe('ok');
  });

  it('reports silent once after continuous silence, and ok when sound returns', () => {
    const t = new CaptureStatusTracker();
    t.frame(false, 0);
    const reports: string[] = [];
    for (let ms = 100; ms <= 100 + SILENCE_REPORT_MS + 2000; ms += 16) {
      const r = t.frame(true, ms);
      if (r) reports.push(r);
    }
    expect(reports).toEqual(['silent']);
    expect(t.frame(false, 20_000)).toBe('ok');
    expect(t.frame(true, 20_016)).toBeNull();
  });

  it('restarts the silence clock on any sound', () => {
    const t = new CaptureStatusTracker(1000);
    t.frame(false, 0);
    expect(t.frame(true, 100)).toBeNull();
    expect(t.frame(true, 1000)).toBeNull();
    expect(t.frame(false, 1050)).toBeNull();
    expect(t.frame(true, 1100)).toBeNull();
    expect(t.frame(true, 2050)).toBeNull();
    expect(t.frame(true, 2100)).toBe('silent');
  });

  it('reset() returns to starting', () => {
    const t = new CaptureStatusTracker();
    t.frame(false, 0);
    t.reset();
    expect(t.status).toBe('starting');
    expect(t.frame(false, 1)).toBe('ok');
  });
});

describe('FrameThrottle', () => {
  const countAccepted = (throttle: FrameThrottle, times: number[]) => times.filter((t) => throttle.accept(t)).length;

  it('passes a jittery stream at the nominal rate without dropping frames', () => {
    const throttle = new FrameThrottle(AUDIO_FRAME_HZ);
    const interval = 1000 / AUDIO_FRAME_HZ;
    const times: number[] = [];
    for (let i = 0; i < 600; i++) times.push(i * interval + (i % 2 === 0 ? 2 : -2));
    expect(countAccepted(throttle, times)).toBe(600);
  });

  it('never exceeds the rate when frames arrive too fast', () => {
    const throttle = new FrameThrottle(60);
    const times: number[] = [];
    for (let t = 0; t < 10_000; t += 4) times.push(t); // 250 Hz for 10 s
    const accepted = countAccepted(throttle, times);
    expect(accepted).toBeLessThanOrEqual(601);
    expect(accepted).toBeGreaterThanOrEqual(590);
  });

  it('does not burst after a gap', () => {
    const throttle = new FrameThrottle(60);
    expect(throttle.accept(0)).toBe(true);
    expect(throttle.accept(1000)).toBe(true);
    expect(throttle.accept(1001)).toBe(false);
    expect(throttle.accept(1005)).toBe(false);
    expect(throttle.accept(1017)).toBe(true);
  });

  it('reset() accepts the next frame immediately', () => {
    const throttle = new FrameThrottle(60);
    expect(throttle.accept(0)).toBe(true);
    expect(throttle.accept(1)).toBe(false);
    throttle.reset();
    expect(throttle.accept(2)).toBe(true);
  });
});

describe('TickGrid', () => {
  /** Simulates setTimeout, which truncates the delay to whole ms (16.67 → 16). */
  const run = (grid: TickGrid, durationMs: number, lateBy: (i: number) => number = () => 0): number[] => {
    const ticks: number[] = [];
    let now = 0;
    for (let i = 0; now < durationMs; i++) {
      now += Math.trunc(grid.next(now)) + lateBy(i);
      ticks.push(now);
    }
    return ticks;
  };

  it('averages exactly AUDIO_FRAME_HZ despite whole-ms timers', () => {
    const ticks = run(new TickGrid(AUDIO_FRAME_HZ), 10_000);
    expect(ticks.length).toBeGreaterThanOrEqual(AUDIO_FRAME_HZ * 10 - 1);
    expect(ticks.length).toBeLessThanOrEqual(AUDIO_FRAME_HZ * 10 + 1);
  });

  it('restarts the grid after a stall instead of bursting', () => {
    const grid = new TickGrid(60);
    grid.next(0);
    expect(grid.next(500)).toBeCloseTo(1000 / 60, 5);
  });

  it('catches up a slightly late tick without dropping it', () => {
    const grid = new TickGrid(60);
    grid.next(0); // due 16.67
    expect(grid.next(20)).toBeCloseTo(2000 / 60 - 20, 5);
  });

  it('feeds the relay throttle without any dropped frame', () => {
    const throttle = new FrameThrottle(AUDIO_FRAME_HZ);
    const ticks = run(new TickGrid(AUDIO_FRAME_HZ), 10_000, (i) => (i % 7 === 0 ? 3 : 0));
    expect(ticks.filter((t) => throttle.accept(t)).length).toBe(ticks.length);
  });
});

describe('PendingOnsets', () => {
  const frame = (over: Partial<AudioFrame>): AudioFrame => sanitizeAudioFrame({ ...SILENT_FRAME, ...over })!;

  it('carries the strongest onsets of dropped frames into the next relayed one', () => {
    const p = new PendingOnsets();
    p.hold(frame({ kick: 0.4 }));
    p.hold(frame({ kick: 0.9, snare: 0.2, drop: true }));
    const out = p.release(frame({ kick: 0.5 }));
    expect(out).toMatchObject({ kick: 0.9, snare: 0.2, drop: true });
    // Cleared after release.
    expect(p.release(frame({}))).toMatchObject({ kick: 0, snare: 0, drop: false });
  });

  it('ignores junk from the untrusted page', () => {
    const p = new PendingOnsets();
    p.hold(null);
    p.hold({ kick: Number.NaN, snare: Infinity, drop: 'yes' });
    p.hold({ kick: 7 });
    expect(p.release(frame({}))).toMatchObject({ kick: 1, snare: 0, drop: false });
  });

  it('keeps every kick of a too-fast stream once throttled to 60 Hz', () => {
    const throttle = new FrameThrottle(60);
    const p = new PendingOnsets();
    let kicks = 0;
    for (let i = 0; i < 1000; i++) {
      const raw = frame({ kick: i % 25 === 0 ? 1 : 0 }); // 250 Hz source, a kick every 100 ms
      if (throttle.accept(i * 4)) kicks += p.release(sanitizeAudioFrame(raw)!).kick === 1 ? 1 : 0;
      else p.hold(raw);
    }
    expect(kicks).toBe(40);
  });
});

describe('clampSensitivity', () => {
  it('clamps to 0..1 and defaults junk to 0.5', () => {
    expect(clampSensitivity(-1)).toBe(0);
    expect(clampSensitivity(2)).toBe(1);
    expect(clampSensitivity(0.3)).toBe(0.3);
    expect(clampSensitivity(Number.NaN)).toBe(0.5);
    expect(clampSensitivity('1')).toBe(0.5);
  });
});
