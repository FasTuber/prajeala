/**
 * One transparent, click-through, always-on-top BrowserWindow per display.
 *
 * The manager owns the display → window map, recreates overlays when the
 * display topology changes, answers the renderer's invoke channels and relays
 * its `ready` / `stats` / `log` messages as events:
 *
 *   overlays.on('ready', (overlay, report))
 *   overlays.on('stats', (overlay, stats))
 *   overlays.on('log',   (overlay, level, message))
 *   overlays.on('zmeu-exited', (overlay, report))   // validated ZmeuExitReport
 */
import { EventEmitter } from 'node:events';
import { pathToFileURL } from 'node:url';
import { app, BrowserWindow, ipcMain, screen, type Display, type IpcMainEvent, type WebContents } from 'electron';
import {
  IPC,
  type DisplayInfo,
  type HostCapabilities,
  type RendererReadyReport,
  type RendererStats,
} from '../shared/ipc';
import type { Settings } from '../shared/settings';
import { sanitizeZmeuExit, type ZmeuHomeFrame } from '../shared/zmeu';
import { createLogger, type LogLevel } from './log';

const log = createLogger('overlay');

export interface OverlayContext {
  preloadPath: string;
  rendererHtmlPath: string;
  /** Undocumented `--renderer-url=` override (tests). */
  rendererUrl: string | null;
  /** Append `?hud=1` to the renderer URL. */
  debugHud: boolean;
  /** Restrict to one display index. */
  displayIndex: number | null;
  /** Settings the overlays draw with (already reduced to what the licence allows). */
  getSettings(): Settings;
  updateSettings(patch: unknown): Settings;
  getCapabilities(): HostCapabilities;
  /** How many displays get an overlay (primary first); Infinity = all. */
  maxDisplays(): number;
  /** Zmeul: the home frame for this overlay (answers the renderer's pull at init). */
  getZmeuHome(overlay: Overlay): ZmeuHomeFrame;
}

export interface Overlay {
  readonly id: number;
  readonly info: DisplayInfo;
  readonly window: BrowserWindow;
  loaded: boolean;
  shown: boolean;
  crashes: number;
  /** Last visibility told to the renderer (hidden overlays must stop simulating). */
  hostHidden: boolean | null;
}

export type PayloadFactory<T> = (info: DisplayInfo, overlay: Overlay) => T | undefined;

const REBUILD_DEBOUNCE_MS = 350;
const SHOW_FALLBACK_MS = 1500;
const MAX_CRASH_RELOADS = 3;

export class OverlayManager extends EventEmitter {
  private readonly overlays = new Map<number, Overlay>();
  private rebuildTimer: NodeJS.Timeout | null = null;
  private visible = true;
  /** Displays whose overlay is hidden regardless of `visible` (game mode). */
  private suppressed = new Set<number>();
  private started = false;
  private destroyed = false;

  constructor(private readonly ctx: OverlayContext) {
    super();
    this.registerIpc();
  }

  /** Creates the overlays and starts watching the display topology. */
  start(): void {
    if (this.started) return;
    this.started = true;
    if (process.platform === 'darwin') {
      try {
        app.dock?.hide();
      } catch (err) {
        log.debug('dock.hide failed:', err);
      }
    }
    screen.on('display-added', this.onDisplaysChanged);
    screen.on('display-removed', this.onDisplaysChanged);
    screen.on('display-metrics-changed', this.onDisplaysChanged);
    this.createAll();
  }

  list(): Overlay[] {
    return [...this.overlays.values()];
  }

  get count(): number {
    return this.overlays.size;
  }

  byWebContents(wc: WebContents): Overlay | undefined {
    for (const overlay of this.overlays.values()) {
      if (!overlay.window.isDestroyed() && overlay.window.webContents.id === wc.id) return overlay;
    }
    return undefined;
  }

