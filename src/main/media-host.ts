/**
 * Ritmul Focului media host: a hidden, never-throttled window (own preload and
 * the isolated 'prajeala-media' session) that captures system audio or the
 * microphone and analyses it (src/renderer/media/main.ts). Main only relays:
 * frames are sanitised and throttled to AUDIO_FRAME_HZ (onsets of dropped
 * frames carry over to the next one), status reports are deduplicated. The window is created on the first start() and destroyed
 * MEDIA_HOST_IDLE_DESTROY_MS after stop() to free its memory.
 *
 * Events: 'frame' (AudioFrame), 'status' (AudioStatusReport).
 */
import { EventEmitter } from 'node:events';
import { pathToFileURL } from 'node:url';
import {
  app,
  BrowserWindow,
  desktopCapturer,
  ipcMain,
  session,
  systemPreferences,
  webContents as webContentsApi,
  type IpcMainEvent,
  type PermissionRequest,
  type Session,
  type WebContents,
} from 'electron';
import { sanitizeAudioFrame, type AudioFrame, type AudioStatus, type AudioStatusReport } from '../shared/audio-contract';
import { MEDIA_IPC, type MediaStartRequest } from '../shared/ipc';
import { clampSensitivity, FrameThrottle, MEDIA_HOST_IDLE_DESTROY_MS, PendingOnsets } from '../shared/media-status';
import { createLogger } from './log';

const log = createLogger('media-host');

export const MEDIA_PARTITION = 'prajeala-media';

const AUDIO_STATUSES: readonly AudioStatus[] = ['off', 'starting', 'ok', 'silent', 'unsupported', 'denied', 'error'];

/** Permissions the capture page needs; everything else is denied. */
const MEDIA_PERMISSIONS = new Set<string>(['media', 'display-capture']);

export interface MediaHostOptions {
  preloadPath: string;
  htmlPath: string;
}

export interface MediaHostEvents {
  frame: [AudioFrame];
  status: [AudioStatusReport];
}

/**
 * Denies every permission request and check on the default session. The
 * overlays and the settings window (both on the default session) never need
 * camera, microphone, notifications, geolocation, clipboard reads… — the
 * media host lives on its own partition and is unaffected. Call once at
 * startup, after `app.whenReady()`.
 */
export function hardenDefaultSession(): void {
  const ses = session.defaultSession;
  ses.setPermissionRequestHandler((_wc, permission, callback) => {
    log.debug(`denied permission request on default session: ${permission}`);
    callback(false);
  });
  ses.setPermissionCheckHandler(() => false);
  ses.setDisplayMediaRequestHandler((_request, callback) => callback(null));
}

export class MediaHost extends EventEmitter<MediaHostEvents> {
  /** Same as the module-level hardenDefaultSession(). */
  static hardenDefaultSession(): void {
    hardenDefaultSession();
  }

  private win: BrowserWindow | null = null;
  private loaded = false;
  private sessionReady = false;
  private destroyed = false;
  /** True between start() and stop(): frames are relayed only while active. */
  private active = false;
  /** What the page was asked to capture; null until launched (e.g. while macOS asks for the mic). */
  private request: MediaStartRequest | null = null;
  /** Latest sensitivity, kept even while no request is out so a launch never sends a stale one. */
  private sensitivity = 0.5;
  /** Bumped on every start/stop so a late macOS permission answer backs off. */
  private generation = 0;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly throttle = new FrameThrottle();
  private readonly onsets = new PendingOnsets();
  private lastStatus: AudioStatusReport = { status: 'off', source: null };

  private readonly onFrameIpc = (event: IpcMainEvent, payload: unknown): void => {
    if (!this.active || !this.request || !this.isFromHost(event)) return;
    if (!this.throttle.accept(performance.now())) {
      this.onsets.hold(payload);
      return;
    }
    const frame = sanitizeAudioFrame(payload);
    if (frame) this.emit('frame', this.onsets.release(frame));
  };

  private readonly onStatusIpc = (event: IpcMainEvent, payload: unknown): void => {
    if (!this.isFromHost(event) || !payload || typeof payload !== 'object') return;
    const p = payload as Record<string, unknown>;
    const status = AUDIO_STATUSES.find((s) => s === p.status);
    if (!status) return;
    // While active only main may turn capture 'off' (a late 'off' from a
    // previous stop must not hide a new start); once stopped only 'off' counts.
    if (this.active === (status === 'off')) return;
    const source = p.source === 'system' || p.source === 'mic' ? p.source : null;
    // While active, only reports about the capture main actually asked for: a
    // stale 'ok'/'silent' of the previous source (or of the capture still
    // running while macOS asks for the mic) must not overwrite 'starting'/'denied'.
    if (this.active && (!this.request || source !== this.request.source)) return;
    const detail = typeof p.detail === 'string' && p.detail ? p.detail.slice(0, 300) : undefined;
    this.setStatus(status, source, detail);
  };

