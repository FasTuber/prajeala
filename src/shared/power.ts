/**
 * Power governor rules ("Ralanti"): when the fire may sleep, pause or run a
 * lighter profile. Pure module — the main process feeds it OS signals
 * (powerMonitor, input activity, the focused window) and applies the result.
 */
import type { Rect } from './ipc';
import type { Settings } from './settings';

export interface PowerInputs {
  /** Milliseconds since the last input this app saw (cursor move, click, key). */
  msSinceInput: number;
  /** powerMonitor.getSystemIdleTime() in seconds (covers input uiohook does not see). */
  systemIdleSeconds: number;
  onBattery: boolean;
  /** Screen locked or system suspended. */
  locked: boolean;
}

export interface PowerState {
  /** Nothing new is lit; the renderer lets the fire die down and stops drawing once it is cold. */
  sleeping: boolean;
  /** Overlays hidden entirely (locked, suspended, or battery mode "pause"). */
  paused: boolean;
  /** Lighter simulation profile (battery mode "eco"). */
  eco: boolean;
  /** Why the fire is paused/sleeping, for the tray tooltip and the settings window. */
  reason: 'none' | 'idle' | 'locked' | 'battery';
}

export const AWAKE: Readonly<PowerState> = Object.freeze({ sleeping: false, paused: false, eco: false, reason: 'none' });

export function powerState(settings: Settings, input: PowerInputs): PowerState {
  if (input.locked) return { sleeping: true, paused: true, eco: false, reason: 'locked' };
  if (input.onBattery && settings.batteryMode === 'pause') return { sleeping: true, paused: true, eco: false, reason: 'battery' };
  const eco = input.onBattery && settings.batteryMode === 'eco';
  const idleMs = Math.min(Math.max(0, input.msSinceInput), Math.max(0, input.systemIdleSeconds) * 1000);
  const sleeping = settings.idleSleep && idleMs >= settings.idleSleepSeconds * 1000;
  return { sleeping, paused: false, eco, reason: sleeping ? 'idle' : 'none' };
}

export function powerStatesEqual(a: PowerState, b: PowerState): boolean {
  return a.sleeping === b.sleeping && a.paused === b.paused && a.eco === b.eco && a.reason === b.reason;
}

/** Eco profile: 30 fps, 70 % simulation resolution, 8 pressure iterations. */
export function applyPowerProfile(settings: Settings, power: PowerState): Settings {
  if (!power.eco) return settings;
  return {
    ...settings,
    maxFps: Math.min(settings.maxFps, 30),
    simScale: Math.max(0.1, Math.round(settings.simScale * 0.7 * 1000) / 1000),
    pressureIterations: Math.min(settings.pressureIterations, 8),
  };
}

/**
 * A window counts as fullscreen on a display when it covers the display's whole
 * bounds (±2 px: borderless fullscreen games and F11 browsers). Maximised windows
 * stop at the work area, so they do not match unless the taskbar auto-hides.
 */
export function coversDisplay(window: Rect, display: Rect, tolerance = 2): boolean {
  return (
    window.x <= display.x + tolerance &&
    window.y <= display.y + tolerance &&
    window.x + window.width >= display.x + display.width - tolerance &&
    window.y + window.height >= display.y + display.height - tolerance
  );
}

/**
 * The desktop itself (wallpaper/icons window) as reported by the active-window
 * module: it spans the whole screen when you click on it, but it is not a
 * fullscreen app and must never trigger game mode.
 */
export function isDesktopShell(app: string, title: string, platform: string, path = ''): boolean {
  const a = app.trim().toLowerCase();
  const t = title.trim();
  if (platform === 'win32') {
    // The app name is explorer's localised description ("Explorateur Windows"…): trust the executable.
    const exe = path.split(/[\\/]/).pop()?.toLowerCase() ?? '';
    const explorer = exe === 'explorer.exe' || /^(windows )?explorer(\.exe)?$/.test(a);
    return t === 'Program Manager' || (explorer && t === '');
  }
  if (platform === 'darwin') return a === 'finder' && t === '';
  return /^(xfdesktop|nautilus-desktop|desktop_window|pcmanfm|pcmanfm-qt|caja|nemo-desktop|ding|plasmashell)$/.test(a) || t === 'Desktop';
}
