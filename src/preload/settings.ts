/**
 * Preload of the settings window: exposes `window.prajealaUi` (PrajealaUiApi).
 * Kept separate from the overlay preload so overlay pages can never reach the
 * licence or link-opening channels.
 */
import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import { UI_IPC, type PrajealaUiApi, type UiFocus, type UiState, type Unsubscribe } from '../shared/ipc';
import type { LicenseActionResult } from '../shared/license';
import type { ExternalLink } from '../shared/product';
import type { Settings } from '../shared/settings';

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

const api: PrajealaUiApi = {
  getState: () => ipcRenderer.invoke(UI_IPC.getState) as Promise<UiState>,
  updateSettings: (patch: Partial<Settings>) => ipcRenderer.invoke(UI_IPC.updateSettings, patch) as Promise<UiState>,
  activate: (key: string) => ipcRenderer.invoke(UI_IPC.activate, String(key)) as Promise<LicenseActionResult>,
  deactivate: () => ipcRenderer.invoke(UI_IPC.deactivate) as Promise<LicenseActionResult>,
  openLink: (link: ExternalLink) => {
    ipcRenderer.send(UI_IPC.openLink, link);
  },
  openSettingsFile: () => {
    ipcRenderer.send(UI_IPC.openSettingsFile);
  },
  testBurst: () => {
    ipcRenderer.send(UI_IPC.testBurst);
  },
  burn: (mode) => {
    ipcRenderer.send(UI_IPC.burn, String(mode));
  },
  focusAction: (action) => {
    ipcRenderer.send(UI_IPC.focusAction, action);
  },
  reportReady: (report) => {
    ipcRenderer.send(UI_IPC.ready, { ok: report.ok === true, error: report.error ? String(report.error) : undefined });
  },
  onState: (cb) => subscribe<UiState>(UI_IPC.state, cb),
  onFocus: (cb) => subscribe<UiFocus>(UI_IPC.focus, cb),
  onAudioLevel: (cb) => subscribe<{ level: number; bands: number[] }>(UI_IPC.audioLevel, cb),
};

contextBridge.exposeInMainWorld('prajealaUi', api);
