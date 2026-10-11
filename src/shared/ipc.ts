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
import type { LicenseActionResult, LicenseInfo } from './license';
import type { AudioSource, Settings } from './settings';
import type { ThemeDefinition } from './theme';

export type { AudioSource };

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

/** Capabilities detected by the main process (native optional modules). */
export interface HostCapabilities {
  globalClicks: boolean;
  activeWindow: boolean;
  platform: 'win32' | 'darwin' | 'linux' | string;
  smoke: boolean;
  /** System-audio (loopback) capture can be served by the host (Windows). Optional for older hosts. */
  audioLoopback?: boolean;
}

/** Sound-reactivity state reported by a renderer (shown in the tray). */
export interface AudioStatus {
  state: 'off' | 'starting' | 'active' | 'denied' | 'unavailable' | 'error';
  /** Source actually in use (may differ from the setting after a fallback). */
  source: AudioSource;
  message?: string;
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
  /** Licence snapshot (tier, status); sent to overlays and the licence window. */
  license: 'prajeala:license',
  /** Resolved theme (built-in palette or imported JSON) the overlays should render with. */
  theme: 'prajeala:theme',

  // renderer → main (send)
  ready: 'prajeala:ready',
  stats: 'prajeala:stats',
  log: 'prajeala:log',
  audioStatus: 'prajeala:audio-status',

  // renderer → main (invoke)
  getSettings: 'prajeala:get-settings',
  getDisplay: 'prajeala:get-display',
  getCapabilities: 'prajeala:get-capabilities',
  updateSettings: 'prajeala:update-settings',
  getTheme: 'prajeala:get-theme',
  getLicense: 'prajeala:get-license',
  activateLicense: 'prajeala:activate-license',
  deactivateLicense: 'prajeala:deactivate-license',
  checkLicense: 'prajeala:check-license',
  openBuyPage: 'prajeala:open-buy-page',
  closeLicenseWindow: 'prajeala:close-license-window',
} as const;

export type Unsubscribe = () => void;

/** API exposed to the renderer on `window.prajeala` by the preload script. */
export interface PrajealaApi {
  getSettings(): Promise<Settings>;
  getDisplay(): Promise<DisplayInfo>;
  getCapabilities(): Promise<HostCapabilities>;
  updateSettings(patch: Partial<Settings>): Promise<Settings>;
  /** The theme to render with (the host resolves settings.themeId / palette). */
  getTheme(): Promise<ThemeDefinition>;
  onTheme(cb: (theme: ThemeDefinition) => void): Unsubscribe;

  // Licence (Free / Pro). Overlays only read; the licence window drives the actions.
  getLicense(): Promise<LicenseInfo>;
  /** Verifies (offline) / activates (Lemon Squeezy, online) a pasted key and stores it. */
  activateLicense(key: string): Promise<LicenseActionResult>;
  /** Forgets the stored key (and releases the Lemon Squeezy instance when online). */
  deactivateLicense(): Promise<LicenseActionResult>;
  /** Explicit online re-validation against Lemon Squeezy. */
  checkLicenseOnline(): Promise<LicenseActionResult>;
  openBuyPage(): Promise<void>;
  /** Closes the licence window (no-op elsewhere). */
  closeLicenseWindow(): Promise<void>;
  onLicense(cb: (info: LicenseInfo) => void): Unsubscribe;

  onCursor(cb: (e: CursorEvent) => void): Unsubscribe;
  onPointerButton(cb: (e: PointerButtonEvent) => void): Unsubscribe;
  onActiveWindow(cb: (e: ActiveWindowEvent | null) => void): Unsubscribe;
  onSettings(cb: (s: Settings) => void): Unsubscribe;
  onDisplay(cb: (d: DisplayInfo) => void): Unsubscribe;
  onCapabilities(cb: (c: HostCapabilities) => void): Unsubscribe;
  onTestBurst(cb: (p: { x: number; y: number; strength: number }) => void): Unsubscribe;

  reportReady(report: RendererReadyReport): void;
  reportStats(stats: RendererStats): void;
  reportAudioStatus(status: AudioStatus): void;
  log(level: 'debug' | 'info' | 'warn' | 'error', message: string): void;
}

declare global {
  interface Window {
    prajeala: PrajealaApi;
  }
}
