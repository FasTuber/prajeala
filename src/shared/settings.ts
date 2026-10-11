/**
 * User-facing settings shared by the main process (tray, persistence) and the
 * renderer (simulation parameters). Pure module: no Electron or DOM imports so
 * it can be unit-tested with Vitest.
 */

export const PALETTES = ['classic', 'ember', 'blue', 'green', 'plasma', 'aurora', 'gold', 'ghost'] as const;
export type Palette = (typeof PALETTES)[number];

export const INTENSITIES = ['low', 'medium', 'high', 'inferno'] as const;
export type Intensity = (typeof INTENSITIES)[number];

export const CURSOR_MODES = ['off', 'halo', 'trail', 'comet'] as const;
export type CursorMode = (typeof CURSOR_MODES)[number];

export interface Settings {
  /** Master switch. When false the overlays stay alive but render nothing. */
  enabled: boolean;
  intensity: Intensity;
  palette: Palette;
  /** How the cursor emits fire. */
  cursorMode: CursorMode;
  /** Explosion of fire on mouse clicks (requires uiohook-napi at runtime). */
  clickBursts: boolean;
  /** Flames around the frame of the focused application window (requires get-windows). */
  burnActiveWindow: boolean;
  /** Flames rising from the bottom edge of every screen. */
  screenBottomFire: boolean;
  /** CPU particle sparks emitted from the cursor and bursts. */
  sparks: boolean;
  /** Simulation resolution relative to the overlay size (0.1 … 1). */
  simScale: number;
  /** Frame-rate cap for the renderer (15 … 240). */
  maxFps: number;
  /** Jacobi iterations for the pressure solve (0 … 64). */
  pressureIterations: number;
  launchAtLogin: boolean;
  /** Small on-screen diagnostics panel (fps, sim size, emitters). */
  showDebugHud: boolean;
}

export const DEFAULT_SETTINGS: Readonly<Settings> = Object.freeze({
  enabled: true,
  intensity: 'medium',
  palette: 'classic',
  cursorMode: 'comet',
  clickBursts: true,
  burnActiveWindow: true,
  screenBottomFire: false,
  sparks: true,
  simScale: 0.25,
  maxFps: 60,
  pressureIterations: 12,
  launchAtLogin: false,
  showDebugHud: false,
});

export const SETTINGS_LIMITS = Object.freeze({
  simScale: { min: 0.1, max: 1 },
  maxFps: { min: 15, max: 240 },
  pressureIterations: { min: 0, max: 64 },
});

/** Tunables that each intensity preset feeds into the simulation. */
export interface IntensityPreset {
  /** Heat injected per cursor splat. */
  heat: number;
  /** How strongly cursor movement pushes the fluid. */
  velocity: number;
  /** Splat radius in simulation-space units (fraction of the short side). */
  radius: number;
  /** Per-second retention of temperature (closer to 1 → flames live longer). */
  heatDissipation: number;
  /** Per-second retention of velocity. */
  velocityDissipation: number;
  /** Upward force applied to hot cells. */
  buoyancy: number;
  /** Vorticity confinement strength (swirl). */
  curl: number;
  /** Heat per click burst. */
  burst: number;
  /** Ambient emitter strength for window frame / screen bottom. */
  ambient: number;
  /** Max simultaneous spark particles. */
  sparkBudget: number;
}

export const INTENSITY_PRESETS: Readonly<Record<Intensity, IntensityPreset>> = Object.freeze({
  low: {
    heat: 0.35,
    velocity: 0.6,
    radius: 0.018,
    heatDissipation: 0.9,
    velocityDissipation: 0.94,
    buoyancy: 0.8,
    curl: 12,
    burst: 1.2,
    ambient: 0.35,
    sparkBudget: 120,
  },
  medium: {
    heat: 0.6,
    velocity: 1.0,
    radius: 0.024,
    heatDissipation: 0.93,
    velocityDissipation: 0.96,
    buoyancy: 1.2,
    curl: 22,
    burst: 2.0,
    ambient: 0.6,
    sparkBudget: 300,
  },
  high: {
    heat: 0.9,
    velocity: 1.5,
    radius: 0.032,
    heatDissipation: 0.955,
    velocityDissipation: 0.975,
    buoyancy: 1.6,
    curl: 32,
    burst: 3.0,
    ambient: 0.9,
    sparkBudget: 600,
  },
  inferno: {
    heat: 1.3,
    velocity: 2.2,
    radius: 0.045,
    heatDissipation: 0.975,
    velocityDissipation: 0.985,
    buoyancy: 2.2,
    curl: 45,
    burst: 4.5,
    ambient: 1.4,
    sparkBudget: 1200,
  },
});

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function pickBool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function pickNumber(value: unknown, fallback: number, min: number, max: number): number {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  return Number.isFinite(n) ? clamp(n, min, max) : fallback;
}

function pickEnum<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value) ? (value as T) : fallback;
}

/**
 * Coerces any JSON-ish input into a valid Settings object, filling missing or
 * invalid fields from DEFAULT_SETTINGS. Never throws.
 */
export function normalizeSettings(input: unknown): Settings {
  const src: Record<string, unknown> =
    input && typeof input === 'object' && !Array.isArray(input) ? (input as Record<string, unknown>) : {};
  const d = DEFAULT_SETTINGS;
  const L = SETTINGS_LIMITS;
  return {
    enabled: pickBool(src.enabled, d.enabled),
    intensity: pickEnum(src.intensity, INTENSITIES, d.intensity),
    palette: pickEnum(src.palette, PALETTES, d.palette),
    cursorMode: pickEnum(src.cursorMode, CURSOR_MODES, d.cursorMode),
    clickBursts: pickBool(src.clickBursts, d.clickBursts),
    burnActiveWindow: pickBool(src.burnActiveWindow, d.burnActiveWindow),
    screenBottomFire: pickBool(src.screenBottomFire, d.screenBottomFire),
    sparks: pickBool(src.sparks, d.sparks),
    simScale: pickNumber(src.simScale, d.simScale, L.simScale.min, L.simScale.max),
    maxFps: Math.round(pickNumber(src.maxFps, d.maxFps, L.maxFps.min, L.maxFps.max)),
    pressureIterations: Math.round(
      pickNumber(src.pressureIterations, d.pressureIterations, L.pressureIterations.min, L.pressureIterations.max),
    ),
    launchAtLogin: pickBool(src.launchAtLogin, d.launchAtLogin),
    showDebugHud: pickBool(src.showDebugHud, d.showDebugHud),
  };
}

/** Shallow-merges a partial update into existing settings and re-validates. */
export function mergeSettings(current: Settings, patch: Partial<Settings> | unknown): Settings {
  const p = patch && typeof patch === 'object' ? (patch as Record<string, unknown>) : {};
  return normalizeSettings({ ...current, ...p });
}

export function nextIntensity(current: Intensity, direction: 1 | -1): Intensity {
  const i = INTENSITIES.indexOf(current);
  const j = clamp(i + direction, 0, INTENSITIES.length - 1);
  return INTENSITIES[j] ?? current;
}
