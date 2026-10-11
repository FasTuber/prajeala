import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ThemeStore } from '../src/main/theme-store';
import { applyTierLimits, isLockedForTier } from '../src/shared/license';
import { PALETTE_DEFINITIONS, bakePaletteLut } from '../src/shared/palettes';
import { DEFAULT_SETTINGS, PALETTES, THEME_ID_RE, normalizeSettings } from '../src/shared/settings';
import {
  BUILTIN_THEMES,
  DEFAULT_THEME_LOOK,
  DEFAULT_THEME_SIM,
  THEME_FORMAT,
  THEME_VERSION,
  parseThemeJson,
  slugify,
  themeFromPalette,
  themePalette,
  themeToJson,
  themesEqual,
  validateTheme,
} from '../src/shared/theme';

const sample = () => ({
  format: THEME_FORMAT,
  version: THEME_VERSION,
  name: 'Lava lamp',
  stops: [
    [0, 0, 0, 0],
    [0.5, 0.9, 0.2, 0.6],
    [1, 1, 1, 1],
  ],
  spark: [1, 0.5, 0.9],
  sim: { buoyancy: 0.5, curl: 1.5, flow: -1 },
  look: { glow: 0.8, smokeColor: [0.1, 0.2, 0.3] },
});

describe('built-in themes', () => {
  it('exist for every palette, with the palette colours and valid knobs', () => {
    expect(Object.keys(BUILTIN_THEMES).sort()).toEqual([...PALETTES].sort());
    for (const p of PALETTES) {
      const t = BUILTIN_THEMES[p];
      expect(t.id).toBe(p);
      expect(t.basePalette).toBe(p);
      expect(t.stops).toEqual(PALETTE_DEFINITIONS[p].stops);
      expect(t.spark).toEqual(PALETTE_DEFINITIONS[p].spark);
      expect(validateTheme(JSON.parse(themeToJson(t)))).toMatchObject({ ok: true });
      expect(Object.isFrozen(t)).toBe(true);
    }
    expect(BUILTIN_THEMES.classic.sim).toEqual(DEFAULT_THEME_SIM);
    expect(BUILTIN_THEMES.classic.look).toEqual(DEFAULT_THEME_LOOK);
  });

  it('the new palettes have distinct flavours', () => {
    expect(BUILTIN_THEMES.ice.sim.buoyancy).toBeLessThan(0); // sinks
    expect(BUILTIN_THEMES.ice.sim.flow).toBeLessThan(0);
    expect(BUILTIN_THEMES.electric.sim.curl).toBeGreaterThan(2);
    expect(BUILTIN_THEMES.electric.look.noiseSpeed).toBeGreaterThan(2);
    expect(BUILTIN_THEMES.electric.look.smoke).toBe(0);
    expect(BUILTIN_THEMES.neon.look.glow).toBeGreaterThan(BUILTIN_THEMES.classic.look.glow);
    expect(BUILTIN_THEMES.neon.look.detail).toBeLessThan(BUILTIN_THEMES.classic.look.detail);
    // and bake like any palette
    expect(bakePaletteLut(themePalette(BUILTIN_THEMES.neon)).length).toBe(1024);
  });

  it('themeFromPalette returns fresh mutable copies', () => {
    const a = themeFromPalette('ice');
    const b = themeFromPalette('ice');
    expect(a).toEqual(b);
    expect(a).not.toBe(b);
    expect(a.stops).not.toBe(b.stops);
  });
});