  constructor(private readonly opts: MediaHostOptions) {
    super();
    ipcMain.on(MEDIA_IPC.frame, this.onFrameIpc);
    ipcMain.on(MEDIA_IPC.status, this.onStatusIpc);
  }

  get status(): AudioStatusReport {
    return { ...this.lastStatus };
  }

  /** Starts (or switches) capture. Creates the hidden window on first use. */
  start(req: MediaStartRequest): void {
    if (this.destroyed) return;
    const source = req.source === 'mic' ? 'mic' : 'system';
    this.sensitivity = clampSensitivity(req.sensitivity);
    const gen = ++this.generation;
    this.cancelIdleDestroy();
    this.active = true;
    this.request = null;
    this.throttle.reset();
    this.onsets.reset();
    this.setStatus('starting', source);

    if (source === 'mic' && process.platform === 'darwin') {
      // The previous capture must not keep feeding the fire while macOS asks
      // (or after it refuses): stop it now. Its 'off' is ignored while active.
      if (this.loaded) this.send(MEDIA_IPC.stop, null);
      systemPreferences
        .askForMediaAccess('microphone')
        .then((granted) => {
          if (gen !== this.generation) return;
          if (granted) this.launch(source);
          else this.setStatus('denied', 'mic', 'microphone access is not allowed in System Settings');
        })
        .catch((err: unknown) => {
          if (gen !== this.generation) return;
          this.setStatus('denied', 'mic', err instanceof Error ? err.message : String(err));
        });
      return;
    }
    this.launch(source);
  }

  setSensitivity(v: number): void {
    const value = clampSensitivity(v);
    this.sensitivity = value;
    if (this.request) this.request = { ...this.request, sensitivity: value };
    if (this.active && this.request && this.loaded) this.send(MEDIA_IPC.sensitivity, value);
  }

  /** Stops capture now; the window itself goes away after a short idle delay. */
  stop(): void {
    this.generation++;
    const wasActive = this.active;
    this.active = false;
    this.request = null;
    if (this.loaded) this.send(MEDIA_IPC.stop, null);
    this.setStatus('off', null);
    if (wasActive || this.win) this.scheduleIdleDestroy();
  }

  destroy(): void {
    if (this.destroyed) return;
    this.generation++;
    this.active = false;
    this.request = null;
    this.destroyed = true;
    this.cancelIdleDestroy();
    ipcMain.removeListener(MEDIA_IPC.frame, this.onFrameIpc);
    ipcMain.removeListener(MEDIA_IPC.status, this.onStatusIpc);
    this.destroyWindow();
    this.setStatus('off', null);
  }

  // ───────────────────────────── internals ─────────────────────────────

  private launch(source: MediaStartRequest['source']): void {
    const request: MediaStartRequest = { source, sensitivity: this.sensitivity };
    this.request = request;
    if (this.win && !this.win.isDestroyed()) {
      if (this.loaded) this.send(MEDIA_IPC.start, request);
      return; // otherwise sent from did-finish-load
    }
    this.createWindow();
  }

  private isFromHost(event: IpcMainEvent): boolean {
    const win = this.win;
    if (!win || win.isDestroyed()) return false;
    return event.sender === win.webContents && event.senderFrame === win.webContents.mainFrame;
  }

  private isHostContents(wc: WebContents | null | undefined): boolean {
    const win = this.win;
    return !!wc && !!win && !win.isDestroyed() && wc === win.webContents;
  }

  private setStatus(status: AudioStatus, source: AudioStatusReport['source'], detail?: string): void {
    const prev = this.lastStatus;
    if (prev.status === status && prev.source === source && prev.detail === detail) return;
    this.lastStatus = detail ? { status, source, detail } : { status, source };
    if (status === 'denied' || status === 'unsupported' || status === 'error') {
      log.warn(`audio ${status} (${source ?? '-'})${detail ? `: ${detail}` : ''}`);
    } else {
      log.debug(`audio ${status} (${source ?? '-'})`);
    }
    this.emit('status', { ...this.lastStatus });
  }

  private send(channel: string, payload: unknown): void {
    const win = this.win;
    if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return;
    win.webContents.send(channel, payload);
  }

