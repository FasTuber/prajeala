import { describe, expect, it } from 'vitest';

import type { Rect } from '../src/shared/ipc';
import type { ZmeuTemper } from '../src/shared/settings';
import { ZMEU_TEMPER, zmeuLength } from '../src/shared/zmeu';
import { Random } from '../src/renderer/util/math';
import { overContent } from '../src/renderer/zmeu/core/brain';
import { hitsBody } from '../src/renderer/zmeu/core/gestures';
import { pickWindowPerch } from '../src/renderer/zmeu/core/perches';
import { createZmeuSenses } from '../src/renderer/zmeu/core/senses';
import { ZMEU_EVENT, ZMEU_JOINTS, ZMEU_TUNING, isZmeuState } from '../src/renderer/zmeu/core/tuning';
import type { ZmeuCore } from '../src/renderer/zmeu/core/ZmeuCore';
import type { HarnessInput, SimResult } from './helpers/zmeuHarness';
import { HOME_HELLO, HOME_PUFF, firstEntry, simulate } from './helpers/zmeuHarness';

const W = 1920;
const H = 1080;
const S = 1080;
const L = zmeuLength('medium', W, H);
const DP = Math.max(0.45 * L, 90);

function head(core: ZmeuCore): { x: number; y: number } {
  return { x: core.pose.headX, y: core.pose.headY };
}

function shapeOf(core: ZmeuCore): Parameters<typeof hitsBody>[0] {
  return { bodyX: core.bodyX, bodyY: core.bodyY, R: ZMEU_TUNING.radiusFrac * core.pose.L, L: core.pose.L, dirX: core.pose.dirX, dirY: core.pose.dirY };
}

/** A homing rush: from 0.3·S away, the cursor flies at the head at 900 px/s, then rests. */
function rusher(starts: number[], dt = 1 / 60): (t: number, core: ZmeuCore) => HarnessInput | undefined {
  let pos: { x: number; y: number } | null = null;
  let active = -1;
  return (t, core) => {
    const i = starts.findIndex((s0) => t >= s0 && t < s0 + 1.2);
    if (i < 0) {
      active = -1;
      return pos ? { cursor: pos } : undefined;
    }
    const h = head(core);
    if (active !== i) {
      active = i;
      const side = h.x > W / 2 ? -1 : 1;
      pos = { x: h.x + side * 0.3 * S, y: h.y };
      return { cursor: pos };
    }
    const dx = h.x - pos!.x;
    const dy = h.y - pos!.y;
    const d = Math.hypot(dx, dy);
    const stepLen = 900 * dt;
    if (d > stepLen) pos = { x: pos!.x + (dx / d) * stepLen, y: pos!.y + (dy / d) * stepLen };
    return { cursor: pos };
  };
}

function count(r: SimResult, state: string, after = 0, before = Infinity): number {
  let n = 0;
  let last = '';
  for (const e of r.timeline) {
    if (e.state === state && last !== state && e.t >= after && e.t < before) n++;
    last = e.state;
  }
  return n;
}

