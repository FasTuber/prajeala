import { describe, expect, it } from 'vitest';

import { Random } from '../src/renderer/util/math';
import { COIL_BOX, coilPose, hoverPose, perchPose, roarPose } from '../src/renderer/zmeu/core/poses';
import { Spine, radiusAt } from '../src/renderer/zmeu/core/spine';
import { ZMEU_JOINTS } from '../src/renderer/zmeu/core/tuning';

const N = ZMEU_JOINTS;

describe('radiusAt', () => {
  it('peaks at R at u = 0.2 and tapers monotonically to the tail', () => {
    const R = 13.5;
    expect(radiusAt(0.2, R)).toBeCloseTo(R, 9);
    expect(radiusAt(0, R)).toBeCloseTo(0.62 * R, 9);
    expect(radiusAt(1, R)).toBeCloseTo(0.1 * R, 9);
    let last = Infinity;
    for (let u = 0.2; u <= 1 + 1e-9; u += 0.01) {
      const r = radiusAt(u, R);
      expect(r).toBeLessThanOrEqual(last + 1e-12);
      last = r;
    }
    expect(radiusAt(-1, R)).toBeCloseTo(0.62 * R, 9);
    expect(radiusAt(2, R)).toBeCloseTo(0.1 * R, 9);
  });
});

describe('Spine', () => {
  it('keeps segment lengths within 1% and bends within limits over 2000 seeded steps', () => {
    const rng = new Random(42);
    const sp = new Spine();
    const seg = 10;
    sp.reset(500, 500, 1, 0, seg);
    const tx = new Float64Array(N);
    const ty = new Float64Array(N);
    let hx = 500;
    let hy = 500;
    let ang = 0;
    let facing = 1;
    for (let i = 0; i < 2000; i++) {
      const h = i % 97 === 0 ? 0 : rng.range(1 / 240, 1 / 30);
      if (i % 250 === 125) {
        // Teleport.
        hx = rng.range(-200, 2200);
        hy = rng.range(-200, 1300);
      } else {
        ang += rng.range(-1, 1) * 0.6;
        const v = rng.range(0, 900);
        hx += Math.cos(ang) * v * h;
        hy += Math.sin(ang) * v * h;
      }
      if (Math.cos(ang) > 0.25) facing = 1;
      else if (Math.cos(ang) < -0.25) facing = -1;
      sp.follow(hx, hy, seg);
      if (i % 400 > 300) {
        perchPose(tx, ty, 270, hx, hy + 70, facing, 1, i / 120);
        sp.blendToward(tx, ty, 7, 1, h);
        sp.restoreLengths(2);
      }
      sp.bendLimit();
      sp.updateRoll(facing, h);
      expect(sp.finite()).toBe(true);
      expect(sp.lengthError()).toBeLessThan(0.01);
      expect(sp.maxBend()).toBeLessThanOrEqual(1e-3);
    }
  });

  it('reuses the previous tangent for a degenerate segment', () => {
    const sp = new Spine();
    sp.reset(100, 100, 1, 0, 10);
    for (let i = 0; i < N; i++) {
      sp.x[i] = 100;
      sp.y[i] = 100;
    }
    sp.follow(100, 100, 10);
    expect(sp.finite()).toBe(true);
    expect(sp.lengthError()).toBeLessThan(1e-9);
  });

  it('ripples a facing flip from head to tail, monotonically', () => {
    const sp = new Spine();
    sp.reset(0, 0, 1, 0, 10);
    sp.roll.fill(1);
    for (let k = 0; k < 240; k++) {
      sp.updateRoll(-1, 1 / 120);
      for (let i = 1; i < N; i++) expect(sp.roll[i]!).toBeGreaterThanOrEqual(sp.roll[i - 1]! - 1e-6);
    }
    expect(sp.roll[0]!).toBeLessThan(-0.85);
    expect(sp.roll[N - 1]!).toBeLessThan(sp.roll[0]! + 0.6);
    for (let k = 0; k < 600; k++) sp.updateRoll(-1, 1 / 120);
    expect(sp.roll[N - 1]!).toBeLessThan(-0.95);
  });
});

describe('poses', () => {
  const L = 270;
  const ox = new Float64Array(N);
  const oy = new Float64Array(N);

  it('keeps the coil inside its bounding box', () => {
    for (const facing of [1, -1]) {
      for (let b = 0; b <= 1; b += 0.25) {
        coilPose(ox, oy, L, 1000, 800, facing, b);
        for (let j = 0; j < N; j++) {
          const lx = ((ox[j]! - 1000) * facing) / L;
          const ly = (800 - oy[j]!) / L;
          expect(lx).toBeGreaterThanOrEqual(COIL_BOX.x0 - 1e-9);
          expect(lx).toBeLessThanOrEqual(COIL_BOX.x1 + 1e-9);
          expect(ly).toBeGreaterThanOrEqual(COIL_BOX.y0 - 1e-9);
          expect(ly).toBeLessThanOrEqual(COIL_BOX.y1 + 1e-9);
        }
      }
    }
  });

  it('drapes the tail below the edge only on a window, by at most 0.09·L', () => {
    for (const facing of [1, -1]) {
      for (let t = 0; t < 10; t += 0.37) {
        perchPose(ox, oy, L, 900, 400, facing, 0, t);
        for (let j = 0; j < N; j++) expect(oy[j]!).toBeLessThanOrEqual(400 + 1e-9);
        perchPose(ox, oy, L, 900, 400, facing, 1, t);
        let below = 0;
        for (let j = 0; j < N; j++) below = Math.max(below, oy[j]! - 400);
        expect(below).toBeGreaterThan(0);
        expect(below).toBeLessThanOrEqual(0.09 * L + 1e-9);
      }
    }
  });

  it('hover and roar poses are finite and anchored', () => {
    hoverPose(ox, oy, L, 500, 300, -1, 1.3);
    expect(ox[0]).toBeCloseTo(500 + 0.04 * L * Math.sin(2.6 * 1.3), 6);
    expect(oy[0]).toBeCloseTo(300, 6);
    expect(oy[N - 1]).toBeCloseTo(300 + 0.7 * L, 6);
    roarPose(ox, oy, L, 900, 400, 1, 1, 0, true);
    expect(ox[0]).toBeCloseTo(900 + 0.14 * L, 6);
    expect(oy[0]).toBeCloseTo(400 - 0.36 * L, 6);
    roarPose(ox, oy, L, 500, 300, 1, 0, 0, false);
    for (let j = 0; j < N; j++) expect(Number.isFinite(ox[j]! + oy[j]!)).toBe(true);
  });
});
