/**
 * Themes: a palette plus the simulation / look knobs that make ice drip,
 * electricity crackle and neon glow. Every built-in palette has a theme, and
 * themes can be exported to / imported from a small JSON file
 * (`"format": "prajeala-theme"`, version 1). Pure module, unit-tested.
 */
import { PALETTE_DEFINITIONS, type ColorStop, type PaletteDefinition } from './palettes';
import { PALETTES, THEME_ID_RE, type Palette } from './settings';

export const THEME_FORMAT = 'prajeala-theme';
export const THEME_VERSION = 1;

/** Multipliers over the intensity preset (1 = the classic fire). */
export interface ThemeSim {
  /** Upward force on hot cells; < 0 makes the plume sink (water). */
  buoyancy: number;
  /** Vorticity confinement (swirl). */
  curl: number;
  /** Cooling rate: higher = shorter-lived flames. */
  cooling: number;
  /** Heat loss per second: higher = fades faster. */
  heatLoss: number;
  /** Velocity loss per second: lower = more viscous / coasting. */
  velocityLoss: number;
  /** Direction of the emitters' vertical push: 1 up, -1 down, 0 none. */
  flow: number;
  /** Speed limit of the fluid. */
  maxSpeed: number;
}

export interface ThemeLook {
  /** Noise erosion/detail (0..1): ragged tongues vs smooth tubes. */
  detail: number;
  /** Glow halo strength. */
  glow: number;
  /** Smoke opacity. */
  smoke: number;
  /** Smoke tint, 0..1. */
  smokeColor: readonly [number, number, number];
  /** How fast the detail noise scrolls (1 = classic). */
  noiseSpeed: number;
}

export interface ThemeDefinition {
  format: typeof THEME_FORMAT;
  version: typeof THEME_VERSION;
  /** Slug (file name for imported themes, palette name for built-ins). */
  id: string;
  name: string;
  /** Built-in palette this theme derives from, when any. */
  basePalette?: Palette;
  stops: readonly ColorStop[];
  spark: readonly [number, number, number];
  sim: ThemeSim;
  look: ThemeLook;
}

export const DEFAULT_THEME_SIM: Readonly<ThemeSim> = Object.freeze({
  buoyancy: 1,
  curl: 1,
  cooling: 1,
  heatLoss: 1,
  velocityLoss: 1,
  flow: 1,
  maxSpeed: 1,
});

export const DEFAULT_THEME_LOOK: Readonly<ThemeLook> = Object.freeze({
  detail: 0.9,
  glow: 0.3,
  smoke: 0.14,
  smokeColor: [0.07, 0.06, 0.06] as const,
  noiseSpeed: 1,
});

const SIM_LIMITS: Record<keyof ThemeSim, readonly [number, number]> = {
  buoyancy: [-3, 4],
  curl: [0, 4],
  cooling: [0.1, 6],
  heatLoss: [0.1, 6],
  velocityLoss: [0.1, 6],
  flow: [-1.5, 1.5],
  maxSpeed: [0.2, 3],
};

const LOOK_LIMITS = {
  detail: [0, 1],
  glow: [0, 2],
  smoke: [0, 1],
  noiseSpeed: [0, 4],
} as const;

