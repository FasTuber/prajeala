/**
 * The settings window: every option of the tray menu plus the Prăjeală Pro
 * card (trial status, “Buy”, licence activation). One instance at most; the
 * page talks to main through its own preload (src/preload/settings.ts) and
 * every IPC handler checks that the request comes from this window.
 */
import { pathToFileURL } from 'node:url';
import { app, BrowserWindow, ipcMain, type IpcMainEvent, type IpcMainInvokeEvent } from 'electron';
import { clampFocusMinutes } from '../shared/focus';
import { UI_IPC, type FocusAction, type UiFocus, type UiState } from '../shared/ipc';
import type { LicenseActionResult } from '../shared/license';
import type { BurnMode } from '../shared/burn';
import type { ExternalLink } from '../shared/product';
import { createLogger } from './log';

const log = createLogger('settings-window');

export const SETTINGS_WINDOW_TITLE = 'Prăjeală';

export interface SettingsWindowDeps {
  preloadPath: string;
  htmlPath: string;
  iconPath: string | null;
  getState(): UiState;
  updateSettings(patch: unknown): void;
  activate(key: string): Promise<LicenseActionResult>;
  deactivate(): Promise<LicenseActionResult>;
  openLink(link: ExternalLink): void;
  openSettingsFile(): void;
  testBurst(): void;
  burn(mode: BurnMode): void;
  focusAction(action: FocusAction): void;
  /** The page booted (or failed to) — used by --smoke. */
  onReady?(report: { ok: boolean; error?: string }): void;
}

export class SettingsWindow {
  private win: BrowserWindow | null = null;
  private loaded = false;
  private focus: UiFocus = null;

  constructor(private readonly deps: SettingsWindowDeps) {
    this.registerIpc();
  }

  get isOpen(): boolean {
    return !!this.win && !this.win.isDestroyed();
  }

  /** Opens (or raises) the window; `focus` scrolls to the Pro card or shows the welcome. */
  open(focus: UiFocus = null, options: { show?: boolean } = {}): void {
    this.focus = focus;
    const existing = this.win;
    if (existing && !existing.isDestroyed()) {
      if (existing.isMinimized()) existing.restore();
      if (options.show !== false) this.reveal(existing);
      this.sendFocus();
      return;
    }
    const win = new BrowserWindow({
      width: 500,
      height: 780,
      minWidth: 420,
      minHeight: 520,
      show: false,
      title: SETTINGS_WINDOW_TITLE,
      backgroundColor: '#15100e',
      autoHideMenuBar: true,
      fullscreenable: false,
      maximizable: false,
      ...(this.deps.iconPath && process.platform !== 'darwin' ? { icon: this.deps.iconPath } : {}),
      webPreferences: {
        preload: this.deps.preloadPath,
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        spellcheck: false,
        devTools: !app.isPackaged,
      },
    });
    this.win = win;
    this.loaded = false;
    win.setMenuBarVisibility(false);
    win.once('ready-to-show', () => {
      if (!win.isDestroyed() && options.show !== false) this.reveal(win);
    });
    win.webContents.on('did-finish-load', () => {
      this.loaded = true;
      this.pushState();
      this.sendFocus();
    });
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-navigate', (e) => e.preventDefault());
    win.on('page-title-updated', (e) => e.preventDefault());
    win.on('closed', () => {
      if (this.win === win) {
        this.win = null;
        this.loaded = false;
      }
    });
    void win.loadURL(pathToFileURL(this.deps.htmlPath).href).catch((err: unknown) => {
      log.error('could not load the settings page:', err);
      this.deps.onReady?.({ ok: false, error: `load failed: ${(err as Error).message ?? err}` });
    });
  }

  /** Live audio meter data (no-op while closed). */
  sendAudioLevel(level: { level: number; bands: number[] }): void {
    const win = this.win;
    if (!win || win.isDestroyed() || !this.loaded || !win.isVisible()) return;
    try {
      win.webContents.send(UI_IPC.audioLevel, level);
    } catch {
      /* closing */
    }
  }

