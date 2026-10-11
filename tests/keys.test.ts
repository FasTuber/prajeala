import { describe, expect, it } from 'vitest';

import { classifyDomKey, classifyKeycode } from '../src/main/keys';
import { parseOptions } from '../src/renderer/app/options';
import { EmitterContext } from '../src/renderer/emitters/EmitterContext';
import { KeyEmitter } from '../src/renderer/emitters/KeyEmitter';
import { CursorState } from '../src/renderer/input/CursorState';
import { SplatQueue } from '../src/renderer/sim/SplatQueue';
import { Sparks } from '../src/renderer/sparks/Sparks';
import type { KeyKind } from '../src/shared/ipc';
import { applyTierLimits, isLockedForTier } from '../src/shared/license';
import { DEFAULT_SETTINGS, INTENSITY_PRESETS, normalizeSettings } from '../src/shared/settings';

describe('classifyKeycode (uiohook scan codes)', () => {
  it('maps the special keys', () => {
    expect(classifyKeycode(57)).toBe('space');
    expect(classifyKeycode(28)).toBe('enter');
    expect(classifyKeycode(0x0e1c)).toBe('enter'); // numpad enter
    expect(classifyKeycode(14)).toBe('backspace');
    expect(classifyKeycode(3667)).toBe('backspace'); // delete
    for (const mod of [29, 3613, 42, 54, 56, 3640, 3675, 3676, 58, 69, 70]) expect(classifyKeycode(mod)).toBe('modifier');
    for (const nav of [0xe048, 0xe04b, 0xe04d, 0xe050, 3655, 3663, 3657, 3665, 3666, 15, 1]) expect(classifyKeycode(nav)).toBe('navigation');
    expect(classifyKeycode(0xee48)).toBe('navigation'); // numpad arrow up
    for (const fn of [59, 68, 87, 88, 3639]) expect(classifyKeycode(fn)).toBe('other');
  });

  it('treats letters, digits and punctuation as plain characters', () => {
    // Q W E R T Y row (16–25), A row (30–38), digits (2–11), punctuation (12, 13, 26, 27, 39–41, 43, 51–53)
    for (const code of [16, 20, 25, 30, 38, 2, 11, 12, 13, 26, 27, 39, 41, 43, 51, 53, 44, 50]) {
      expect(classifyKeycode(code), String(code)).toBe('char');
    }
  });

  it('never throws on garbage', () => {
    for (const bad of [undefined, null, 'a', NaN, Infinity, -1, 1e12, {}]) expect(() => classifyKeycode(bad)).not.toThrow();
    expect(classifyKeycode('a')).toBe('other');
    expect(classifyKeycode(NaN)).toBe('other');
  });
});

describe('classifyDomKey (browser mock)', () => {
  it('mirrors the native classification', () => {
    expect(classifyDomKey(' ')).toBe('space');
    expect(classifyDomKey('Enter')).toBe('enter');
    expect(classifyDomKey('Backspace')).toBe('backspace');
    expect(classifyDomKey('Shift')).toBe('modifier');
    expect(classifyDomKey('ArrowLeft')).toBe('navigation');
    expect(classifyDomKey('Tab')).toBe('navigation');
    expect(classifyDomKey('a')).toBe('char');
    expect(classifyDomKey('ă')).toBe('char');
    expect(classifyDomKey('F5')).toBe('other');
    expect(classifyDomKey('MediaPlayPause')).toBe('other');
  });
});