  /** Sends `channel` to every live overlay; the factory builds a per-display payload (return undefined to skip). */
  sendToAll<T>(channel: string, factory: PayloadFactory<T>): void {
    for (const overlay of this.overlays.values()) {
      if (!overlay.loaded || overlay.window.isDestroyed()) continue;
      const payload = factory(overlay.info, overlay);
      if (payload === undefined) continue;
      try {
        overlay.window.webContents.send(channel, payload);
      } catch (err) {
        log.debug(`send ${channel} to overlay#${overlay.info.index} failed:`, err);
      }
    }
  }

  /** Sends `channel` to one overlay (no-op when it is not loaded yet). */
  sendTo<T>(overlay: Overlay, channel: string, payload: T): void {
    if (!overlay.loaded || overlay.window.isDestroyed()) return;
    try {
      overlay.window.webContents.send(channel, payload);
    } catch (err) {
      log.debug(`send ${channel} to overlay#${overlay.info.index} failed:`, err);
    }
  }

  /** Hides the windows when the fire is paused (saves GPU) and shows them again on resume. */
  setVisible(visible: boolean): void {
    this.visible = visible;
    for (const overlay of this.overlays.values()) {
      if (overlay.window.isDestroyed()) continue;
      if (visible && !this.suppressed.has(overlay.id)) {
        if (overlay.loaded) this.show(overlay);
      } else if (overlay.window.isVisible()) {
        overlay.window.hide();
        overlay.shown = false;
      }
      if (!visible || this.suppressed.has(overlay.id)) this.tellHidden(overlay, true);
    }
  }

  /** Hides the overlays of these displays (fullscreen app on them) and shows the others again. */
  setSuppressed(displayIds: ReadonlySet<number>): void {
    const same = displayIds.size === this.suppressed.size && [...displayIds].every((id) => this.suppressed.has(id));
    if (same) return;
    this.suppressed = new Set(displayIds);
    this.setVisible(this.visible);
  }

  /** Display bounds (global DIP) of every live overlay. */
  displayBounds(): Array<{ id: number; bounds: DisplayInfo['bounds'] }> {
    return this.list().map((o) => ({ id: o.id, bounds: o.info.bounds }));
  }

  /**
   * Arde tot: while a burn runs the overlay takes clicks and keys (Esc) itself
   * instead of passing them to the apps underneath.
   */
  setInteractive(overlay: Overlay, on: boolean): void {
    const win = overlay.window;
    if (win.isDestroyed()) return;
    try {
      if (on) {
        win.setIgnoreMouseEvents(false);
        if (process.platform !== 'linux') {
          win.setFocusable(true);
          win.focus();
        }
      } else {
        win.setIgnoreMouseEvents(true, { forward: process.platform !== 'linux' });
        if (process.platform !== 'linux') {
          win.blur();
          win.setFocusable(false);
        }
      }
    } catch (err) {
      log.warn(`setInteractive(${on}) failed:`, err);
    }
  }

  /** Tears down every overlay and recreates them (debounced). */
  scheduleRebuild(reason: string): void {
    if (this.destroyed) return;
    if (this.rebuildTimer) clearTimeout(this.rebuildTimer);
    this.rebuildTimer = setTimeout(() => {
      this.rebuildTimer = null;
      log.info(`rebuilding overlays (${reason})`);
      this.destroyAll();
      this.createAll();
    }, REBUILD_DEBOUNCE_MS);
  }

  destroy(): void {
    this.destroyed = true;
    if (this.rebuildTimer) {
      clearTimeout(this.rebuildTimer);
      this.rebuildTimer = null;
    }
    screen.off('display-added', this.onDisplaysChanged);
    screen.off('display-removed', this.onDisplaysChanged);
    screen.off('display-metrics-changed', this.onDisplaysChanged);
    this.destroyAll();
  }

  // ── internals ──────────────────────────────────────────────────────────

