/**
 * Media permissions for sound reactivity. Chromium asks the main process before
 * a renderer may call getUserMedia / getDisplayMedia; we only ever grant
 * *audio* capture, only to our own overlay windows, and only while the
 * feature is switched on. System audio ("loopback") is served through the
 * display-media handler on Windows; elsewhere the renderer falls back to the
 * microphone (or a PulseAudio monitor device when one is exposed).
 */
import { desktopCapturer, session, systemPreferences, webContents, type Session, type WebContents, type WebFrameMain } from 'electron';
import { createLogger } from './log';

const log = createLogger('audio');

export interface AudioPermissionContext {
  /** True when settings allow audio capture right now (audioReactive && enabled). */
  isAllowed(): boolean;
  /** True for web contents that belong to an overlay window. */
  isOverlay(wc: WebContents | null): boolean;
}

/** Whether this host can hand the renderer a system-audio loopback stream. */
export function loopbackAvailable(): boolean {
  return process.platform === 'win32';
}

export function installAudioPermissions(ctx: AudioPermissionContext, ses: Session = session.defaultSession): void {
  ses.setPermissionRequestHandler((wc, permission, callback, details) => {
    if (permission === 'media' && ctx.isOverlay(wc) && ctx.isAllowed()) {
      const types = (details as { mediaTypes?: string[] }).mediaTypes ?? [];
      const audioOnly = types.length === 0 || types.every((t) => t === 'audio');
      log.debug(`media permission ${audioOnly ? 'granted' : 'denied (video requested)'}`);
      callback(audioOnly);
      return;
    }
    if (permission === 'display-capture' && ctx.isOverlay(wc) && ctx.isAllowed() && loopbackAvailable()) {
      callback(true);
      return;
    }
    callback(false);
  });
  ses.setPermissionCheckHandler((wc, permission) => {
    if (permission === 'media') return ctx.isOverlay(wc) && ctx.isAllowed();
    return false;
  });
  ses.setDisplayMediaRequestHandler((request, callback) => {
    const wc = request.frame ? webContentsOf(request.frame) : null;
    if (!request.audioRequested || !loopbackAvailable() || !ctx.isOverlay(wc) || !ctx.isAllowed()) {
      log.debug('display-media request refused');
      callback(null);
      return;
    }
    // Chromium needs a video source even though the renderer drops it immediately.
    desktopCapturer
      .getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } })
      .then((sources) => {
        const video = sources[0];
        if (!video) {
          callback(null);
          return;
        }
        log.info('serving system audio (loopback) to the overlay');
        callback({ video, audio: 'loopback' });
      })
      .catch((err: unknown) => {
        log.warn('desktopCapturer failed:', err);
        callback(null);
      });
  });
}

function webContentsOf(frame: WebFrameMain): WebContents | null {
  try {
    return webContents.fromFrame(frame) ?? null;
  } catch {
    return null;
  }
}

/**
 * macOS: triggers the one-time TCC microphone prompt from the main process (the
 * renderer's getUserMedia alone does not). Resolves to the resulting status.
 */
export async function ensureMicrophoneAccess(): Promise<'granted' | 'denied' | 'unknown'> {
  if (process.platform !== 'darwin') return 'granted';
  try {
    const status = systemPreferences.getMediaAccessStatus('microphone');
    if (status === 'granted') return 'granted';
    if (status === 'denied' || status === 'restricted') {
      log.warn(`microphone access is ${status} in System Settings › Privacy & Security › Microphone`);
      return 'denied';
    }
    const ok = await systemPreferences.askForMediaAccess('microphone');
    log.info(`microphone access ${ok ? 'granted' : 'denied'} by the user`);
    return ok ? 'granted' : 'denied';
  } catch (err) {
    log.warn('could not query microphone access:', err);
    return 'unknown';
  }
}