describe('KeyEmitter', () => {
  function setup(typingFire = true) {
    const queue = new SplatQueue();
    const sparks = new Sparks();
    const ctx = new EmitterContext(queue, sparks);
    ctx.width = 800;
    ctx.height = 600;
    ctx.dt = 1 / 60;
    ctx.settings = normalizeSettings({ typingFire, sparks: true });
    ctx.preset = INTENSITY_PRESETS.medium;
    const cursor = new CursorState();
    cursor.push({ x: 300, y: 200, gx: 300, gy: 200, inside: true, t: 1 });
    const emitter = new KeyEmitter(cursor);
    return { queue, sparks, ctx, cursor, emitter };
  }

  it('does nothing until a key arrives, then splats at the cursor and sheds sparks', () => {
    const { queue, sparks, ctx, emitter } = setup();
    emitter.update(ctx);
    expect(emitter.active).toBe(false);
    expect(queue.count).toBe(0);
    emitter.push('char');
    emitter.update(ctx);
    expect(emitter.active).toBe(true);
    expect(emitter.total).toBe(1);
    expect(queue.count).toBe(1);
    expect(sparks.count).toBeGreaterThan(0);
    // splat lands near the cursor (uv: x/width, 1 - y/height)
    expect(queue.a[0]).toBeCloseTo(300 / 800, 1);
    expect(queue.a[1]).toBeCloseTo(1 - 200 / 600, 1);
    emitter.update(ctx);
    expect(emitter.active).toBe(false);
  });

  it('ignores modifiers, caps the queue and honours the setting', () => {
    const { queue, ctx, emitter } = setup();
    emitter.push('modifier');
    emitter.update(ctx);
    expect(queue.count).toBe(0);
    for (let i = 0; i < 100; i++) emitter.push('char');
    let frames = 0;
    while (emitter.total < 24 && frames < 20) {
      emitter.update(ctx);
      frames++;
    }
    expect(emitter.total).toBe(24); // MAX_QUEUED keys survived, drained ≤ 8 per frame
    expect(frames).toBe(3);
    const off = setup(false);
    off.emitter.push('char');
    off.emitter.update(off.ctx);
    expect(off.queue.count).toBe(0);
    expect(off.emitter.total).toBe(0);
  });

  it('every kind produces something; Enter is the biggest, Backspace the smokiest', () => {
    const kinds: KeyKind[] = ['char', 'space', 'enter', 'backspace', 'navigation', 'other'];
    const heat: Record<string, number> = {};
    const smoke: Record<string, number> = {};
    for (const kind of kinds) {
      const { queue, ctx, emitter } = setup();
      emitter.push(kind);
      emitter.update(ctx);
      expect(queue.count, kind).toBeGreaterThan(0);
      heat[kind] = queue.b[0] ?? 0;
      smoke[kind] = queue.b[1] ?? 0;
    }
    expect(heat.enter!).toBeGreaterThan(heat.char!);
    expect(heat.char!).toBeGreaterThan(heat.backspace!);
    expect(smoke.backspace!).toBeGreaterThan(smoke.char!);
  });

  it('fast typing builds a combo that decays', () => {
    const { ctx, emitter } = setup();
    for (let i = 0; i < 8; i++) {
      emitter.push('char');
      emitter.update(ctx);
    }
    const peak = emitter.combo;
    expect(peak).toBeGreaterThan(0.5);
    for (let i = 0; i < 120; i++) emitter.update(ctx); // 2 s of silence
    expect(emitter.combo).toBeLessThan(peak * 0.2);
  });

  it('falls back to the window bottom edge, then the screen bottom, when the cursor is away', () => {
    const { queue, ctx, cursor, emitter } = setup();
    cursor.push({ x: -50, y: -50, gx: -50, gy: -50, inside: false, t: 2 });
    emitter.setWindowRect({ x: 100, y: 100, width: 400, height: 300 });
    emitter.push('char');
    emitter.update(ctx);
    // jitter is at most ±0.6 × radius (radius = 0.024 × 600 ≈ 14 px)
    expect(Math.abs(queue.a[0]! * 800 - 300)).toBeLessThan(12);
    expect((1 - queue.a[1]!) * 600).toBeLessThanOrEqual(405);
    expect((1 - queue.a[1]!) * 600).toBeGreaterThan(360);
    queue.clear();
    emitter.setWindowRect(null);
    emitter.push('char');
    emitter.update(ctx);
    expect(Math.abs(queue.a[0]! * 800 - 400)).toBeLessThan(12);
    expect((1 - queue.a[1]!) * 600).toBeGreaterThan(560);
  });
});

describe('typingFire setting, Pro gate and url option', () => {
  it('is off by default, Pro-only, and parsed from ?typing=', () => {
    expect(DEFAULT_SETTINGS.typingFire).toBe(false);
    expect(normalizeSettings({ typingFire: true }).typingFire).toBe(true);
    expect(applyTierLimits({ ...DEFAULT_SETTINGS, typingFire: true }, 'free').typingFire).toBe(false);
    expect(applyTierLimits({ ...DEFAULT_SETTINGS, typingFire: true }, 'pro').typingFire).toBe(true);
    expect(isLockedForTier('free', 'typingFire', true)).toBe(true);
    expect(parseOptions('?typing=1').settingsOverrides.typingFire).toBe(true);
    expect(parseOptions('?typing=sim')).toMatchObject({ typingSim: true, settingsOverrides: { typingFire: true } });
    expect(parseOptions('?typing=0').settingsOverrides.typingFire).toBe(false);
    expect(parseOptions('').typingSim).toBe(false);
  });
});