  private readonly onDisplaysChanged = (_event: unknown, display?: Display, changed?: string[]): void => {
    const what = display ? `display ${display.id}${changed ? ` ${changed.join(',')}` : ''}` : 'displays';
    this.scheduleRebuild(what);
  };

  private describeDisplays(): DisplayInfo[] {
    const displays = [...screen.getAllDisplays()];
    const primaryId = screen.getPrimaryDisplay().id;
    // Deterministic order: primary first, then left→right, top→bottom.
    displays.sort((a, b) => {
      if (a.id === primaryId) return -1;
      if (b.id === primaryId) return 1;
      return a.bounds.x - b.bounds.x || a.bounds.y - b.bounds.y;
    });
    return displays.map((d, index) => ({
      id: d.id,
      bounds: { ...d.bounds },
      workArea: { ...d.workArea },
      scaleFactor: d.scaleFactor,
      isPrimary: d.id === primaryId,
      index,
      total: displays.length,
    }));
  }

  /** Displays that should have an overlay right now (primary first). */
  private wantedDisplays(): DisplayInfo[] {
    const infos = this.describeDisplays().filter((info) => this.ctx.displayIndex === null || info.index === this.ctx.displayIndex);
    return infos.slice(0, Math.max(0, this.ctx.maxDisplays()));
  }

  /** Rebuilds only when the set of displays that should burn differs from the current one (licence changes). */
  syncDisplays(reason: string): void {
    if (!this.started || this.destroyed) return;
    const wanted = this.wantedDisplays()
      .map((d) => d.id)
      .sort((a, b) => a - b);
    const current = [...this.overlays.keys()].sort((a, b) => a - b);
    if (wanted.length !== current.length || wanted.some((id, i) => id !== current[i])) this.scheduleRebuild(reason);
  }

  private createAll(): void {
    if (this.destroyed) return;
    const all = this.describeDisplays();
    const infos = this.wantedDisplays();
    if (infos.length < all.length && this.ctx.displayIndex === null) {
      log.info(`free version: fire on the primary display only (${all.length} connected)`);
    }
    for (const info of infos) {
      try {
        this.create(info);
      } catch (err) {
        log.error(`could not create overlay for display ${info.id}:`, err);
      }
    }
    if (this.overlays.size === 0) log.warn('no overlay windows were created');
    this.emit('overlays-changed', this.list());
  }

  private destroyAll(): void {
    for (const overlay of this.overlays.values()) {
      try {
        if (!overlay.window.isDestroyed()) overlay.window.destroy();
      } catch (err) {
        log.debug('destroy failed:', err);
      }
    }
    this.overlays.clear();
  }

