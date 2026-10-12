import { describe, expect, it } from 'vitest';

import type { ZmeuBodyShape } from '../src/renderer/zmeu/core/gestures';
import { CursorRing, classifyClick, closingSpeed, hitsBody, isPetting, isResting } from '../src/renderer/zmeu/core/gestures';
import { classifyWindowChange } from '../src/renderer/zmeu/core/perches';
import { ZMEU_JOINTS, ZMEU_TUNING } from '../src/renderer/zmeu/core/tuning';

const L = 270;
const S = 1080;
const N = ZMEU_JOINTS;
const SEG = (ZMEU_TUNING.bodyFrac * L) / (N - 1);

function body(): ZmeuBodyShape {
  const bodyX = new Float32Array(N);
  const bodyY = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    bodyX[i] = 1000 - i * SEG;
    bodyY[i] = 500;
  }
  return { bodyX, bodyY, R: ZMEU_TUNING.radiusFrac * L, L, dirX: 1, dirY: 0 };
}

describe('gestures', () => {
  const b = body();
  const mid = { x: b.bodyX[10]!, y: 500 };

  it('detects petting from a wiggle over the body within 0.6 s', () => {
    const ring = new CursorRing();
    let found = -1;
    for (let k = 0; k <= 120; k++) {
      const t = k / 120;
      ring.push(mid.x + 0.08 * L * Math.sin(2 * Math.PI * 4 * t), mid.y, t);
      if (found < 0 && isPetting(ring, t, b)) found = t;
    }
    expect(found).toBeGreaterThan(0);
    expect(found).toBeLessThanOrEqual(0.6);
  });

  it('detects a slow, gentle wiggle (3 reversals within 1.2 s) from 120 Hz samples', () => {
    for (const hz of [1.3, 2]) {
      const ring = new CursorRing();
      let found = -1;
      for (let k = 0; k <= 360; k++) {
        const t = k / 120;
        ring.push(mid.x + 0.08 * L * Math.sin(2 * Math.PI * hz * t), mid.y, t);
        if (found < 0 && isPetting(ring, t, b)) found = t;
      }
      expect(found).toBeGreaterThan(0);
      expect(found).toBeLessThanOrEqual(1.2);
    }
    // The ring keeps 1.2 s of history at that rate.
    const ring = new CursorRing();
    for (let k = 0; k <= 240; k++) ring.push(k, 0, k / 120);
    expect(ring.latestT() - ring.t[ring.slot(ring.count - 1)]!).toBeGreaterThanOrEqual(1.1);
  });

  it('does not pet on a straight pass or a resting pointer', () => {
    const ring = new CursorRing();
    for (let k = 0; k <= 120; k++) {
      const t = k / 120;
      ring.push(mid.x - 200 + 400 * t, mid.y + 3, t);
      expect(isPetting(ring, t, b)).toBe(false);
    }
    const rest = new CursorRing();
    rest.push(mid.x, mid.y, 0);
    for (let t = 0; t <= 2; t += 0.05) expect(isPetting(rest, t, b)).toBe(false);
  });

  it('reports a resting pointer after 0.6 s', () => {
    const ring = new CursorRing();
    for (let k = 0; k < 10; k++) ring.push(100 + k * 30, 100, k / 60);
    const t0 = 9 / 60;
    ring.push(400, 100, t0 + 0.01);
    expect(isResting(ring, t0 + 0.3)).toBe(false);
    expect(isResting(ring, t0 + 0.62)).toBe(true);
    // Tiny jitter still counts as resting.
    ring.push(401, 101, t0 + 0.7);
    expect(isResting(ring, t0 + 0.75)).toBe(true);
    expect(hitsBody(b, mid.x, mid.y + 5, 8)).toBe(true);
    expect(hitsBody(b, mid.x, mid.y + 60, 8)).toBe(false);
  });

  it('measures the closing speed of a rush', () => {
    const hx = 1000;
    const hy = 500;
    expect(closingSpeed(hx, hy, hx - 0.2 * S, hy, 900, 0)).toBeCloseTo(900, 6);
    expect(closingSpeed(hx, hy, hx - 0.2 * S, hy, 900, 0)).toBeGreaterThan(ZMEU_TUNING.panicSpeed);
    expect(closingSpeed(hx, hy, hx - 0.2 * S, hy, -900, 0)).toBeLessThan(0);
    expect(Math.abs(closingSpeed(hx, hy, hx - 0.2 * S, hy, 0, 900))).toBeLessThan(1e-6);
  });

  it('classifies clicks', () => {
    expect(classifyClick(true, -3, 0, L)).toBe('poke');
    expect(classifyClick(false, 0.4 * L, 2, L)).toBe('notice');
    expect(classifyClick(true, -3, 40, L)).toBe('drag');
    expect(classifyClick(false, 2 * L, 0, L)).toBe('none');
  });
});

describe('classifyWindowChange', () => {
  const a = { x: 100, y: 200, width: 800, height: 600 };
  it('separates same, moved and new', () => {
    expect(classifyWindowChange(a, { ...a }, 7, 7, S)).toBe('same');
    expect(classifyWindowChange(a, { ...a }, 7, 9, S)).toBe('new');
    expect(classifyWindowChange(a, { ...a, x: 300 }, 7, 7, S)).toBe('new');
    expect(classifyWindowChange(a, { ...a, x: 120 }, 7, 7, S)).toBe('moved');
    expect(classifyWindowChange(null, a, 0, 7, S)).toBe('new');
    expect(classifyWindowChange(a, null, 7, 0, S)).toBe('moved');
    expect(classifyWindowChange(null, null, 0, 0, S)).toBe('same');
  });
});
