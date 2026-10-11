/**
 * Preload of the hidden media host window: exposes `window.prajealaMedia`
 * (PrajealaMediaApi). Separate from the overlay and settings preloads so the
 * capture page can only receive start/stop/sensitivity and send frames/status.
 */
import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import { MEDIA_IPC, type MediaStartRequest, type PrajealaMediaApi, type Unsubscribe } from '../shared/ipc';
import type { AudioFrame } from '../shared/audio-contract';

function subscribe<T>(channel: string, cb: (payload: T) => void): Unsubscribe {
  const listener = (_event: IpcRendererEvent, payload: T): void => {
    cb(payload);
  };
  ipcRenderer.on(channel, listener);
  let active = true;
  return () => {
    if (!active) return;
    active = false;
    ipcRenderer.removeListener(channel, listener);
  };
}

const api: PrajealaMediaApi = {
  onStart: (cb) => subscribe<MediaStartRequest>(MEDIA_IPC.start, cb),
  onStop: (cb) => subscribe<null>(MEDIA_IPC.stop, () => cb()),
  onSensitivity: (cb) => subscribe<number>(MEDIA_IPC.sensitivity, cb),
  sendFrame: (frame: AudioFrame) => {
    ipcRenderer.send(MEDIA_IPC.frame, frame);
  },
  sendStatus: (report) => {
    ipcRenderer.send(MEDIA_IPC.status, {
      status: String(report.status),
      source: report.source === 'system' || report.source === 'mic' ? report.source : null,
      detail: report.detail ? String(report.detail).slice(0, 300) : undefined,
    });
  },
};

contextBridge.exposeInMainWorld('prajealaMedia', api);