/** Per-palette flavour of the built-in themes (classic stays at the defaults). */
const BUILTIN_FLAVOUR: Partial<Record<Palette, { sim?: Partial<ThemeSim>; look?: Partial<ThemeLook> }>> = {
  ember: {
    sim: { buoyancy: 0.8, cooling: 0.85, heatLoss: 0.8 },
    look: { glow: 0.45, smoke: 0.22 },
  },
  plasma: {
    sim: { curl: 1.4, maxSpeed: 1.2 },
    look: { glow: 0.5, noiseSpeed: 1.3 },
  },
  ice: {
    // Cold vapour that sinks and drips instead of rising; viscous, smooth, misty.
    sim: { buoyancy: -0.35, curl: 0.45, cooling: 0.55, heatLoss: 0.6, velocityLoss: 1.6, flow: -0.55, maxSpeed: 0.8 },
    look: { detail: 0.45, glow: 0.35, smoke: 0.35, smokeColor: [0.5, 0.7, 0.9], noiseSpeed: 0.45 },
  },
  electric: {
    // Short, jittery arcs: violent swirl, quick cooling, hardly any lift, no smoke.
    sim: { buoyancy: 0.35, curl: 2.1, cooling: 1.4, heatLoss: 1.1, velocityLoss: 0.6, flow: 0.35, maxSpeed: 1.6 },
    look: { detail: 0.8, glow: 0.7, smoke: 0, noiseSpeed: 2.6 },
  },
  neon: {
    // Smooth glowing tubes: little erosion, strong halo, slow drift.
    sim: { buoyancy: 0.6, curl: 0.7, cooling: 0.8, heatLoss: 0.75, velocityLoss: 1.2, maxSpeed: 0.9 },
    look: { detail: 0.35, glow: 0.9, smoke: 0.05, smokeColor: [0.25, 0.05, 0.3], noiseSpeed: 0.7 },
  },
};

export function themeFromPalette(palette: Palette): ThemeDefinition {
  const def: PaletteDefinition = PALETTE_DEFINITIONS[palette];
  const flavour = BUILTIN_FLAVOUR[palette] ?? {};
  return {
    format: THEME_FORMAT,
    version: THEME_VERSION,
    id: palette,
    name: def.label,
    basePalette: palette,
    stops: def.stops.map((s) => [...s] as unknown as ColorStop),
    spark: [...def.spark] as [number, number, number],
    sim: { ...DEFAULT_THEME_SIM, ...flavour.sim },
    look: { ...DEFAULT_THEME_LOOK, ...flavour.look },
  };
}

export const BUILTIN_THEMES: Readonly<Record<Palette, ThemeDefinition>> = Object.freeze(
  Object.fromEntries(PALETTES.map((p) => [p, Object.freeze(themeFromPalette(p))])) as Record<Palette, ThemeDefinition>,
);

export type ThemeValidation = { ok: true; theme: ThemeDefinition } | { ok: false; error: string };

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function color3(v: unknown): [number, number, number] | null {
  if (!Array.isArray(v) || v.length !== 3) return null;
  const out: number[] = [];
  for (const c of v) {
    const n = num(c);
    if (n === null) return null;
    out.push(clamp(n, 0, 1));
  }
  return out as [number, number, number];
}

/** Turns a free-form name into a theme id. Returns '' when nothing usable is left. */
export function slugify(name: string): string {
  const slug = name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
    .replace(/-+$/g, '');
  return THEME_ID_RE.test(slug) ? slug : '';
}

/**
 * Validates a parsed JSON value as a theme. Lenient where it is safe (missing
 * sim/look fields fall back to the defaults, numbers are clamped) and strict
 * where it matters (format, stops, colours).
 */