describe('validateTheme', () => {
  it('accepts a minimal theme and fills the defaults', () => {
    const v = validateTheme({ format: THEME_FORMAT, version: 1, name: 'Mini', stops: [[0, 0, 0, 0], [1, 1, 1, 1]] });
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    expect(v.theme.id).toBe('mini');
    expect(v.theme.sim).toEqual(DEFAULT_THEME_SIM);
    expect(v.theme.look).toEqual(DEFAULT_THEME_LOOK);
    expect(v.theme.spark).toEqual([1, 1, 1]); // hot end
    expect(v.theme.basePalette).toBeUndefined();
  });

  it('keeps the provided knobs, clamps them and derives ids', () => {
    const v = validateTheme({ ...sample(), sim: { buoyancy: 99, curl: -5, flow: -1 }, look: { glow: 10, detail: 0.5 } });
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    expect(v.theme.id).toBe('lava-lamp');
    expect(v.theme.sim).toMatchObject({ buoyancy: 4, curl: 0, flow: -1, cooling: 1 });
    expect(v.theme.look).toMatchObject({ glow: 2, detail: 0.5, smoke: DEFAULT_THEME_LOOK.smoke });
    expect(validateTheme({ ...sample(), id: 'my-theme' })).toMatchObject({ ok: true, theme: { id: 'my-theme' } });
    expect(validateTheme({ ...sample(), id: 'Bad Id!' })).toMatchObject({ ok: true, theme: { id: 'lava-lamp' } });
    expect(validateTheme({ ...sample(), name: '🔥🔥' }, 'fallback')).toMatchObject({ ok: true, theme: { id: 'fallback', name: '🔥🔥' } });
    expect(validateTheme({ ...sample(), basePalette: 'neon' })).toMatchObject({ ok: true, theme: { basePalette: 'neon' } });
    expect(validateTheme({ ...sample(), basePalette: 'rainbow' })).toMatchObject({ ok: true });
  });

  it('rejects wrong format/version, bad stops and bad colours with a reason', () => {
    const bad: Array<[unknown, RegExp]> = [
      [null, /object/],
      [[], /object/],
      [{ ...sample(), format: 'other' }, /format/],
      [{ ...sample(), version: 2 }, /version/],
      [{ ...sample(), name: '   ' }, /name/],
      [{ ...sample(), name: '🔥🔥' }, /id/],
      [{ ...sample(), stops: [] }, /stops/],
      [{ ...sample(), stops: [[0, 0, 0, 0]] }, /stops/],
      [{ ...sample(), stops: [[0, 0, 0, 0], [1, 1, 1]] }, /stop 1/],
      [{ ...sample(), stops: [[0, 0, 0, 0], [0.5, 'x', 0, 0], [1, 1, 1, 1]] }, /non-numeric/],
      [{ ...sample(), stops: [[0, 0, 0, 0], [0.5, 1, 1, 1], [0.5, 1, 1, 1], [1, 1, 1, 1]] }, /increase/],
      [{ ...sample(), stops: [[0.1, 0, 0, 0], [1, 1, 1, 1]] }, /t=0/],
      [{ ...sample(), stops: [[0, 0, 0, 0], [0.9, 1, 1, 1]] }, /t=1/],
      [{ ...sample(), stops: Array.from({ length: 33 }, (_, i) => [i / 32, 0, 0, 0]) }, /stops/],
    ];
    for (const [input, re] of bad) {
      const v = validateTheme(input);
      expect(v.ok, JSON.stringify(input)?.slice(0, 60)).toBe(false);
      if (!v.ok) expect(v.error).toMatch(re);
    }
  });

  it('round-trips through JSON and compares structurally', () => {
    const v = validateTheme(sample());
    if (!v.ok) throw new Error(v.error);
    const text = themeToJson(v.theme);
    expect(text.endsWith('\n')).toBe(true);
    const back = parseThemeJson(text);
    expect(back).toMatchObject({ ok: true });
    if (!back.ok) return;
    expect(back.theme).toEqual(v.theme);
    expect(themesEqual(v.theme, back.theme)).toBe(true);
    expect(themesEqual(v.theme, BUILTIN_THEMES.classic)).toBe(false);
    expect(themesEqual(null, null)).toBe(true);
    expect(themesEqual(v.theme, null)).toBe(false);
    expect(parseThemeJson('{not json')).toMatchObject({ ok: false, error: expect.stringContaining('JSON') });
  });

  it('slugify', () => {
    expect(slugify('Prăjeală Neagră!')).toBe('prajeala-neagra');
    expect(slugify('  --Hello  World-- ')).toBe('hello-world');
    expect(slugify('🔥')).toBe('');
    expect(slugify('a'.repeat(100)).length).toBe(64);
    for (const s of ['x', 'my-theme-2']) expect(THEME_ID_RE.test(s)).toBe(true);
    for (const s of ['', '-a', 'A', 'a_b', 'a'.repeat(65)]) expect(THEME_ID_RE.test(s)).toBe(false);
  });
});

