/**
 * IPC contract between the Electron main process, the preload bridge and the
 * overlay renderer. Pure types + channel names; no runtime Electron imports.
 *
 * Coordinate conventions
 * ─────────────────────
 * Every overlay window covers exactly one display. Positions sent to a renderer
 * are expressed in that window's local CSS pixels (device-independent pixels),
 * i.e. `local = global - display.bounds.{x,y}`. Global screen coordinates are
 * included for debugging and for cross-display effects.
 */
import type { Lang } from './i18n';
import type { LicenseActionResult, LicenseStatus } from './license';
import type { ExternalLink } from './product';
import type { Settings } from './settings';

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface DisplayInfo {
  /** Electron display id. */
  id: number;
  /** Display bounds in global DIP coordinates. */
  bounds: Rect;
  /** Work area (bounds minus taskbar/dock) in global DIP coordinates. */
  workArea: Rect;
  scaleFactor: number;
  isPrimary: boolean;
  /** Index of this display among all displays (stable for the overlay's lifetime). */
  index: number;
  total: number;
}

export interface CursorEvent {
  /** Local coordinates (CSS px) relative to this overlay window. May be outside [0,width)x[0,height). */
  x: number;
  y: number;
  /** Global screen coordinates (DIP). */
  gx: number;
  gy: number;
  /** True when the cursor is inside this overlay's display. */
  inside: boolean;
  /** Milliseconds since app start (monotonic, main-process clock). */
  t: number;
}

export type PointerButton = 'left' | 'right' | 'middle' | 'other';

export interface PointerButtonEvent {
  x: number;
  y: number;
  gx: number;
  gy: number;
  inside: boolean;
  button: PointerButton;
  type: 'down' | 'up';
  t: number;
}

export interface ActiveWindowEvent {
  /** Window title (may be empty when the OS refuses to disclose it). */
  title: string;
  /** Owning application name. */
  app: string;
  /** Window bounds in this overlay's local coordinates (may extend beyond the display). */
  bounds: Rect;
  /** True when the window intersects this display. */
  intersects: boolean;
  /** True if the active window is one of our own windows (settings panel etc.). */
  isSelf: boolean;
}

/** Sent by the renderer once the simulation has (or has not) initialised. */
export interface RendererReadyReport {
  ok: boolean;
  webgl2: boolean;
  /** EXT_color_buffer_float available → half-float render targets. */
  floatTextures: boolean;
  /** WEBGL_debug_renderer_info string when available. */
  renderer: string;
  simWidth: number;
  simHeight: number;
  canvasWidth: number;
  canvasHeight: number;
  error?: string;
}

/** Periodic stats from the renderer (used by --smoke and the debug HUD in main). */
export interface RendererStats {
  frames: number;
  fps: number;
  simWidth: number;
  simHeight: number;
  sparks: number;
}

/** What the renderer needs from the power governor. */
export interface PowerFrame {
  /** Stop lighting new fire; let the field die down and go idle once cold. */
  sleeping: boolean;
}

/** Capabilities detected by the main process (native optional modules). */
export interface HostCapabilities {
  globalClicks: boolean;
  activeWindow: boolean;
  platform: 'win32' | 'darwin' | 'linux' | string;
  smoke: boolean;
}

/** Channel names. Keep them in one place so main/preload/renderer never drift. */
export const IPC = {
  // main → renderer (send)
  cursor: 'prajeala:cursor',
  pointerButton: 'prajeala:pointer-button',
  activeWindow: 'prajeala:active-window',
  settings: 'prajeala:settings',
  display: 'prajeala:display',
  capabilities: 'prajeala:capabilities',
  /** Ask the renderer to emit a one-off burst at local coordinates (used by tray "test" and smoke). */
  testBurst: 'prajeala:test-burst',
  /** A key was pressed somewhere (typing fire). Carries no key data. */
  keyPress: 'prajeala:key-press',
  /** Power governor state (sleeping / eco). */
  power: 'prajeala:power',

  // renderer → main (send)
  ready: 'prajeala:ready',
  stats: 'prajeala:stats',
  log: 'prajeala:log',

  // renderer → main (invoke)
  getSettings: 'prajeala:get-settings',
  getDisplay: 'prajeala:get-display',
  getCapabilities: 'prajeala:get-capabilities',
  updateSettings: 'prajeala:update-settings',
} as const;

