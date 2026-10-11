/**
 * Global cursor tracking.
 *
 * Baseline (every platform, no permissions): poll `screen.getCursorScreenPoint()`
 * at ~120 Hz and emit a sample whenever the position changed.
 *
 * Optional low-latency path: `uiohook-napi`, when it loads and starts, gives us
 * `mousemove` (used only as a trigger to re-sample the cursor through Electron,
 * so coordinates are always DIP and deduplicated exactly against the poller;
 * uiohook's own x/y are physical pixels on Windows/X11) and `mousedown`/`mouseup`
 * for click bursts. If the module is missing or fails to start (headless Linux,
 * Wayland, missing macOS Accessibility permission) we log once and carry on with
 * polling only.
 */
import { screen } from 'electron';
import type { PointerButton } from '../shared/ipc';
import type { Point } from './geometry';
import { createLogger } from './log';

const log = createLogger('cursor');

/** Minimal shape of uiohook-napi (typed locally so a missing optional dep never breaks typecheck). */
interface UiohookMouseEvent {
  x: number;
  y: number;
  button: unknown;
}
interface UiohookLike {
  on(event: 'mousemove' | 'mousedown' | 'mouseup' | 'keydown', listener: (e: UiohookMouseEvent) => void): unknown;
  removeAllListeners?(event?: string): unknown;
  start(): void;
  stop(): void;
}

export interface CursorSample extends Point {
  /** performance.now() in the main process. */
  t: number;
}

export interface CursorTrackerOptions {
  /** Polling rate in Hz. */
  hz: number;
  /** Try to load uiohook-napi for mouse buttons / lower latency. */
  hooks: boolean;
  onMove(sample: CursorSample): void;
  onButton(sample: CursorSample, button: PointerButton, type: 'down' | 'up'): void;
  /** A key went down somewhere (which key is never read or forwarded). */
  onKey?(): void;
}

/** Minimum spacing between two hook-triggered samples (1000 Hz mice would otherwise flood IPC). */
const MIN_HOOK_INTERVAL_MS = 2;

export class CursorTracker {
  private timer: NodeJS.Timeout | null = null;
  private last: Point | null = null;
  private lastSentAt = -Infinity;
  private hook: UiohookLike | null = null;
  private hookStarted = false;
  private running = false;

  constructor(private readonly options: CursorTrackerOptions) {}

  /** True when global mouse buttons are delivered (uiohook running). */
  get globalClicks(): boolean {
    return this.hookStarted;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    const interval = Math.max(1, Math.round(1000 / Math.max(1, this.options.hz)));
    this.timer = setInterval(() => this.sample(false), interval);
    // Don't keep the process alive just for the poller (quit sequences stay clean).
    this.timer.unref?.();
    if (this.options.hooks) this.startHooks();
    log.info(`polling cursor every ${interval} ms${this.hookStarted ? ' + uiohook events' : ''}`);
  }

  stop(): void {
    this.running = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.stopHooks();
  }

  /** Current cursor position in DIP (fresh read). */
  readPoint(): Point | null {
    try {
      const p = screen.getCursorScreenPoint();
      return { x: p.x, y: p.y };
    } catch (err) {
      log.debug('getCursorScreenPoint failed:', err);
      return null;
    }
  }

  private sample(fromHook: boolean): void {
    if (!this.running) return;
    const now = performance.now();
    if (fromHook && now - this.lastSentAt < MIN_HOOK_INTERVAL_MS) return;
    const p = this.readPoint();
    if (!p) return;
    if (this.last && this.last.x === p.x && this.last.y === p.y) return;
    this.last = p;
    this.lastSentAt = now;
    this.options.onMove({ x: p.x, y: p.y, t: now });
  }

  private startHooks(): void {
    let mod: { uIOhook?: UiohookLike } | undefined;
    try {
      // Non-literal specifier keeps esbuild/TypeScript from resolving the optional dependency.
      const name = 'uiohook-napi';
      mod = require(name) as { uIOhook?: UiohookLike };
    } catch (err) {
      log.info('uiohook-napi not available, click bursts disabled:', (err as Error).message);
      return;
    }
    const hook = mod?.uIOhook;
    if (!hook || typeof hook.start !== 'function') {
      log.info('uiohook-napi loaded but has no uIOhook export; click bursts disabled');
      return;
    }
    try {
      hook.on('mousemove', () => this.sample(true));
      hook.on('mousedown', (e) => this.onButton(e, 'down'));
      hook.on('mouseup', (e) => this.onButton(e, 'up'));
      // Only the fact that a key was pressed is used; the key itself is ignored.
      hook.on('keydown', () => {
        if (this.running) this.options.onKey?.();
      });
      hook.start();
      this.hook = hook;
      this.hookStarted = true;
      log.info('uiohook-napi started (global mouse buttons enabled)');
    } catch (err) {
      log.warn('uiohook-napi failed to start, click bursts disabled:', (err as Error).message);
      try {
        hook.removeAllListeners?.();
      } catch {
        /* ignore */
      }
      this.hook = null;
      this.hookStarted = false;
    }
  }

  private stopHooks(): void {
    const hook = this.hook;
    this.hook = null;
    this.hookStarted = false;
    if (!hook) return;
    try {
      hook.removeAllListeners?.();
      hook.stop();
      log.debug('uiohook-napi stopped');
    } catch (err) {
      log.debug('uiohook stop failed:', err);
    }
  }

  private onButton(e: UiohookMouseEvent, type: 'down' | 'up'): void {
    if (!this.running) return;
    const now = performance.now();
    // Prefer Electron's DIP cursor position; fall back to the hook's coordinates.
    const p = this.readPoint() ?? { x: e.x, y: e.y };
    this.last = p;
    this.options.onButton({ x: p.x, y: p.y, t: now }, mapButton(e.button), type);
  }
}

export function mapButton(button: unknown): PointerButton {
  switch (button) {
    case 1:
      return 'left';
    case 2:
      return 'right';
    case 3:
      return 'middle';
    default:
      return 'other';
  }
}