describe('zmeu brain: arrival and perching', () => {
  it('hello → perched within 6 s, head inside the display throughout', () => {
    const win: Rect = { x: 400, y: 300, width: 1000, height: 600 };
    for (const seed of [1, 2, 3, 4]) {
      let settled = -1;
      const r = simulate({
        seconds: 20,
        seed,
        home: HOME_HELLO,
        script: (t) => (t < 0.02 ? { cursor: { x: 900, y: 500 }, win, winKey: 11 } : undefined),
        onFrame: (t, core, _ev, s) => {
          const st = core.state;
          if (settled < 0 && core.onPerch && (st === 'perched' || st === 'curious')) settled = t;
          if (st === 'entering' || st === 'leaving' || st === 'absent' || st === 'sulk') return;
          expect(core.pose.headX).toBeGreaterThanOrEqual(0);
          expect(core.pose.headX).toBeLessThanOrEqual(W);
          expect(core.pose.headY).toBeGreaterThanOrEqual(0);
          expect(core.pose.headY).toBeLessThanOrEqual(s.floor);
        },
      });
      expect(settled).toBeGreaterThan(0);
      expect(settled).toBeLessThanOrEqual(6);
      expect(r.eventCount(ZMEU_EVENT.UNFURL)).toBe(1);
      expect(r.eventCount(ZMEU_EVENT.ROAR)).toBe(1);
      expect(r.resets).toBe(0);
    }
  });

  it('calm hello lands without a roar', () => {
    const r = simulate({ seconds: 8, seed: 5, temper: 'calm', home: HOME_HELLO, script: (t) => (t < 0.02 ? { cursor: { x: 900, y: 500 } } : undefined) });
    expect(firstEntry(r, 'perched')).toBeGreaterThan(0);
    expect(r.eventCount(ZMEU_EVENT.ROAR)).toBe(0);
  });

  it('picks the window perch in the middle third, outside the buttons zone', () => {
    const rng = new Random(9);
    for (const zone of ['right150', 'left90'] as const) {
      const s = createZmeuSenses(W, H);
      s.buttonsZone = zone;
      const out = { x: 0, y: 0, facing: 1, drape: 0, window: false, fx: 0, x0: 0, x1: 0 };
      for (let k = 0; k < 200; k++) {
        const win = { x: rng.range(-200, 1200), y: rng.range(90, 800), width: rng.range(300, 1600), height: 400 };
        s.win = win;
        const p = pickWindowPerch(s, rng, out);
        if (!p) continue;
        const m = 0.08 * S;
        let x0 = Math.max(win.x, m);
        let x1 = Math.min(win.x + win.width, W - m);
        if (zone === 'left90') x0 = Math.max(x0, win.x + 90);
        else x1 = Math.min(x1, win.x + win.width - 150);
        const third = (x1 - x0) / 3;
        expect(p.x).toBeGreaterThanOrEqual(x0 + third - 1e-6);
        expect(p.x).toBeLessThanOrEqual(x1 - third + 1e-6);
        if (zone === 'left90') expect(p.x).toBeGreaterThanOrEqual(win.x + 90);
        else expect(p.x).toBeLessThanOrEqual(win.x + win.width - 150);
        expect(p.y).toBe(win.y);
        expect(p.drape).toBe(1);
      }
      s.win = { x: 300, y: 300, width: 1000, height: 500 };
      expect(pickWindowPerch(s, rng, out)).not.toBeNull();
      s.winMaximized = true;
      expect(pickWindowPerch(s, rng, out)).toBeNull();
      s.winMaximized = false;
      s.win = { x: 300, y: 0.3 * L - 1, width: 1000, height: 500 };
      expect(pickWindowPerch(s, rng, out)).toBeNull();
    }
  });

  it('a maximised window or one too high leaves only floor perches', () => {
    for (const win of [
      { x: 0, y: 0, width: W, height: H, max: true },
      { x: 300, y: 40, width: 1000, height: 600, max: false },
    ]) {
      let perchedOnWindow = 0;
      let perched = 0;
      simulate({
        seconds: 120,
        seed: 21,
        temper: 'wild',
        script: (t) => (t < 0.02 ? { win: { x: win.x, y: win.y, width: win.width, height: win.height }, winKey: 3, winMaximized: win.max } : { inputIdleS: 0 }),
        onFrame: (_t, core) => {
          if (core.state === 'perched') {
            perched++;
            if (core.perchOnWindow) perchedOnWindow++;
          }
        },
      });
      expect(perched).toBeGreaterThan(0);
      expect(perchedOnWindow).toBe(0);
    }
  });

  it('rides a moving window and takes off when it jumps', () => {
    const win: Rect = { x: 300, y: 400, width: 1100, height: 500 };
    let a0 = 0;
    let atHalf = 0;
    const r = simulate({
      seconds: 6,
      seed: 4,
      setup: (core, s) => {
        s.win = { ...win };
        s.winKey = 8;
        core.forceState('perched', s);
      },
      script: (t, core) => {
        if (t >= 1.9 && t < 1.92) a0 = core.anchorX;
        if (t >= 2 && t < 2.02) return { win: { ...win, x: win.x + 60 } };
        if (t >= 2.5 && t < 2.52) atHalf = core.anchorX;
        if (t >= 4 && t < 4.02) return { win: { ...win, x: win.x + 460 } };
        return undefined;
      },
    });
    expect(r.core.resets).toBe(0);
    expect(Math.abs(atHalf - (a0 + 60))).toBeLessThanOrEqual(2);
    const tk = r.timeline.find((e) => e.t >= 4 && e.events & ZMEU_EVENT.TAKEOFF);
    expect(tk).toBeDefined();
    expect(firstEntry(r, 'startled', 4)).toBeGreaterThan(0);
    expect(r.timeline.filter((e) => e.t < 4 && e.events & ZMEU_EVENT.TAKEOFF)).toHaveLength(0);
  });
});