  private mediaSession(): Session {
    const ses = session.fromPartition(MEDIA_PARTITION);
    if (this.sessionReady) return ses;
    this.sessionReady = true;

    ses.setPermissionRequestHandler((wc, permission, callback, details) => {
      callback(this.allowPermission(wc, permission, details));
    });
    ses.setPermissionCheckHandler((wc, permission, _origin, details) => {
      // Checks may come without contents (e.g. device enumeration); the partition is ours alone.
      if (!this.active || !MEDIA_PERMISSIONS.has(permission)) return false;
      return wc === null || (this.isHostContents(wc) && details.isMainFrame);
    });
    ses.setDisplayMediaRequestHandler((request, callback) => {
      const frameContents = request.frame ? webContentsApi.fromFrame(request.frame) : undefined;
      if (!this.wantsSystemAudio() || !this.isHostContents(frameContents)) {
        callback(null);
        return;
      }
      const gen = this.generation;
      desktopCapturer
        .getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } })
        .then((sources) => {
          const screen = sources[0];
          // Stopped or switched while the (possibly interactive, on Wayland) lookup ran.
          if (!screen || gen !== this.generation || !this.wantsSystemAudio()) {
            callback(null);
            return;
          }
          // 'loopback' (never 'loopbackWithMute': that would silence the user's music).
          callback({ video: screen, audio: 'loopback' });
        })
        .catch((err: unknown) => {
          log.warn('desktopCapturer.getSources failed', err);
          callback(null);
        });
    });
    return ses;
  }

  private wantsSystemAudio(): boolean {
    return this.active && this.request?.source === 'system';
  }

  /** Only the host page's main frame, only while capturing, only what the current source needs. */
  private allowPermission(wc: WebContents, permission: string, details: PermissionRequest): boolean {
    if (!this.active || !this.request || !MEDIA_PERMISSIONS.has(permission)) return false;
    if (!this.isHostContents(wc) || !details.isMainFrame) return false;
    if (permission === 'display-capture') return this.request.source === 'system';
    // 'media': the microphone path asks for audio only; the camera is never needed.
    const types = 'mediaTypes' in details && Array.isArray(details.mediaTypes) ? details.mediaTypes : [];
    return this.request.source === 'system' || !types.includes('video');
  }

  private createWindow(): void {
    this.mediaSession(); // handlers in place before the page can ask for anything
    const win = new BrowserWindow({
      show: false,
      width: 200,
      height: 100,
      focusable: false,
      skipTaskbar: true,
      webPreferences: {
        preload: this.opts.preloadPath,
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        backgroundThrottling: false,
        autoplayPolicy: 'no-user-gesture-required',
        partition: MEDIA_PARTITION,
        devTools: !app.isPackaged,
      },
    });
    this.win = win;
    this.loaded = false;
    const wc = win.webContents;

    wc.setWindowOpenHandler(() => ({ action: 'deny' }));
    wc.on('will-navigate', (event) => event.preventDefault());
    wc.on('did-finish-load', () => {
      if (this.win !== win) return;
      this.loaded = true;
      if (this.active && this.request) this.send(MEDIA_IPC.start, this.request);
    });
    wc.on('did-fail-load', (_event, code, description, _url, isMainFrame) => {
      if (this.win !== win || !isMainFrame) return;
      log.error(`media host failed to load: ${code} ${description}`);
      this.failWindow(`media host failed to load (${description})`);
    });
    wc.on('render-process-gone', (_event, details) => {
      if (this.win !== win) return;
      log.error(`media host renderer gone: ${details.reason}`);
      this.failWindow(`media host stopped (${details.reason})`);
    });
    win.on('closed', () => {
      if (this.win !== win) return;
      this.win = null;
      this.loaded = false;
    });

    win.loadURL(pathToFileURL(this.opts.htmlPath).toString()).catch((err: unknown) => {
      log.warn('media host loadURL rejected', err);
    });
  }

  /** The page cannot capture any more: report it and drop the window (next start() makes a new one). */
  private failWindow(detail: string): void {
    if (!this.active) {
      // Crashed while idle (e.g. inside the post-stop() grace period): nothing to report.
      this.cancelIdleDestroy();
      this.destroyWindow();
      return;
    }
    const source = this.request?.source ?? this.lastStatus.source;
    this.active = false;
    this.request = null;
    this.generation++;
    this.cancelIdleDestroy();
    this.destroyWindow();
    this.setStatus('error', source, detail);
  }

  private scheduleIdleDestroy(): void {
    this.cancelIdleDestroy();
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      if (!this.active) this.destroyWindow();
    }, MEDIA_HOST_IDLE_DESTROY_MS);
  }

  private cancelIdleDestroy(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }

  private destroyWindow(): void {
    const win = this.win;
    this.win = null;
    this.loaded = false;
    if (win && !win.isDestroyed()) win.destroy();
  }
}