export function validateTheme(input: unknown, fallbackId = ''): ThemeValidation {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { ok: false, error: 'not a JSON object' };
  const t = input as Record<string, unknown>;
  if (t.format !== THEME_FORMAT) return { ok: false, error: `"format" must be "${THEME_FORMAT}"` };
  if (t.version !== THEME_VERSION) return { ok: false, error: `unsupported theme version ${String(t.version)} (expected ${THEME_VERSION})` };
  const name = typeof t.name === 'string' ? t.name.trim().slice(0, 80) : '';
  if (!name) return { ok: false, error: '"name" is required' };
  const id = typeof t.id === 'string' && THEME_ID_RE.test(t.id) ? t.id : slugify(name) || fallbackId;
  if (!id) return { ok: false, error: 'could not derive an id from the name' };

  if (!Array.isArray(t.stops) || t.stops.length < 2 || t.stops.length > 32) return { ok: false, error: '"stops" must hold 2–32 entries' };
  const stops: ColorStop[] = [];
  let prevT = -1;
  for (let i = 0; i < t.stops.length; i++) {
    const s = t.stops[i];
    if (!Array.isArray(s) || s.length !== 4) return { ok: false, error: `stop ${i} must be [t, r, g, b]` };
    const vals = s.map(num);
    if (vals.some((v) => v === null)) return { ok: false, error: `stop ${i} has a non-numeric value` };
    const [st, r, g, b] = vals as number[];
    if (st! < 0 || st! > 1 || st! <= prevT) return { ok: false, error: `stop ${i}: t must increase strictly within 0..1` };
    prevT = st!;
    stops.push([st!, clamp(r!, 0, 1), clamp(g!, 0, 1), clamp(b!, 0, 1)]);
  }
  if (stops[0]![0] !== 0 || stops[stops.length - 1]![0] !== 1) return { ok: false, error: 'stops must start at t=0 and end at t=1' };

  const spark = color3(t.spark) ?? ([stops[stops.length - 1]![1], stops[stops.length - 1]![2], stops[stops.length - 1]![3]] as [number, number, number]);

  const simIn = (t.sim && typeof t.sim === 'object' ? t.sim : {}) as Record<string, unknown>;
  const sim: ThemeSim = { ...DEFAULT_THEME_SIM };
  for (const key of Object.keys(SIM_LIMITS) as (keyof ThemeSim)[]) {
    const v = num(simIn[key]);
    if (v !== null) sim[key] = clamp(v, SIM_LIMITS[key][0], SIM_LIMITS[key][1]);
  }
  const lookIn = (t.look && typeof t.look === 'object' ? t.look : {}) as Record<string, unknown>;
  const look: ThemeLook = { ...DEFAULT_THEME_LOOK };
  for (const key of Object.keys(LOOK_LIMITS) as (keyof typeof LOOK_LIMITS)[]) {
    const v = num(lookIn[key]);
    if (v !== null) look[key] = clamp(v, LOOK_LIMITS[key][0], LOOK_LIMITS[key][1]);
  }
  const smokeColor = color3(lookIn.smokeColor);
  if (smokeColor) look.smokeColor = smokeColor;

  const basePalette = typeof t.basePalette === 'string' && (PALETTES as readonly string[]).includes(t.basePalette) ? (t.basePalette as Palette) : undefined;
  const theme: ThemeDefinition = { format: THEME_FORMAT, version: THEME_VERSION, id, name, stops, spark, sim, look };
  if (basePalette) theme.basePalette = basePalette;
  return { ok: true, theme };
}

/** Parses JSON text and validates it. */
export function parseThemeJson(text: string, fallbackId = ''): ThemeValidation {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    return { ok: false, error: `invalid JSON: ${err instanceof Error ? err.message : String(err)}` };
  }
  return validateTheme(parsed, fallbackId);
}

/** Pretty JSON for export (stable key order, 2-space indent). */
export function themeToJson(theme: ThemeDefinition): string {
  const out: Record<string, unknown> = {
    format: THEME_FORMAT,
    version: THEME_VERSION,
    id: theme.id,
    name: theme.name,
  };
  if (theme.basePalette) out.basePalette = theme.basePalette;
  out.stops = theme.stops.map((s) => [...s]);
  out.spark = [...theme.spark];
  out.sim = { ...theme.sim };
  out.look = { ...theme.look, smokeColor: [...theme.look.smokeColor] };
  return JSON.stringify(out, null, 2) + '\n';
}

/** The palette-shaped view of a theme (what the LUT baker and spark renderer need). */
export function themePalette(theme: ThemeDefinition): PaletteDefinition {
  return { name: theme.basePalette ?? 'classic', label: theme.name, stops: theme.stops, spark: theme.spark };
}

export function themesEqual(a: ThemeDefinition | null, b: ThemeDefinition | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return themeToJson(a) === themeToJson(b);
}