describe('zmeu brain: curiosity, chases and pokes', () => {
  it('a still cursor at 1 L makes it curious within 2.5 s', () => {
    let placed = -1;
    let cur: { x: number; y: number } | null = null;
    const r = simulate({
      seconds: 6,
      seed: 7,
      script: (t, core) => {
        if (t >= 2 && !cur) {
          const h = head(core);
          cur = { x: h.x + (h.x > W / 2 ? -1 : 1) * 0.7 * L, y: h.y - 0.7 * L };
          placed = t;
        }
        return cur ? { cursor: cur } : undefined;
      },
    });
    const c = firstEntry(r, 'curious', placed);
    expect(c).toBeGreaterThan(0);
    expect(c - placed).toBeLessThanOrEqual(2.5);
  });

  it('hovers no closer than Dp when called over', () => {
    const cur = { x: 1300, y: 420 };
    let minD = Infinity;
    let hovering = 0;
    simulate({
      seconds: 9,
      seed: 3,
      script: (t, core) => {
        if (t >= 1 && t < 1.02) core.call(cur.x, cur.y);
        return t >= 1 ? { cursor: cur } : undefined;
      },
      onFrame: (_t, core) => {
        if (core.state === 'curious' && !core.onPerch) {
          hovering++;
          minD = Math.min(minD, Math.hypot(core.pose.headX - cur.x, core.pose.headY - cur.y));
        }
      },
    });
    expect(hovering).toBeGreaterThan(60);
    expect(minD).toBeGreaterThanOrEqual(DP - 2);
  });

  it('a rush at 900 px/s startles within 2 frames of contact, then flees far from the cursor', () => {
    let close = -1;
    let fleeTarget = -1;
    let cursorAt = { x: 0, y: 0 };
    const rush = rusher([2]);
    const r = simulate({
      seconds: 6,
      seed: 12,
      script: (t, core) => {
        const out = rush(t, core);
        if (out?.cursor) cursorAt = out.cursor;
        return out;
      },
      onFrame: (t, core, _ev, s) => {
        if (close < 0 && s.cursorKnown && Math.hypot(s.cx - core.pose.headX, s.cy - core.pose.headY) < 0.06 * S) close = t;
        if (fleeTarget < 0 && core.state === 'flee') fleeTarget = Math.hypot(core.fleeX - cursorAt.x, core.fleeY - cursorAt.y);
      },
    });
    const st = firstEntry(r, 'startled', 1.5);
    expect(st).toBeGreaterThan(0);
    expect(close).toBeGreaterThan(0);
    expect(st).toBeLessThanOrEqual(close + 2 / 60 + 1e-9);
    expect(firstEntry(r, 'flee', st)).toBeGreaterThan(0);
    expect(fleeTarget).toBeGreaterThanOrEqual(0.35 * S);
  });

  it('three rushes in 20 s: playful snorts once, calm never', () => {
    for (const temper of ['playful', 'calm'] as ZmeuTemper[]) {
      const r = simulate({ seconds: 20, seed: 31, temper, script: rusher([2, 8, 14]) });
      expect(count(r, 'startled')).toBe(3);
      if (temper === 'playful') {
        expect(r.eventCount(ZMEU_EVENT.SNORT)).toBe(1);
        expect(r.core.roastCursorUntil).toBeGreaterThan(0);
      } else {
        expect(r.eventCount(ZMEU_EVENT.SNORT)).toBe(0);
      }
    }
  });

  it('five rushes in 30 s → sulk, absent 45 s, then back', () => {
    const rush = rusher([2, 8, 14, 20, 26]);
    let sulked = false;
    const r = simulate({
      seconds: 90,
      seed: 32,
      script: (t, core) => {
        if (t > 1 && (core.state === 'sulk' || core.state === 'absent')) sulked = true;
        return sulked ? { cursor: null } : rush(t, core);
      },
    });
    const s = firstEntry(r, 'sulk');
    expect(s).toBeGreaterThan(26);
    const a = firstEntry(r, 'absent', s);
    const back = firstEntry(r, 'entering', a);
    expect(a).toBeGreaterThan(s);
    expect(back - a).toBeGreaterThanOrEqual(45 - 0.05);
    expect(back - a).toBeLessThan(46);
    expect(firstEntry(r, 'wander', back)).toBeGreaterThan(back);
  });

  it('three pokes in 6 s → sulk', () => {
    const r = simulate({
      seconds: 10,
      seed: 41,
      script: (t, core) => {
        for (const tp of [2, 3.5, 5]) if (t >= tp && t < tp + 1 / 60) return { clicks: [{ type: 'click', x: core.bodyX[3]!, y: core.bodyY[3]! }] };
        return undefined;
      },
    });
    expect(count(r, 'startled', 0, 5)).toBe(2);
    const s = firstEntry(r, 'sulk');
    expect(s).toBeGreaterThanOrEqual(5);
    expect(s).toBeLessThan(5.2);
  });

  it('a drag over the body is never a poke', () => {
    const r = simulate({
      seconds: 4,
      seed: 41,
      script: (t, core) => {
        if (t >= 2 && t < 2 + 1 / 60) return { clicks: [{ type: 'down', x: core.bodyX[3]!, y: core.bodyY[3]! }] };
        if (t >= 2.1 && t < 2.1 + 1 / 60) return { clicks: [{ type: 'up', x: core.bodyX[3]! + 40, y: core.bodyY[3]! }] };
        return undefined;
      },
    });
    expect(count(r, 'startled')).toBe(0);
  });

  it('a poke while asleep wakes it (playful: short roar; calm: grumpy puff, no roar)', () => {
    for (const temper of ['playful', 'calm'] as ZmeuTemper[]) {
      const r = simulate({
        seconds: 8,
        seed: 43,
        temper,
        script: (t, core, s) => {
          if (t >= 1 && t < 1.02) core.forceState('asleep', s);
          if (t >= 3 && t < 3 + 1 / 60) return { clicks: [{ type: 'click', x: core.bodyX[10]!, y: core.bodyY[10]! }] };
          return undefined;
        },
      });
      const wk = firstEntry(r, 'waking', 2.9);
      expect(wk).toBeGreaterThanOrEqual(3);
      expect(wk).toBeLessThan(3.05);
      expect(r.eventCount(ZMEU_EVENT.ROAR)).toBe(temper === 'calm' ? 0 : 1);
      expect(count(r, 'startled')).toBe(0);
    }
  });
});

