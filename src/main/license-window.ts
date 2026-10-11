/**
 * The one ordinary window of this tray app: a small page where the user pastes
 * a licence key, sees the current tier and can buy / deactivate / re-check.
 * Shares the overlay preload (window.prajeala) — only the licence part is used.
 */
import { BrowserWindow, app, screen } from 'electron';
import { pathToFileURL } from 'node:url';
import { IPC } from '../shared/ipc';
import type { LicenseInfo } from '../shared/license';
import { createLogger } from './log';

const log = createLogger('license-window');

export const LICENSE_WINDOW_TITLE = 'Prăjeală — licence';

export interface LicenseWindowContext {
  preloadPath: string;
  htmlPath: string;
  getLicense(): LicenseInfo;
}

export class LicenseWindow {
  private win: BrowserWindow | null = null;

  constructor(private readonly ctx: LicenseWindowContext) {}

  /** Opens (or focuses) the window. */
  show(): void {
    if (this.win && !this.win.isDestroyed()) {
      this.win.show();
      this.win.focus();
      return;
    }
    const width = 500;
    const height = 400;
    let x: number | undefined;
    let y: number | undefined;
    try {
      const area = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
      x = Math.round(area.x + (area.width - width) / 2);
      y = Math.round(area.y + (area.height - height) / 2);
    } catch {
      /* default placement */
    }
    const win = new BrowserWindow({
      width,
      height,
      x,
      y,
      resizable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      show: false,
      title: LICENSE_WINDOW_TITLE,
      backgroundColor: '#15110f',
      autoHideMenuBar: true,
      webPreferences: {
        preload: this.ctx.preloadPath,
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        spellcheck: false,
        devTools: !app.isPackaged,
      },
    });
    this.win = win;
    win.setMenuBarVisibility(false);
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-navigate', (e) => e.preventDefault());
    win.webContents.on('did-finish-load', () => {
      if (win.isDestroyed()) return;
      try {
        win.webContents.send(IPC.license, this.ctx.getLicense());
      } catch (err) {
        log.debug('initial licence push failed:', err);
      }
    });
    win.once('ready-to-show', () => {
      if (win.isDestroyed()) return;
      win.show();
      win.focus();
      if (process.platform === 'darwin') app.focus({ steal: true });
    });
    win.on('closed', () => {
      if (this.win === win) this.win = null;
    });
    const url = pathToFileURL(this.ctx.htmlPath).href;
    void win.loadURL(url).catch((err: unknown) => log.error('loadURL failed:', err));
    log.info('licence window opened');
  }

  close(): void {
    if (this.win && !this.win.isDestroyed()) this.win.close();
    this.win = null;
  }

  /** Pushes a licence snapshot to the window when it is open. */
  send(info: LicenseInfo): void {
    if (!this.win || this.win.isDestroyed()) return;
    try {
      this.win.webContents.send(IPC.license, info);
    } catch (err) {
      log.debug('licence push failed:', err);
    }
  }

  owns(webContentsId: number): boolean {
    return !!this.win && !this.win.isDestroyed() && this.win.webContents.id === webContentsId;
  }

  destroy(): void {
    if (this.win && !this.win.isDestroyed()) {
      try {
        this.win.destroy();
      } catch {
        /* ignore */
      }
    }
    this.win = null;
  }
}