describe('settings.themeId and the Pro gate', () => {
  it('accepts slugs only', () => {
    expect(DEFAULT_SETTINGS.themeId).toBe('');
    expect(normalizeSettings({ themeId: 'lava-lamp' }).themeId).toBe('lava-lamp');
    for (const bad of ['../x', 'Lava', 'a b', 42, null, true]) expect(normalizeSettings({ themeId: bad }).themeId).toBe('');
  });

  it('Free drops custom themes, Pro keeps them', () => {
    const s = { ...DEFAULT_SETTINGS, themeId: 'lava-lamp' };
    expect(applyTierLimits(s, 'free').themeId).toBe('');
    expect(applyTierLimits(s, 'pro').themeId).toBe('lava-lamp');
    expect(isLockedForTier('free', 'themeId', 'lava-lamp')).toBe(true);
    expect(isLockedForTier('free', 'themeId', '')).toBe(false);
    expect(isLockedForTier('pro', 'themeId', 'lava-lamp')).toBe(false);
  });
});

describe('ThemeStore', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'prajeala-themes-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('lists nothing for a missing folder and resolves built-ins from the palette', () => {
    const store = new ThemeStore(path.join(dir, 'themes'));
    expect(store.list()).toEqual([]);
    expect(store.resolve({ ...DEFAULT_SETTINGS, palette: 'neon' })).toBe(BUILTIN_THEMES.neon);
    expect(store.resolve({ ...DEFAULT_SETTINGS, palette: 'ice', themeId: 'missing' })).toBe(BUILTIN_THEMES.ice);
  });

  it('imports, lists, resolves and exports; skips broken files; avoids id clashes', () => {
    const store = new ThemeStore(path.join(dir, 'themes'));
    const src = path.join(dir, 'Lava Lamp.json');
    writeFileSync(src, JSON.stringify(sample()));
    const first = store.importFile(src);
    expect(first).toMatchObject({ ok: true, theme: { id: 'lava-lamp', name: 'Lava lamp' } });
    expect(existsSync(path.join(store.dir, 'lava-lamp.json'))).toBe(true);
    const second = store.importFile(src);
    expect(second.theme?.id).toBe('lava-lamp-2');
    // a theme named like a built-in never shadows it
    writeFileSync(src, JSON.stringify({ ...sample(), name: 'Neon' }));
    expect(store.importFile(src).theme?.id).toBe('neon-2');
    writeFileSync(path.join(store.dir, 'broken.json'), '{"format":"nope"}');
    writeFileSync(path.join(store.dir, 'Bad Name.json'), JSON.stringify(sample()));
    expect(store.list().map((t) => t.id)).toEqual(['lava-lamp', 'lava-lamp-2', 'neon-2']);
    const resolved = store.resolve({ ...DEFAULT_SETTINGS, themeId: 'lava-lamp-2' });
    expect(resolved.id).toBe('lava-lamp-2'); // file name wins over the JSON id
    expect(resolved.sim.flow).toBe(-1);
    const out = path.join(dir, 'exported.json');
    expect(store.exportTo(BUILTIN_THEMES.electric, out).ok).toBe(true);
    expect(parseThemeJson(readFileSync(out, 'utf8'))).toMatchObject({ ok: true, theme: { id: 'electric' } });
    expect(store.importFile(path.join(dir, 'nope.json'))).toMatchObject({ ok: false, error: expect.stringContaining('read') });
    writeFileSync(src, 'garbage');
    expect(store.importFile(src)).toMatchObject({ ok: false, error: expect.stringContaining('JSON') });
  });

  it('persist=false never touches the disk', () => {
    const store = new ThemeStore(path.join(dir, 'themes'), false);
    writeFileSync(path.join(dir, 't.json'), JSON.stringify(sample()));
    expect(store.importFile(path.join(dir, 't.json')).ok).toBe(false);
    expect(existsSync(path.join(dir, 'themes'))).toBe(false);
    expect(store.list()).toEqual([]);
  });
});