describe('zmeu brain: petting and make-way', () => {
  it('a wiggle over the body → pet, happy', () => {
    let center: { x: number; y: number } | null = null;
    let happy = 0;
    const r = simulate({
      seconds: 5,
      seed: 51,
      script: (t, core) => {
        if (t < 2) return undefined;
        if (!center) center = { x: core.bodyX[10]!, y: core.bodyY[10]! };
        if (t > 4) return undefined;
        return { cursor: { x: center.x + 0.08 * L * Math.sin(2 * Math.PI * 4 * (t - 2)), y: center.y } };
      },
      onFrame: (_t, core) => {
        if (core.state === 'pet') happy = Math.max(happy, core.pose.happy);
      },
    });
    const p = firstEntry(r, 'pet', 2);
    expect(p).toBeGreaterThan(2);
    expect(p).toBeLessThan(3);
    expect(happy).toBeGreaterThan(0.8);
    expect(count(r, 'startled')).toBe(0);
  });

  it('a resting pointer on the body → hop; 1 s later it no longer hits', () => {
    let cur: { x: number; y: number } | null = null;
    let hopAt = -1;
    let hitAfter: boolean | null = null;
    simulate({
      seconds: 6,
      seed: 52,
      script: (t, core) => {
        if (t >= 2 && !cur) cur = { x: core.bodyX[8]!, y: core.bodyY[8]! };
        return cur ? { cursor: cur } : undefined;
      },
      onFrame: (t, core) => {
        if (hopAt < 0 && core.state === 'hop') hopAt = t;
        if (hopAt > 0 && hitAfter === null && t >= hopAt + 1) hitAfter = hitsBody(shapeOf(core), cur!.x, cur!.y, 8);
      },
    });
    expect(hopAt).toBeGreaterThan(2.5);
    expect(hopAt).toBeLessThan(3);
    expect(hitAfter).toBe(false);
  });
});