  private create(info: DisplayInfo): void {
    const { bounds } = info;
    const win = new BrowserWindow({
      x: bounds.x,
      y: bounds.y,
      width: bounds.width,
      height: bounds.height,
      transparent: true,
      frame: false,
      alwaysOnTop: true,
      skipTaskbar: true,
      hasShadow: false,
      focusable: false,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      show: false,
      // Size the web contents, not the (non-existent) frame: X11 otherwise reports a 1 px smaller page.
      useContentSize: true,
      title: 'Prăjeală overlay',
      backgroundColor: '#00000000',
      webPreferences: {
        preload: this.ctx.preloadPath,
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        backgroundThrottling: false,
        spellcheck: false,
        devTools: !app.isPackaged,
      },
    });

    const overlay: Overlay = { id: info.id, info, window: win, loaded: false, shown: false, crashes: 0, hostHidden: null };
    this.overlays.set(info.id, overlay);

    // `forward` (mouse-move passthrough to the page) only exists on Windows/macOS;
    // on Linux Electron ignores it, and the renderer gets the cursor via IPC anyway.
    win.setIgnoreMouseEvents(true, { forward: process.platform !== 'linux' });
    win.setAlwaysOnTop(true, 'screen-saver');
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
    win.setMenuBarVisibility(false);
    // Some window managers nudge frameless windows; pin the exact display bounds.
    win.setBounds(bounds);

    win.once('ready-to-show', () => {
      if (win.isDestroyed()) return;
      this.show(overlay);
    });

    win.webContents.on('did-finish-load', () => {
      if (win.isDestroyed()) return;
      overlay.loaded = true;
      this.pushInitialState(overlay);
      // ready-to-show is not emitted for every transparent window configuration; make sure we show.
      setTimeout(() => {
        if (!win.isDestroyed() && !overlay.shown) this.show(overlay);
      }, SHOW_FALLBACK_MS);
      this.emit('loaded', overlay);
    });

    win.webContents.on('did-fail-load', (_e, code, description, url) => {
      log.error(`overlay#${info.index} failed to load ${url}: ${code} ${description}`);
      this.emit('load-failed', overlay, `${code} ${description}`);
    });

    win.webContents.on('render-process-gone', (_e, details) => {
      overlay.crashes += 1;
      log.error(`overlay#${info.index} renderer gone (${details.reason}, exit ${details.exitCode})`);
      this.emit('renderer-gone', overlay, details);
      if (overlay.crashes <= MAX_CRASH_RELOADS) {
        setTimeout(() => {
          if (!win.isDestroyed()) {
            overlay.loaded = false;
            win.webContents.reload();
          }
        }, 1000 * overlay.crashes);
      }
    });

    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-navigate', (e) => e.preventDefault());

    win.on('closed', () => {
      if (this.overlays.get(info.id) === overlay) this.overlays.delete(info.id);
    });

    const url = this.rendererUrlFor(info);
    log.info(`overlay#${info.index} display ${info.id} ${bounds.width}x${bounds.height}@${bounds.x},${bounds.y} ×${info.scaleFactor}`);
    log.debug(`overlay#${info.index} loading ${url}`);
    void win.loadURL(url).catch((err: unknown) => {
      log.error(`overlay#${info.index} loadURL failed:`, err);
    });
  }

  private rendererUrlFor(info: DisplayInfo): string {
    const base = this.ctx.rendererUrl
      ? this.ctx.rendererUrl.includes('://')
        ? this.ctx.rendererUrl
        : pathToFileURL(this.ctx.rendererUrl).href
      : pathToFileURL(this.ctx.rendererHtmlPath).href;
    const url = new URL(base);
    if (this.ctx.debugHud) url.searchParams.set('hud', '1');
    url.searchParams.set('display', String(info.index));
    return url.href;
  }

  private show(overlay: Overlay): void {
    if (!this.visible || this.suppressed.has(overlay.id) || overlay.window.isDestroyed()) return;
    if (!overlay.window.isVisible()) overlay.window.showInactive();
    overlay.shown = true;
    this.tellHidden(overlay, false);
    // Re-assert z-order/bounds after the first show (Windows sometimes resets them).
    overlay.window.setAlwaysOnTop(true, 'screen-saver');
    overlay.window.setBounds(overlay.info.bounds);
  }

  /**
   * Overlays run with backgroundThrottling off, so a hidden window still looks
   * visible to its page and would keep simulating: say so explicitly.
   */
  private tellHidden(overlay: Overlay, hidden: boolean): void {
    if (!overlay.loaded || overlay.hostHidden === hidden) return;
    overlay.hostHidden = hidden;
    this.sendTo(overlay, IPC.visibility, { hidden });
  }

  private pushInitialState(overlay: Overlay): void {
    overlay.hostHidden = null;
    this.tellHidden(overlay, !this.visible || this.suppressed.has(overlay.id));
    const wc = overlay.window.webContents;
    try {
      wc.send(IPC.display, overlay.info);
      wc.send(IPC.capabilities, this.ctx.getCapabilities());
      wc.send(IPC.settings, this.ctx.getSettings());
    } catch (err) {
      log.debug('initial state push failed:', err);
    }
  }

