/**
 * Tracks the focused application window through the optional `get-windows`
 * module and reports `{ title, app, bounds, id, pid }` in global DIP
 * coordinates whenever it changes (id, bounds, title or app).
 *
 * Coordinate assumptions (see `toDipRect`):
 *  - macOS: get-windows returns points, i.e. already DIP.
 *  - Windows: get-windows returns physical pixels → `screen.screenToDipRect`.
 *  - Linux/X11: xwininfo reports physical pixels; Electron's DIP = physical /
 *    scale factor. There is no per-rect API, so we divide by the primary
 *    display's scale factor (mixed-DPI X11 setups are rare and usually use 1×).
 *
 * macOS permissions: titles need Screen Recording and `url` needs
 * Accessibility; we pass both checks as `false` so the app never nags the user —
 * bounds are still returned (title comes back empty).
 */
import { screen } from 'electron';
import type { Rect } from '../shared/ipc';
import { rectsEqual } from './geometry';
import { createLogger } from './log';

const log = createLogger('active-window');

export interface ActiveWindowInfo {
  id: number;
  title: string;
  app: string;
  pid: number;
  /** Global DIP bounds. */
  bounds: Rect;
}

/** Minimal shape of get-windows (typed locally so a missing optional dep never breaks typecheck). */
interface GetWindowsResult {
  id: number;
  title: string;
  bounds: { x: number; y: number; width: number; height: number };
  owner: { name: string; processId: number; path?: string };
}
interface GetWindowsOptions {
  accessibilityPermission?: boolean;
  screenRecordingPermission?: boolean;
}
interface GetWindowsModule {
  activeWindow(options?: GetWindowsOptions): Promise<GetWindowsResult | undefined>;
}

export interface ActiveWindowTrackerOptions {
  /** Polling rate in Hz. */
  hz: number;
  /** When false the module is never imported (`--no-active-window`). */
  allowed: boolean;
  onChange(info: ActiveWindowInfo | null): void;
}

const ERROR_LOG_INTERVAL_MS = 30_000;
const BACKOFF_AFTER_FAILURES = 10;
const BACKOFF_INTERVAL_MS = 2_000;

export class ActiveWindowTracker {
  private mod: GetWindowsModule | null = null;
  private timer: NodeJS.Timeout | null = null;
  private enabled = false;
  private polling = false;
  private last: ActiveWindowInfo | null = null;
  private hasReported = false;
  private consecutiveFailures = 0;
  private lastErrorLogAt = -Infinity;
  private stopped = false;

  constructor(private readonly options: ActiveWindowTrackerOptions) {}

  /** Tries to import get-windows. Resolves to the capability flag. */
  async init(): Promise<boolean> {
    if (!this.options.allowed) {
      log.info('active-window tracking disabled by --no-active-window');
      return false;
    }
    try {
      // Non-literal specifier keeps esbuild/TypeScript from resolving the optional dependency.
      const name = 'get-windows';
      const mod = (await import(name)) as Partial<GetWindowsModule>;
      if (typeof mod.activeWindow !== 'function') throw new Error('activeWindow export missing');
      this.mod = mod as GetWindowsModule;
      log.info('get-windows loaded (fire on the active window enabled)');
      return true;
    } catch (err) {
      log.info('get-windows not available, active-window fire disabled:', (err as Error).message);
      this.mod = null;
      return false;
    }
  }

  get available(): boolean {
    return this.mod !== null;
  }

  /** Starts or stops polling (bound to settings.burnActiveWindow). */
  setEnabled(enabled: boolean): void {
    if (this.stopped || !this.mod) return;
    if (enabled === this.enabled) return;
    this.enabled = enabled;
    if (enabled) {
      log.debug('polling started');
      this.schedule(0);
    } else {
      log.debug('polling stopped');
      this.clearTimer();
      if (this.last !== null || !this.hasReported) {
        this.last = null;
        this.hasReported = true;
        this.options.onChange(null);
      }
    }
  }

  stop(): void {
    this.stopped = true;
    this.enabled = false;
    this.clearTimer();
  }

  private clearTimer(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private schedule(delayMs: number): void {
    this.clearTimer();
    if (!this.enabled || this.stopped) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.poll();
    }, delayMs);
    this.timer.unref?.();
  }

  private intervalMs(): number {
    const base = Math.max(16, Math.round(1000 / Math.max(0.1, this.options.hz)));
    return this.consecutiveFailures >= BACKOFF_AFTER_FAILURES ? Math.max(base, BACKOFF_INTERVAL_MS) : base;
  }

  private async poll(): Promise<void> {
    if (this.polling || !this.enabled || !this.mod) return;
    this.polling = true;
    try {
      const result = await this.mod.activeWindow(
        process.platform === 'darwin' ? { accessibilityPermission: false, screenRecordingPermission: false } : undefined,
      );
      this.consecutiveFailures = 0;
      this.report(result ? toInfo(result) : null);
    } catch (err) {
      this.consecutiveFailures += 1;
      const now = Date.now();
      if (now - this.lastErrorLogAt > ERROR_LOG_INTERVAL_MS) {
        this.lastErrorLogAt = now;
        log.warn(`activeWindow() failed (${this.consecutiveFailures}×):`, (err as Error).message);
      }
      this.report(null);
    } finally {
      this.polling = false;
      this.schedule(this.intervalMs());
    }
  }

  private report(info: ActiveWindowInfo | null): void {
    if (!this.hasReported || !sameWindow(this.last, info)) {
      this.hasReported = true;
      this.last = info;
      this.options.onChange(info);
    }
  }
}

function sameWindow(a: ActiveWindowInfo | null, b: ActiveWindowInfo | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.id === b.id && a.title === b.title && a.app === b.app && rectsEqual(a.bounds, b.bounds);
}

function toInfo(r: GetWindowsResult): ActiveWindowInfo {
  return {
    id: typeof r.id === 'number' ? r.id : 0,
    title: typeof r.title === 'string' ? r.title : '',
    app: r.owner && typeof r.owner.name === 'string' ? r.owner.name : '',
    pid: r.owner && typeof r.owner.processId === 'number' ? r.owner.processId : -1,
    bounds: toDipRect(r.bounds),
  };
}

/** Converts get-windows bounds to Electron's global DIP coordinate space. */
export function toDipRect(b: { x: number; y: number; width: number; height: number }): Rect {
  const rect: Rect = {
    x: Number(b.x) || 0,
    y: Number(b.y) || 0,
    width: Math.max(0, Number(b.width) || 0),
    height: Math.max(0, Number(b.height) || 0),
  };
  if (process.platform === 'win32') {
    // Physical pixels → DIP (per-monitor aware; needs a window-less conversion).
    try {
      return screen.screenToDipRect(null, rect);
    } catch {
      const scale = screen.getPrimaryDisplay().scaleFactor || 1;
      return { x: rect.x / scale, y: rect.y / scale, width: rect.width / scale, height: rect.height / scale };
    }
  }
  if (process.platform === 'linux') {
    // X11 reports physical pixels; assume one global scale factor (the primary display's).
    let scale: number;
    try {
      scale = screen.getPrimaryDisplay().scaleFactor || 1;
    } catch {
      scale = 1;
    }
    if (scale !== 1) {
      return { x: rect.x / scale, y: rect.y / scale, width: rect.width / scale, height: rect.height / scale };
    }
  }
  // macOS: already in points (DIP).
  return rect;
}