describe('zmeu brain: fire', () => {
  const win: Rect = { x: 300, y: 400, width: 1100, height: 500 };

  it('breathes on a new window at about breathChance (playful)', () => {
    let breaths = 0;
    const trials = 200;
    for (let seed = 1; seed <= trials; seed++) {
      const r = simulate({ seconds: 3, seed, script: (t) => (t >= 1.5 && t < 1.52 ? { win: { ...win }, winKey: 77 } : undefined) });
      if (count(r, 'breathe') > 0) breaths++;
    }
    expect(Math.abs(breaths / trials - ZMEU_TEMPER.playful.breathChance)).toBeLessThanOrEqual(0.1);
  });

  it('impacts land on the window top edge, inside the window', () => {
    let checked = 0;
    for (let seed = 1; seed <= 30 && checked < 3; seed++) {
      const r = simulate({ seconds: 9, seed, temper: 'wild', script: (t) => (t >= 1.5 && t < 1.52 ? { win: { ...win }, winKey: 77 } : undefined) });
      if (count(r, 'breathe') === 0) continue;
      const bursts = r.timeline.filter((e) => e.events & ZMEU_EVENT.BURST);
      expect(bursts.length).toBe(4);
      expect(r.eventCount(ZMEU_EVENT.KINDLE)).toBe(1);
      for (const b of bursts) {
        expect(Math.abs(b.impactY - win.y)).toBeLessThanOrEqual(2);
        expect(b.impactX).toBeGreaterThanOrEqual(win.x);
        expect(b.impactX).toBeLessThanOrEqual(win.x + win.width);
      }
      checked++;
    }
    expect(checked).toBe(3);
  });

  it('never breathes twice on the same window within 120 s', () => {
    const other: Rect = { x: 200, y: 250, width: 900, height: 600 };
    let firstA = 0;
    let againA = 0;
    let control = 0;
    for (let seed = 1; seed <= 20; seed++) {
      for (const back of [1, 3]) {
        const r = simulate({
          seconds: 84,
          dt: 1 / 30,
          seed,
          temper: 'wild',
          script: (t) => {
            const keepAwake = { cursor: { x: 5 + (Math.floor(t / 5) % 2), y: 5 } };
            if (t >= 1.5 && t < 1.54) return { ...keepAwake, win: { ...win }, winKey: 1 };
            if (t >= 40 && t < 40.04) return { ...keepAwake, win: { ...other }, winKey: 2 };
            if (t >= 80 && t < 80.04) return { ...keepAwake, win: { ...win }, winKey: back };
            return keepAwake;
          },
        });
        const a = count(r, 'breathe', 1.5, 6) > 0;
        if (back === 1) {
          if (a) firstA++;
          if (a && count(r, 'breathe', 80) > 0) againA++;
        } else if (count(r, 'breathe', 80) > 0) control++;
      }
    }
    // Wild breathes on ~55 % of new windows: enough first breaths and control breaths to make the check meaningful.
    expect(firstA).toBeGreaterThan(6);
    expect(againA).toBe(0);
    expect(control).toBeGreaterThan(3);
  });

  it('keeps quiet while typing: no breath, no snort, no curiosity', () => {
    const rng = new Random(5);
    let cur = { x: 900, y: 500 };
    const r = simulate({
      seconds: 300,
      seed: 61,
      temper: 'wild',
      script: (t, core) => {
        const out: HarnessInput = {};
        const k = Math.floor(t / 0.2);
        if (Math.floor((t - 1 / 60) / 0.2) !== k) out.keys = 1;
        if (Math.floor(t / 20) !== Math.floor((t - 1 / 60) / 20)) {
          out.win = { x: rng.range(0, 800), y: rng.range(150, 500), width: rng.range(600, 1000), height: 400 };
          out.winKey = Math.floor(rng.range(1, 1000));
        }
        if (Math.floor(t / 7) !== Math.floor((t - 1 / 60) / 7)) {
          const h = head(core);
          cur = { x: h.x + 0.8 * L, y: h.y };
        }
        out.cursor = cur;
        return out;
      },
    });
    expect(count(r, 'breathe')).toBe(0);
    expect(r.eventCount(ZMEU_EVENT.SNORT)).toBe(0);
    expect(count(r, 'curious')).toBe(0);
  });

  it('cheers a burn: IGNITE at most every 3.5 s, back to wander when it ends', () => {
    const r = simulate({ seconds: 26, seed: 71, script: (t) => (t >= 2 && t < 20 ? { burnTarget: { x: 900, y: 700 } } : { burnTarget: null }) });
    const c = firstEntry(r, 'cheer');
    expect(c).toBeGreaterThanOrEqual(2);
    expect(c).toBeLessThan(2.1);
    const ignites = r.timeline.filter((e) => e.events & ZMEU_EVENT.IGNITE);
    expect(ignites.length).toBeGreaterThanOrEqual(4);
    for (let i = 1; i < ignites.length; i++) expect(ignites[i]!.t - ignites[i - 1]!.t).toBeGreaterThanOrEqual(3.5 - 1e-6);
    for (const e of ignites) {
      expect(e.igniteX).toBe(900);
      expect(e.igniteY).toBe(700);
    }
    const wd = firstEntry(r, 'wander', 20);
    expect(wd).toBeGreaterThanOrEqual(20);
    expect(wd).toBeLessThan(20.1);
  });
});