  private registerIpc(): void {
    ipcMain.handle(IPC.getSettings, () => this.ctx.getSettings());
    ipcMain.handle(IPC.getCapabilities, () => this.ctx.getCapabilities());
    ipcMain.handle(IPC.getDisplay, (event) => {
      const overlay = this.byWebContents(event.sender);
      if (!overlay) throw new Error('unknown overlay window');
      return overlay.info;
    });
    ipcMain.handle(IPC.updateSettings, (_event, patch: unknown) => this.ctx.updateSettings(patch));
    ipcMain.handle(IPC.getZmeuHome, (event) => {
      const overlay = this.byWebContents(event.sender);
      if (!overlay) throw new Error('unknown overlay window');
      return this.ctx.getZmeuHome(overlay);
    });

    ipcMain.on(IPC.ready, (event: IpcMainEvent, report: unknown) => {
      const overlay = this.byWebContents(event.sender);
      if (!overlay) return;
      this.emit('ready', overlay, sanitizeReady(report));
    });
    ipcMain.on(IPC.stats, (event: IpcMainEvent, stats: unknown) => {
      const overlay = this.byWebContents(event.sender);
      if (!overlay) return;
      this.emit('stats', overlay, sanitizeStats(stats));
    });
    ipcMain.on(IPC.zmeuExited, (event: IpcMainEvent, report: unknown) => {
      const overlay = this.byWebContents(event.sender);
      const r = sanitizeZmeuExit(report);
      if (overlay && r) this.emit('zmeu-exited', overlay, r);
    });
    ipcMain.on(IPC.burnReady, (event: IpcMainEvent) => {
      const overlay = this.byWebContents(event.sender);
      if (overlay) this.emit('burn-ready', overlay);
    });
    ipcMain.on(IPC.burnDone, (event: IpcMainEvent, report: unknown) => {
      const overlay = this.byWebContents(event.sender);
      if (!overlay) return;
      const r = (report && typeof report === 'object' ? report : {}) as Record<string, unknown>;
      const out: { ok: boolean; aborted: boolean; error?: string } = { ok: r.ok === true, aborted: r.aborted === true };
      if (typeof r.error === 'string' && r.error) out.error = r.error.slice(0, 300);
      this.emit('burn-done', overlay, out);
    });
    ipcMain.on(IPC.log, (event: IpcMainEvent, entry: unknown) => {
      const overlay = this.byWebContents(event.sender);
      if (!overlay) return;
      const e = (entry && typeof entry === 'object' ? entry : {}) as { level?: unknown; message?: unknown };
      const level: LogLevel =
        e.level === 'debug' || e.level === 'info' || e.level === 'warn' || e.level === 'error' ? e.level : 'info';
      this.emit('log', overlay, level, String(e.message ?? ''));
    });
  }
}

function num(v: unknown, fallback = 0): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

function sanitizeReady(input: unknown): RendererReadyReport {
  const r = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const out: RendererReadyReport = {
    ok: r.ok === true,
    webgl2: r.webgl2 === true,
    floatTextures: r.floatTextures === true,
    renderer: typeof r.renderer === 'string' ? r.renderer : '',
    simWidth: num(r.simWidth),
    simHeight: num(r.simHeight),
    canvasWidth: num(r.canvasWidth),
    canvasHeight: num(r.canvasHeight),
  };
  if (typeof r.error === 'string' && r.error.length > 0) out.error = r.error;
  return out;
}

function sanitizeStats(input: unknown): RendererStats {
  const s = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const out: RendererStats = {
    frames: num(s.frames),
    fps: num(s.fps),
    simWidth: num(s.simWidth),
    simHeight: num(s.simHeight),
    sparks: num(s.sparks),
  };
  if (s.zmeu === 0 || s.zmeu === 1 || s.zmeu === 2) out.zmeu = s.zmeu;
  return out;
}
