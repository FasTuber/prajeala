/**
 * Preload bridge: exposes `window.prajeala` (see PrajealaApi in src/shared/ipc.ts)
 * to the sandboxed, context-isolated overlay renderer. Only serialisable data
 * crosses the bridge; subscriptions return an unsubscribe function that removes
 * exactly the listener that was registered.
 */
import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import {
  IPC,
  type ActiveWindowEvent,
  type CursorEvent,
  type DisplayInfo,
  type HostCapabilities,
  type PointerButtonEvent,
  type PowerFrame,
  type PrajealaApi,
  type RendererReadyReport,
  type RendererStats,
  type Unsubscribe,
} from '../shared/ipc';
import type { BurnDoneReport, BurnStart } from '../shared/burn';
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

const api: PrajealaApi = {
  getSettings: () => ipcRenderer.invoke(IPC.getSettings) as Promise<Settings>,
  getDisplay: () => ipcRenderer.invoke(IPC.getDisplay) as Promise<DisplayInfo>,
  getCapabilities: () => ipcRenderer.invoke(IPC.getCapabilities) as Promise<HostCapabilities>,
  updateSettings: (patch: Partial<Settings>) => ipcRenderer.invoke(IPC.updateSettings, patch) as Promise<Settings>,

  onCursor: (cb) => subscribe<CursorEvent>(IPC.cursor, cb),
  onPointerButton: (cb) => subscribe<PointerButtonEvent>(IPC.pointerButton, cb),
  onActiveWindow: (cb) => subscribe<ActiveWindowEvent | null>(IPC.activeWindow, cb),
  onSettings: (cb) => subscribe<Settings>(IPC.settings, cb),
  onDisplay: (cb) => subscribe<DisplayInfo>(IPC.display, cb),
  onCapabilities: (cb) => subscribe<HostCapabilities>(IPC.capabilities, cb),
  onTestBurst: (cb) => subscribe<{ x: number; y: number; strength: number }>(IPC.testBurst, cb),
  onKeyPress: (cb) => subscribe<null>(IPC.keyPress, () => cb()),
  onPower: (cb) => subscribe<PowerFrame>(IPC.power, cb),
  onBurnPrepare: (cb) => subscribe<null>(IPC.burnPrepare, () => cb()),
  onBurnStart: (cb) => subscribe<BurnStart>(IPC.burnStart, cb),
  onBurnAbort: (cb) => subscribe<null>(IPC.burnAbort, () => cb()),
  burnReady: () => {
    ipcRenderer.send(IPC.burnReady);
  },
  burnDone: (report: BurnDoneReport) => {
    ipcRenderer.send(IPC.burnDone, report);
  },

  reportReady: (report: RendererReadyReport) => {
    ipcRenderer.send(IPC.ready, report);
  },
  reportStats: (stats: RendererStats) => {
    ipcRenderer.send(IPC.stats, stats);
  },
  log: (level, message) => {
    ipcRenderer.send(IPC.log, { level, message: String(message) });
  },
};

contextBridge.exposeInMainWorld('prajeala', api);