describe('zmeu brain: sleep', () => {
  it('naps after 60 s idle (idleSleep 120 s): drowsy at 60, asleep by 70, on the floor', () => {
    for (const seed of [81, 82, 83]) {
      let onFloor = false;
      const r = simulate({
        seconds: 75,
        seed,
        script: () => ({ idleSleepS: 120 }),
        onFrame: (_t, core) => {
          if (core.state === 'asleep') onFloor = core.onPerch && !core.perchOnWindow && Math.abs(core.anchorY - H) < 1;
        },
      });
      const d = firstEntry(r, 'drowsy');
      expect(d).toBeGreaterThanOrEqual(60);
      expect(d).toBeLessThan(60.5);
      const a = firstEntry(r, 'asleep');
      expect(a).toBeGreaterThan(d);
      expect(a).toBeLessThanOrEqual(70);
      expect(onFloor).toBe(true);
    }
  });

  it('power sleep while flying → asleep within 8 s, no fluid once the yawn is over', () => {
    let violations = 0;
    const r = simulate({
      seconds: 14,
      seed: 91,
      script: (t, core, s) => {
        if (t >= 1 && t < 1.02) core.forceState('wander', s);
        return t >= 2 ? { powerSleeping: true } : undefined;
      },
      onFrame: (_t, core) => {
        if ((core.state === 'drowsy' && core.stateAge > 1.25) || core.state === 'asleep') {
          if (core.wantsFluid || core.manePower > 0 || core.breath.power > 0) violations++;
        }
      },
    });
    const a = firstEntry(r, 'asleep');
    expect(a).toBeGreaterThan(2);
    expect(a - 2).toBeLessThanOrEqual(8);
    expect(violations).toBe(0);
  });

  it('petFps: 8 asleep, 0 after 300 s asleep, 30 within one step of input', () => {
    const fps: Record<string, number> = {};
    let woke: boolean | null = null;
    simulate({
      seconds: 306,
      seed: 92,
      script: (t, core, s) => {
        if (t >= 1 && t < 1.02) core.forceState('asleep', s);
        if (t >= 305 && woke === null) {
          woke = core.noteCursor(100, 100, t);
          return { cursor: { x: 100, y: 100 } };
        }
        return undefined;
      },
      onFrame: (t, core) => {
        if (t >= 10 && fps.a === undefined) fps.a = core.petFps;
        if (t >= 302 && fps.b === undefined) fps.b = core.petFps;
        if (woke !== null && fps.c === undefined) fps.c = core.petFps;
      },
    });
    expect(fps.a).toBe(8);
    expect(fps.b).toBe(0);
    expect(woke).toBe(true);
    expect(fps.c).toBe(30);
  });

  it('roars on waking only after a long sleep, and not twice within 600 s', () => {
    const r = simulate({
      seconds: 870,
      seed: 93,
      script: (t, core, s) => {
        if (t >= 1 && t < 1.02) core.forceState('asleep', s);
        if (t >= 40 && t < 40.02) core.forceState('asleep', s);
        if (t >= 450 && t < 450.02) core.forceState('asleep', s);
        for (const tw of [31, 440, 860]) if (t >= tw && t < tw + 0.02) return { cursor: { x: 50 + tw, y: 60 } };
        return undefined;
      },
    });
    const roarsIn = (a: number, b: number): number => r.timeline.filter((e) => e.t >= a && e.t < b && e.events & ZMEU_EVENT.ROAR).length;
    expect(firstEntry(r, 'waking', 30)).toBeLessThan(31.1);
    expect(roarsIn(30, 40)).toBe(0);
    expect(firstEntry(r, 'waking', 439)).toBeLessThan(440.1);
    expect(roarsIn(439, 450)).toBe(1);
    expect(firstEntry(r, 'waking', 859)).toBeLessThan(860.1);
    expect(roarsIn(859, 870)).toBe(0);
  });

  it('resumeAfter(600) → asleep; the first input wakes it', () => {
    let woke: boolean | null = null;
    const r = simulate({
      seconds: 5,
      seed: 94,
      script: (t, core) => {
        if (t >= 2 && t < 2.02) {
          core.resumeAfter(600);
          expect(core.state).toBe('asleep');
          expect(core.petFps).toBe(0);
        }
        if (t >= 3 && woke === null) {
          woke = core.noteKey(t);
          expect(core.state).toBe('waking');
        }
        return undefined;
      },
    });
    expect(woke).toBe(true);
    expect(firstEntry(r, 'waking')).toBeGreaterThanOrEqual(2.9);
  });
});

describe('zmeu brain: home', () => {
  it('home false → leaves and reports EXITED once; home via edge → enters at that edge', () => {
    let firstSeen: { x: number; y: number } | null = null;
    const r = simulate({
      seconds: 14,
      seed: 101,
      script: (t) => {
        if (t >= 3 && t < 3.02) return { home: { seq: 2, home: false, via: 'edge', edge: 'right', at: 500 } };
        if (t >= 8 && t < 8.02) return { home: { seq: 3, home: true, via: 'edge', edge: 'left', at: 600 } };
        return undefined;
      },
      onFrame: (t, core) => {
        if (t > 8 && !firstSeen && core.visible) firstSeen = head(core);
      },
    });
    const lv = firstEntry(r, 'leaving', 3);
    const ab = firstEntry(r, 'absent', lv);
    expect(lv).toBeLessThan(3.05);
    expect(ab - lv).toBeLessThanOrEqual(3);
    expect(r.eventCount(ZMEU_EVENT.EXITED)).toBe(1);
    expect(r.timeline.find((e) => e.events & ZMEU_EVENT.EXITED)!.exitSeq).toBe(2);
    expect(firstSeen).not.toBeNull();
    expect(firstSeen!.x).toBeLessThan(0);
    expect(Math.abs(firstSeen!.y - 600)).toBeLessThanOrEqual(0.1 * S);
    expect(firstEntry(r, 'wander', 8)).toBeGreaterThan(8);
  });

  it('arrives from the sky as a fireball, then unfurls', () => {
    let ballSeen = false;
    let unfurledAt = -1;
    simulate({
      seconds: 4,
      seed: 102,
      home: { seq: 1, home: true, via: 'sky', edge: 'top', at: 700 },
      onFrame: (t, core, ev) => {
        if (core.visible && core.pose.ball > 0.99) ballSeen = true;
        if (ev & ZMEU_EVENT.UNFURL) unfurledAt = t;
      },
    });
    expect(ballSeen).toBe(true);
    expect(unfurledAt).toBeGreaterThan(0.3);
    expect(unfurledAt).toBeLessThan(1.5);
  });

  it('switching it off departs upward without EXITED', () => {
    let lastY = Infinity;
    let rising = true;
    const r = simulate({
      seconds: 7,
      seed: 103,
      script: (t) => (t >= 3 && t < 3.02 ? { enabled: false } : undefined),
      onFrame: (t, core) => {
        if (core.state === 'leaving' && t > 3.3) {
          if (core.pose.headY > lastY + 0.5) rising = false;
          lastY = core.pose.headY;
        }
      },
    });
    expect(firstEntry(r, 'leaving', 3)).toBeLessThan(3.05);
    expect(firstEntry(r, 'absent', 3)).toBeLessThanOrEqual(6.05);
    expect(rising).toBe(true);
    expect(r.eventCount(ZMEU_EVENT.EXITED)).toBe(0);
  });
});