export type Unsubscribe = () => void;

/** API exposed to the renderer on `window.prajeala` by the preload script. */
export interface PrajealaApi {
  getSettings(): Promise<Settings>;
  getDisplay(): Promise<DisplayInfo>;
  getCapabilities(): Promise<HostCapabilities>;
  updateSettings(patch: Partial<Settings>): Promise<Settings>;

  onCursor(cb: (e: CursorEvent) => void): Unsubscribe;
  onPointerButton(cb: (e: PointerButtonEvent) => void): Unsubscribe;
  onActiveWindow(cb: (e: ActiveWindowEvent | null) => void): Unsubscribe;
  onSettings(cb: (s: Settings) => void): Unsubscribe;
  onDisplay(cb: (d: DisplayInfo) => void): Unsubscribe;
  onCapabilities(cb: (c: HostCapabilities) => void): Unsubscribe;
  onTestBurst(cb: (p: { x: number; y: number; strength: number }) => void): Unsubscribe;
  onKeyPress(cb: () => void): Unsubscribe;
  onPower(cb: (p: PowerFrame) => void): Unsubscribe;

  reportReady(report: RendererReadyReport): void;
  reportStats(stats: RendererStats): void;
  log(level: 'debug' | 'info' | 'warn' | 'error', message: string): void;
}

// ───────────────────────────── settings window ─────────────────────────────

/** Everything the settings window renders. Pushed again after every change. */
export interface UiState {
  /** Stored settings (the user's choices, Pro ones included). */
  settings: Settings;
  /** What the overlays actually draw (Pro choices replaced when Pro is missing). */
  effective: Settings;
  license: LicenseStatus;
  capabilities: HostCapabilities;
  version: string;
  platform: string;
  /** Number of connected displays. */
  displays: number;
  lang: Lang;
  product: { name: string; priceLabel: string; trialDays: number; hasSponsor: boolean };
  /** Power governor status for the settings window. */
  power: { sleeping: boolean; paused: boolean; eco: boolean; reason: string; gameDisplays: number };
}

/** Which part of the window to bring forward when it opens. */
export type UiFocus = 'pro' | 'welcome' | null;

export const UI_IPC = {
  // window → main (invoke)
  getState: 'prajeala-ui:get-state',
  updateSettings: 'prajeala-ui:update-settings',
  activate: 'prajeala-ui:activate',
  deactivate: 'prajeala-ui:deactivate',
  // window → main (send)
  openLink: 'prajeala-ui:open-link',
  openSettingsFile: 'prajeala-ui:open-settings-file',
  testBurst: 'prajeala-ui:test-burst',
  ready: 'prajeala-ui:ready',
  // main → window
  state: 'prajeala-ui:state',
  focus: 'prajeala-ui:focus',
} as const;

/** API exposed to the settings window on `window.prajealaUi` (separate preload: overlays never see it). */
export interface PrajealaUiApi {
  getState(): Promise<UiState>;
  updateSettings(patch: Partial<Settings>): Promise<UiState>;
  activate(key: string): Promise<LicenseActionResult>;
  deactivate(): Promise<LicenseActionResult>;
  openLink(link: ExternalLink): void;
  openSettingsFile(): void;
  testBurst(): void;
  reportReady(report: { ok: boolean; error?: string }): void;
  onState(cb: (state: UiState) => void): Unsubscribe;
  onFocus(cb: (focus: UiFocus) => void): Unsubscribe;
}

declare global {
  interface Window {
    prajeala: PrajealaApi;
    prajealaUi: PrajealaUiApi;
  }
}
