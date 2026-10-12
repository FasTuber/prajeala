import { describe, expect, it } from 'vitest';

import { downscaleFactor, fitContain, intersectRect, toUvRect } from '../src/shared/burn';

describe('burn geometry', () => {
  it('converts local CSS rects to y-up UV rects', () => {
    expect(toUvRect({ x: 0, y: 0, width: 1920, height: 1080 }, 1920, 1080)).toEqual([0, 0, 1, 1]);
    const [x0, y0, x1, y1] = toUvRect({ x: 480, y: 270, width: 960, height: 270 }, 1920, 1080);
    expect([x0, y0, x1, y1]).toEqual([0.25, 0.5, 0.75, 0.75]);
    // clamped to the canvas
    expect(toUvRect({ x: -100, y: -100, width: 5000, height: 5000 }, 1920, 1080)).toEqual([0, 0, 1, 1]);
  });

  it('fits images inside a box keeping the aspect ratio', () => {
    expect(fitContain(1000, 500, { x: 0, y: 0, width: 1920, height: 1080 })).toEqual({ x: 0, y: 60, width: 1920, height: 960 });
    expect(fitContain(500, 1000, { x: 0, y: 0, width: 1920, height: 1080 }, 40)).toEqual({ x: 710, y: 40, width: 500, height: 1000 });
  });

  it('intersects rects', () => {
    expect(intersectRect({ x: 0, y: 0, width: 100, height: 100 }, { x: 50, y: 60, width: 100, height: 100 })).toEqual({ x: 50, y: 60, width: 50, height: 40 });
    expect(intersectRect({ x: 0, y: 0, width: 10, height: 10 }, { x: 20, y: 20, width: 5, height: 5 })).toMatchObject({ width: 0, height: 0 });
  });

  it('downscales only oversized snapshots', () => {
    expect(downscaleFactor(1920, 1080)).toBe(1);
    expect(downscaleFactor(7680, 4320)).toBeCloseTo(4096 / 7680, 10);
  });
});