  /** Sends the latest UiState to the page (no-op while closed). */
  pushState(): void {
    const win = this.win;
    if (!win || win.isDestroyed() || !this.loaded) return;
    try {
      win.webContents.send(UI_IPC.state, this.deps.getState());
    } catch (err) {
      log.debug('state push failed:', err);
    }
  }

  close(): void {
    if (this.win && !this.win.isDestroyed()) this.win.close();
  }

  destroy(): void {
    if (this.win && !this.win.isDestroyed()) this.win.destroy();
    this.win = null;
    for (const channel of [UI_IPC.getState, UI_IPC.updateSettings, UI_IPC.activate, UI_IPC.deactivate]) {
      ipcMain.removeHandler(channel);
    }
  }

  // ── internals ──────────────────────────────────────────────────────────

  private reveal(win: BrowserWindow): void {
    win.show();
    win.focus();
    // Tray agents (LSUIElement) are not frontmost on macOS until asked.
    if (process.platform === 'darwin') app.focus({ steal: true });
  }

  private sendFocus(): void {
    const win = this.win;
    if (!win || win.isDestroyed() || !this.loaded) return;
    win.webContents.send(UI_IPC.focus, this.focus);
    this.focus = null;
  }

  private fromUs(event: IpcMainEvent | IpcMainInvokeEvent): boolean {
    return !!this.win && !this.win.isDestroyed() && event.sender === this.win.webContents;
  }

  private registerIpc(): void {
    const guard = (event: IpcMainInvokeEvent): void => {
      if (!this.fromUs(event)) throw new Error('not allowed');
    };
    ipcMain.handle(UI_IPC.getState, (event) => {
      guard(event);
      return this.deps.getState();
    });
    ipcMain.handle(UI_IPC.updateSettings, (event, patch: unknown) => {
      guard(event);
      this.deps.updateSettings(patch);
      return this.deps.getState();
    });
    ipcMain.handle(UI_IPC.activate, async (event, key: unknown) => {
      guard(event);
      return this.deps.activate(typeof key === 'string' ? key : '');
    });
    ipcMain.handle(UI_IPC.deactivate, async (event) => {
      guard(event);
      return this.deps.deactivate();
    });
    ipcMain.on(UI_IPC.openLink, (event, link: unknown) => {
      if (this.fromUs(event) && typeof link === 'string') this.deps.openLink(link as ExternalLink);
    });
    ipcMain.on(UI_IPC.openSettingsFile, (event) => {
      if (this.fromUs(event)) this.deps.openSettingsFile();
    });
    ipcMain.on(UI_IPC.testBurst, (event) => {
      if (this.fromUs(event)) this.deps.testBurst();
    });
    ipcMain.on(UI_IPC.burn, (event, mode: unknown) => {
      if (!this.fromUs(event)) return;
      if (mode === 'screen' || mode === 'window' || mode === 'image') this.deps.burn(mode);
    });
    ipcMain.on(UI_IPC.focusAction, (event, raw: unknown) => {
      if (!this.fromUs(event) || !raw || typeof raw !== 'object') return;
      const a = raw as { type?: unknown; minutes?: unknown };
      if (a.type === 'start') this.deps.focusAction({ type: 'start', minutes: clampFocusMinutes(a.minutes) });
      else if (a.type === 'pause' || a.type === 'resume' || a.type === 'cancel') this.deps.focusAction({ type: a.type });
    });
    ipcMain.on(UI_IPC.ready, (event, report: unknown) => {
      if (!this.fromUs(event)) return;
      const r = (report && typeof report === 'object' ? report : {}) as { ok?: unknown; error?: unknown };
      const out = { ok: r.ok === true, ...(typeof r.error === 'string' && r.error ? { error: r.error } : {}) };
      if (out.ok) log.debug('settings page ready');
      else log.error(`settings page failed: ${out.error ?? 'unknown error'}`);
      this.deps.onReady?.(out);
    });
  }
}