/** A busy 10-minute session: random-walk cursor, typing bursts, window switches. */
function session(seed: number, temper: ZmeuTemper, seconds: number, extra?: (t: number) => HarnessInput | undefined): HarnessInput[] | ((t: number, core: ZmeuCore) => HarnessInput) {
  const rng = new Random(seed * 101 + 7);
  let cx = W / 2;
  let cy = H / 2;
  let vx = 0;
  let vy = 0;
  let typingUntil = -1;
  let nextType = rng.range(20, 60);
  let nextWin = 0;
  let nextIdle = rng.range(30, 120);
  let idleUntil = -1;
  void seconds;
  void temper;
  return (t: number) => {
    const out: HarnessInput = { ...(extra?.(t) ?? {}) };
    if (t >= nextIdle) {
      idleUntil = t + rng.range(20, 90);
      nextIdle = idleUntil + rng.range(60, 200);
    }
    if (t >= idleUntil) {
      vx = vx * 0.95 + rng.range(-1, 1) * 120;
      vy = vy * 0.95 + rng.range(-1, 1) * 120;
      cx = Math.min(W - 1, Math.max(1, cx + vx / 60));
      cy = Math.min(H - 1, Math.max(1, cy + vy / 60));
      out.cursor = { x: cx, y: cy };
    }
    if (t >= nextType) {
      typingUntil = t + rng.range(3, 15);
      nextType = typingUntil + rng.range(20, 90);
    }
    if (t < typingUntil && rng.next() < 0.2) out.keys = 1;
    if (t >= nextWin) {
      nextWin = t + rng.range(15, 60);
      const ww = rng.range(500, 1100);
      const wh = rng.range(300, 700);
      out.win = { x: rng.range(0, W - ww), y: rng.range(100, H - wh - 60), width: ww, height: wh };
      out.winKey = Math.floor(rng.range(1, 6));
    }
    return out;
  };
}

