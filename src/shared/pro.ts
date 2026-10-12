/**
 * Free vs Pro feature split. Pure module.
 *
 * The stored settings are never rewritten when Pro is missing: the main process
 * derives the *effective* settings it sends to the overlays with
 * `effectiveSettings()`, so a user's Pro choices come back the moment a licence
 * (or the trial) is active again. The tray and the settings window use the
 * `is…Locked` helpers to draw the locks.
 */
import { DEFAULT_SETTINGS, INTENSITIES, PALETTES, type Intensity, type Palette, type Settings } from './settings';

/** Palettes included in the free version. Every other palette needs Pro. */
export const FREE_PALETTES: readonly Palette[] = Object.freeze(['classic', 'ember'] as Palette[]);

/** Intensities included in the free version (`inferno` needs Pro). */
export const FREE_INTENSITIES: readonly Intensity[] = Object.freeze(['low', 'medium', 'high'] as Intensity[]);

/** How many displays a free install draws on (the primary one; displays are ordered primary-first). */
export const FREE_MAX_DISPLAYS = 1;

export type ProFeature = 'palettes' | 'inferno' | 'multiMonitor' | 'typingFire' | 'audioEq' | 'torch' | 'zmeu';

export const PRO_FEATURES: readonly ProFeature[] = Object.freeze(['palettes', 'inferno', 'multiMonitor', 'typingFire', 'audioEq', 'torch', 'zmeu'] as ProFeature[]);

/** Ritmul Focului styles that need Pro. */
export function isAudioStyleLocked(style: Settings['audioStyle'], pro: boolean): boolean {
  return !pro && style === 'eq';
}

export const PRO_PALETTES: readonly Palette[] = Object.freeze(PALETTES.filter((p) => !FREE_PALETTES.includes(p)));

export function isPaletteLocked(palette: Palette, pro: boolean): boolean {
  return !pro && !FREE_PALETTES.includes(palette);
}

export function isIntensityLocked(intensity: Intensity, pro: boolean): boolean {
  return !pro && !FREE_INTENSITIES.includes(intensity);
}

/** Number of overlays to create for `displayCount` displays. */
export function allowedDisplayCount(displayCount: number, pro: boolean): number {
  const n = Math.max(0, Math.floor(displayCount));
  return pro ? n : Math.min(n, FREE_MAX_DISPLAYS);
}

/**
 * Settings the renderer actually uses. With Pro they are the stored settings
 * (same object); without it Pro-only values fall back to the closest free ones.
 */
export function effectiveSettings(settings: Settings, pro: boolean): Settings {
  if (pro) return settings;
  const palette = isPaletteLocked(settings.palette, false) ? DEFAULT_SETTINGS.palette : settings.palette;
  const intensity = isIntensityLocked(settings.intensity, false) ? highestFreeIntensity() : settings.intensity;
  const audioStyle = isAudioStyleLocked(settings.audioStyle, false) ? 'pulse' : settings.audioStyle;
  // Every Pro-only field must be part of this identity check, or it leaks to free installs.
  if (palette === settings.palette && intensity === settings.intensity && !settings.typingFire && audioStyle === settings.audioStyle && !settings.torch && !settings.zmeu) {
    return settings;
  }
  return { ...settings, palette, intensity, typingFire: false, audioStyle, torch: false, zmeu: false };
}

/** Pro features the stored settings ask for that the current tier cannot deliver (for “unlock” hints). */
export function lockedFeaturesInUse(settings: Settings, pro: boolean, displayCount: number): ProFeature[] {
  if (pro) return [];
  const out: ProFeature[] = [];
  if (isPaletteLocked(settings.palette, false)) out.push('palettes');
  if (isIntensityLocked(settings.intensity, false)) out.push('inferno');
  if (isAudioStyleLocked(settings.audioStyle, false)) out.push('audioEq');
  if (settings.torch) out.push('torch');
  if (settings.zmeu) out.push('zmeu');
  if (displayCount > FREE_MAX_DISPLAYS) out.push('multiMonitor');
  return out;
}

/** Like `nextIntensity`, but never steps onto a locked intensity (global shortcuts). */
export function nextAllowedIntensity(current: Intensity, direction: 1 | -1, pro: boolean): Intensity {
  const allowed = INTENSITIES.filter((i) => !isIntensityLocked(i, pro));
  const effective = isIntensityLocked(current, pro) ? highestFreeIntensity() : current;
  const i = allowed.indexOf(effective);
  const j = Math.min(allowed.length - 1, Math.max(0, i + direction));
  return allowed[j] ?? effective;
}

function highestFreeIntensity(): Intensity {
  return FREE_INTENSITIES[FREE_INTENSITIES.length - 1] ?? DEFAULT_SETTINGS.intensity;
}

/**
 * Drops the Pro-only choices from a settings patch coming from the UI when Pro
 * is not unlocked (the stored choice stays whatever it was).
 */
export function stripLockedChoices(patch: unknown, pro: boolean): Record<string, unknown> {
  const p: Record<string, unknown> = patch && typeof patch === 'object' && !Array.isArray(patch) ? { ...(patch as Record<string, unknown>) } : {};
  if (pro) return p;
  if (typeof p.palette === 'string' && (PALETTES as readonly string[]).includes(p.palette) && isPaletteLocked(p.palette as Palette, false)) {
    delete p.palette;
  }
  if (typeof p.intensity === 'string' && (INTENSITIES as readonly string[]).includes(p.intensity) && isIntensityLocked(p.intensity as Intensity, false)) {
    delete p.intensity;
  }
  if (p.audioStyle === 'eq') delete p.audioStyle;
  if (p.torch === true) delete p.torch;
  if (p.zmeu === true) delete p.zmeu;
  return p;
}