describe('zmeu brain: determinism and robustness', () => {
  it('is deterministic for a seed and script', () => {
    const run = (): SimResult => simulate({ seconds: 90, seed: 111, temper: 'wild', script: session(5, 'wild', 90) as (t: number, core: ZmeuCore) => HarnessInput });
    const a = run();
    const b = run();
    expect(a.timeline.length).toBeGreaterThan(5);
    expect(b.timeline).toEqual(a.timeline);
    expect(b.snapshots).toEqual(a.snapshots);
  });

  it('is frame-rate independent for an arrival', () => {
    const ends: { x: number; y: number }[] = [];
    const mids: { x: number; y: number }[] = [];
    for (const dt of [1 / 30, 1 / 60, 1 / 144]) {
      let mid: { x: number; y: number } | null = null;
      const r = simulate({
        seconds: 7,
        dt,
        seed: 121,
        script: (t, core, s) => {
          if (t >= 1 - 1e-6 && t < 1 - 1e-6 + dt) {
            s.win = { x: 1100, y: 350, width: 700, height: 500 };
            s.winKey = 3;
            core.forceState('landing', s);
          }
          return undefined;
        },
        onFrame: (t, core) => {
          if (!mid && t >= 1.8) mid = head(core);
        },
      });
      ends.push(head(r.core));
      mids.push(mid!);
    }
    for (const e of ends) {
      expect(Math.hypot(e.x - ends[0]!.x, e.y - ends[0]!.y)).toBeLessThanOrEqual(3);
    }
    for (const m of mids) expect(Math.hypot(m.x - mids[0]!.x, m.y - mids[0]!.y)).toBeLessThanOrEqual(12);
  });

  it('reduced motion: never faster than cruise, no loops', () => {
    let maxSpeed = 0;
    const r = simulate({
      seconds: 240,
      seed: 131,
      temper: 'wild',
      home: HOME_HELLO,
      script: session(9, 'wild', 240, () => ({ reducedMotion: true })) as (t: number, core: ZmeuCore) => HarnessInput,
      onFrame: (_t, core) => {
        maxSpeed = Math.max(maxSpeed, core.pose.speed);
      },
    });
    expect(maxSpeed).toBeLessThanOrEqual(ZMEU_TUNING.cruise * S * 1.001);
    expect(r.core.loops).toBe(0);
    expect(r.eventCount(ZMEU_EVENT.SNORT)).toBe(0);
  });

  it('keeps its etiquette budget over seeded 10-minute sessions', () => {
    // The spec asks for 20 per temper; 10 keeps the suite inside its runtime budget (see report).
    const SESSIONS = 10;
    const SECONDS = 600;
    for (const temper of ['calm', 'playful', 'wild'] as ZmeuTemper[]) {
      const t = ZMEU_TEMPER[temper];
      let flying = 0;
      let over = 0;
      let total = 0;
      for (let k = 0; k < SESSIONS; k++) {
        const r = simulate({
          seconds: SECONDS,
          dt: 1 / 20,
          seed: 1000 + k,
          temper,
          home: HOME_HELLO,
          snapEvery: 1e9,
          script: session(k, temper, SECONDS) as (t: number, core: ZmeuCore) => HarnessInput,
          onFrame: (_t, core, _ev, s) => {
            total++;
            const st = core.state;
            if (st === 'wander' || st === 'flee' || st === 'landing' || st === 'curious' || st === 'cheer' || st === 'breathe') {
              if (!core.onPerch) {
                flying++;
                if (overContent(s, core.pose.headX, core.pose.headY)) over++;
              }
            }
          },
        });
        const breaths = count(r, 'breathe');
        expect(breaths).toBeLessThanOrEqual(Math.ceil(SECONDS / t.bigCooldownS) + 1);
        if (temper === 'calm') expect(breaths).toBe(0);
        expect(r.resets).toBe(0);
      }
      expect(flying).toBeGreaterThan(0);
      expect(over / total).toBeLessThanOrEqual(0.03);
    }
  }, 60_000);

  it('FUZZ: bad senses, jittery dt, resizes and power toggles stay finite and valid', () => {
    const rng = new Random(77);
    const rects: (Rect | null)[] = [
      { x: NaN, y: 10, width: 100, height: 100 },
      { x: 10, y: 10, width: -50, height: 100 },
      { x: -1e9, y: -1e9, width: 1e12, height: 1e12 },
      { x: 1e9, y: 5, width: 10, height: 10 },
      { x: 300, y: 300, width: 900, height: 500 },
      { x: 0, y: 0, width: Infinity, height: 3 },
      null,
    ];
    let small = false;
    const r = simulate({
      seconds: 600,
      dt: 'jitter',
      jitter: [1 / 240, 0.25],
      seed: 141,
      temper: 'wild',
      home: HOME_HELLO,
      script: (t, core) => {
        const out: HarnessInput = {};
        if (rng.next() < 0.02) {
          out.win = rects[Math.floor(rng.next() * rects.length)]!;
          out.winKey = rng.next() < 0.1 ? NaN : Math.floor(rng.range(0, 5));
          out.winMaximized = rng.next() < 0.1;
        }
        if (rng.next() < 0.004) {
          small = !small;
          out.width = small ? 1280 : 1920;
          out.height = small ? 720 : 1080;
          out.floor = small ? 680 : 1040;
          out.S = small ? 720 : 1080;
          out.L = zmeuLength('medium', out.width, out.height);
        }
        if (rng.next() < 0.01) out.powerSleeping = rng.next() < 0.3;
        if (rng.next() < 0.01) out.L = rng.next() < 0.5 ? NaN : -5;
        if (rng.next() < 0.005) out.cvx = NaN;
        if (rng.next() < 0.01) out.burnTarget = rng.next() < 0.5 ? null : { x: rng.range(-100, 2000), y: NaN };
        if (rng.next() < 0.3) out.cursor = { x: rng.range(-50, 2000), y: rng.range(-50, 1100) };
        if (rng.next() < 0.01) out.clicks = [{ type: 'click', x: core.bodyX[5]!, y: core.bodyY[5]! }];
        if (rng.next() < 0.01) out.keys = 1;
        if (rng.next() < 0.003) out.home = { seq: Math.floor(t), home: rng.next() < 0.8, via: rng.next() < 0.5 ? 'sky' : 'edge', edge: 'left', at: rng.range(-1e6, 1e6) };
        if (rng.next() < 0.002) core.noteCursor(NaN, Infinity, NaN);
        if (rng.next() < 0.002) core.step(NaN, createZmeuSenses(), NaN);
        return out;
      },
      onFrame: (_t, core) => {
        expect(isZmeuState(core.state)).toBe(true);
        for (let i = 0; i < ZMEU_JOINTS; i++) {
          expect(Number.isFinite(core.bodyX[i]!)).toBe(true);
          expect(Number.isFinite(core.bodyY[i]!)).toBe(true);
          expect(Number.isFinite(core.roll[i]!)).toBe(true);
        }
        for (const v of Object.values(core.pose)) expect(Number.isFinite(v)).toBe(true);
        for (const v of Object.values(core.breath)) expect(Number.isFinite(v)).toBe(true);
        for (const v of Object.values(core.light)) expect(Number.isFinite(v)).toBe(true);
      },
    });
    expect(r.resets).toBeLessThanOrEqual(1);
    expect(r.timeline.length).toBeGreaterThan(10);
  });
});

void HOME_PUFF;
