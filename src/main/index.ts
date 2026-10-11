/**
 * Prăjeală — main process entry (ESM, bundled to dist/main/index.mjs).
 *
 * Wires: CLI flags → Chromium switches → settings store → overlay windows →
 * cursor / active-window trackers → tray + global shortcuts → optional smoke run.
 * This is a tray application: closing every window never quits; only the
 * tray, the global shortcut or the smoke runner do.
 */
import { Notification, app, clipboard, dialog, ipcMain, shell } from 'electron';
import {
  IPC,
  type ActiveWindowEvent,
  type CursorEvent,
  type HostCapabilities,
  type PointerButtonEvent,
  type Rect,
} from '../shared/ipc';
import { applyTierLimits, type LicenseActionResult } from '../shared/license';
import type { Settings } from '../shared/settings';
import { ActiveWindowTracker, type ActiveWindowInfo } from './active-window-tracker';
import { parseCli, type CliOptions } from './cli';
import { CursorTracker, type CursorSample } from './cursor-tracker';
import { rectCenter, rectContainsPoint, rectsIntersect, toLocalPoint, toLocalRect } from './geometry';
import { LemonSqueezyClient } from './lemon-squeezy';
import { loadLicenseConfig } from './license-config';
import { LicenseStore } from './license-store';
import { LicenseWindow } from './license-window';
import { createLogger, setVerbose } from './log';
import { OverlayManager } from './overlay-manager';
import { licenseFilePath, licenseHtmlPath, preloadPath, rendererHtmlPath, settingsFilePath } from './paths';
import { SettingsStore } from './settings-store';
import { registerShortcuts, unregisterShortcuts } from './shortcuts';
import { SmokeRunner } from './smoke';
import { TrayController } from './tray';

const cli: CliOptions = parseCli(process.argv.slice(1));
setVerbose(cli.verbose);
const log = createLogger('main');

// ── Chromium switches (must precede app.whenReady) ──────────────────────────
app.commandLine.appendSwitch('disable-renderer-backgrounding');
if (cli.smoke || cli.softwareGl) {
  // Software WebGL2 through ANGLE/SwiftShader (headless CI, VMs without a GPU).
  app.commandLine.appendSwitch('use-gl', 'angle');
  app.commandLine.appendSwitch('use-angle', 'swiftshader');
  app.commandLine.appendSwitch('enable-unsafe-swiftshader');
  app.commandLine.appendSwitch('ignore-gpu-blocklist');
  app.commandLine.appendSwitch('disable-gpu-sandbox');
}
if (process.platform === 'linux' && cli.linuxTransparentVisuals) {
  // Legacy X11 setups: transparent windows only work with these two switches.
  app.commandLine.appendSwitch('enable-transparent-visuals');
  app.commandLine.appendSwitch('disable-gpu-compositing');
}

interface Runtime {
  store: SettingsStore;
  license: LicenseStore;
  licenseWindow: LicenseWindow;
  overlays: OverlayManager;
  cursor: CursorTracker;
  activeWindow: ActiveWindowTracker;
  tray: TrayController;
  smoke: SmokeRunner | null;
  capabilities: HostCapabilities;
  shuttingDown: boolean;
}

let runtime: Runtime | null = null;

if (!app.requestSingleInstanceLock()) {
  log.info('another instance of Prăjeală is already running; exiting');
  app.quit();
} else {
  app.on('second-instance', () => {
    log.info('second instance launched; the running one keeps the fire');
    runtime?.tray.refresh();
  });

  // Tray app: keep running without windows (overlays are recreated on display changes).
  app.on('window-all-closed', () => {
    /* intentionally empty */
  });

  app.on('before-quit', () => {
    runtime?.store.flushSync();
  });

  app.on('will-quit', () => {
    shutdown();
  });

  app
    .whenReady()
    .then(main)
    .catch((err: unknown) => {
      log.error('startup failed:', err);
      if (cli.smoke) {
        process.stdout.write(
          `PRAJEALA_SMOKE_RESULT ${JSON.stringify({ ok: false, reason: `startup failed: ${(err as Error).message ?? err}` })}\n`,
          () => app.exit(1),
        );
      } else {
        app.exit(1);
      }
    });
}

async function main(): Promise<void> {
  log.info(`Prăjeală ${app.getVersion()} — electron ${process.versions.electron}, ${process.platform}/${process.arch}`);
  log.debug('cli', { ...cli, license: cli.license ? '<redacted>' : null });

  const store = new SettingsStore({ filePath: settingsFilePath(), persist: !cli.smoke });
  store.load();

  // ── Licence (Free / Pro) ───────────────────────────────────────────────
  const licenseConfig = loadLicenseConfig();
  const license = new LicenseStore({
    filePath: licenseFilePath(),
    config: licenseConfig,
    client: new LemonSqueezyClient(),
    persist: !cli.smoke,
    onlineCheckEnabled: () => store.get().licenseOnlineCheck,
  });
  license.load();
  /** What the overlays run with: the stored settings clamped to the current tier. */
  const effectiveSettings = (): Settings => applyTierLimits(store.get(), license.tier);
  const licenseWindow = new LicenseWindow({ preloadPath, htmlPath: licenseHtmlPath, getLicense: () => license.get() });

  const capabilities: HostCapabilities = {
    globalClicks: false,
    activeWindow: false,
    platform: process.platform,
    smoke: cli.smoke,
  };

  const overlays = new OverlayManager({
    preloadPath,
    rendererHtmlPath,
    rendererUrl: cli.rendererUrl,
    debugHud: cli.debugHud, // `?hud=1`; the persistent toggle travels via settings.showDebugHud
    displayIndex: cli.display,
    getSettings: effectiveSettings,
    updateSettings: (patch) => store.update(patch),
    getCapabilities: () => capabilities,
  });
  registerLicenseIpc(license, licenseWindow);

  // ── Trackers ───────────────────────────────────────────────────────────
  const cursor = new CursorTracker({
    hz: cli.cursorHz,
    hooks: !cli.smoke && !cli.noHooks,
    onMove: (sample) => broadcastCursor(overlays, sample),
    onButton: (sample, button, type) => {
      if (!store.get().clickBursts) return;
      overlays.sendToAll<PointerButtonEvent>(IPC.pointerButton, (info) => {
        const local = toLocalPoint(sample, info.bounds);
        return {
          x: local.x,
          y: local.y,
          gx: sample.x,
          gy: sample.y,
          inside: rectContainsPoint(info.bounds, sample),
          button,
          type,
          t: sample.t,
        };
      });
    },
  });

  let lastActiveWindow: ActiveWindowInfo | null = null;
  const activeWindow = new ActiveWindowTracker({
    hz: cli.windowHz,
    allowed: !cli.noActiveWindow,
    onChange: (info) => {
      lastActiveWindow = info;
      broadcastActiveWindow(overlays, info);
    },
  });
  capabilities.activeWindow = await activeWindow.init();

  cursor.start();
  capabilities.globalClicks = cursor.globalClicks;
  log.info(`capabilities: clicks=${capabilities.globalClicks} activeWindow=${capabilities.activeWindow} smoke=${capabilities.smoke}`);

  // ── Actions shared by tray + shortcuts ─────────────────────────────────
  const testBurst = (strength = 1): void => {
    overlays.sendToAll(IPC.testBurst, (info) => {
      const c = rectCenter(info.bounds);
      const local = toLocalPoint(c, info.bounds);
      return { x: local.x, y: local.y, strength };
    });
  };
  const quit = (): void => {
    log.info('quit requested');
    app.quit();
  };
  const openSettingsFile = (): void => {
    void store
      .ensureFile()
      .then(() => shell.openPath(store.filePath))
      .then((err) => {
        if (err) log.warn(`could not open ${store.filePath}: ${err}`);
      })
      .catch((err: unknown) => log.warn('could not open settings file:', err));
  };
  const openBuyPage = (): void => {
    const url = license.get().buyUrl;
    void shell.openExternal(url).catch((err: unknown) => log.warn(`could not open ${url}:`, err));
  };
  const notify = (title: string, body: string): void => {
    log.info(`${title}: ${body}`);
    if (cli.smoke) return;
    try {
      if (Notification.isSupported()) {
        new Notification({ title, body, silent: true }).show();
        return;
      }
    } catch (err) {
      log.debug('notification failed:', err);
    }
    void dialog.showMessageBox({ type: 'info', title, message: title, detail: body, buttons: ['OK'] });
  };
  const reportLicenseAction = (what: string, result: LicenseActionResult): void => {
    if (result.ok) notify('Prăjeală licence', `${what}: ${result.info.message}`);
    else notify('Prăjeală licence', `${what} failed: ${result.error ?? 'unknown error'}`);
  };
  const activateLicenseFromClipboard = (): void => {
    void Promise.resolve(clipboard.readText())
      .then((raw) => {
        const text = String(raw ?? '').trim();
        if (!text) {
          notify('Prăjeală licence', 'The clipboard is empty — copy your licence key first.');
          return;
        }
        return license.activate(text).then((r) => reportLicenseAction('Activation', r));
      })
      .catch((err: unknown) => log.warn('clipboard read failed:', err));
  };
  const checkLicenseOnline = (): void => {
    void license.checkOnline().then((r) => reportLicenseAction('Online check', r));
  };

  const tray = new TrayController({
    getSettings: () => store.get(),
    updateSettings: (patch) => store.update(patch),
    getCapabilities: () => capabilities,
    getLicense: () => license.get(),
    testBurst: () => testBurst(1),
    openSettingsFile,
    openLicenseWindow: () => licenseWindow.show(),
    activateLicenseFromClipboard,
    checkLicenseOnline,
    openBuyPage,
    quit,
  });

  runtime = {
    store,
    license,
    licenseWindow,
    overlays,
    cursor,
    activeWindow,
    tray,
    smoke: null,
    capabilities,
    shuttingDown: false,
  };

  // ── Settings + licence → everything else ───────────────────────────────
  let lastEnabled: boolean | null = null;
  const applySettings = (s: Settings): void => {
    overlays.setVisible(s.enabled);
    activeWindow.setEnabled(s.enabled && s.burnActiveWindow && capabilities.activeWindow);
    if (lastEnabled !== s.enabled) log.info(s.enabled ? 'fire enabled' : 'fire paused');
    lastEnabled = s.enabled;
  };
  const pushEffectiveSettings = (): void => {
    const effective = effectiveSettings();
    overlays.sendToAll(IPC.settings, () => effective);
    applySettings(effective);
    tray.refresh();
  };
  store.onChange((next, previous) => {
    log.debug('settings changed', next);
    if (next.licenseOnlineCheck !== previous.licenseOnlineCheck) license.refresh();
    pushEffectiveSettings();
  });
  license.onChange((info, previous) => {
    if (info.tier !== previous.tier) log.info(`licence tier: ${previous.tier} → ${info.tier}`);
    overlays.sendToAll(IPC.license, () => info);
    licenseWindow.send(info);
    pushEffectiveSettings();
  });

  // ── Renderer → main messages ───────────────────────────────────────────
  overlays.on('log', (overlay, level, message) => {
    log.at(level, `[overlay#${overlay.info.index}] ${message}`);
  });
  overlays.on('ready', (overlay, report) => {
    log.info(
      `[overlay#${overlay.info.index}] ready ok=${report.ok} webgl2=${report.webgl2} float=${report.floatTextures} ` +
        `canvas=${report.canvasWidth}x${report.canvasHeight} sim=${report.simWidth}x${report.simHeight} renderer="${report.renderer}"` +
        (report.error ? ` error="${report.error}"` : ''),
    );
  });
  overlays.on('stats', (overlay, stats) => {
    log.debug(`[overlay#${overlay.info.index}] frames=${stats.frames} fps=${stats.fps.toFixed(1)} sparks=${stats.sparks}`);
  });
  overlays.on('overlays-changed', () => {
    // New windows start hidden; respect the current pause state.
    applySettings(effectiveSettings());
  });
  overlays.on('loaded', (overlay) => {
    // A freshly (re)loaded page gets the current cursor and active window right away,
    // instead of waiting for the next change.
    const p = cursor.readPoint();
    if (p) {
      const local = toLocalPoint(p, overlay.info.bounds);
      overlays.sendTo<CursorEvent>(overlay, IPC.cursor, {
        x: local.x,
        y: local.y,
        gx: p.x,
        gy: p.y,
        inside: rectContainsPoint(overlay.info.bounds, p),
        t: performance.now(),
      });
    }
    if (lastActiveWindow) {
      overlays.sendTo<ActiveWindowEvent>(overlay, IPC.activeWindow, toActiveWindowEvent(lastActiveWindow, overlay.info.bounds));
    }
  });

  // ── Smoke mode ─────────────────────────────────────────────────────────
  if (cli.smoke) {
    const smoke = new SmokeRunner(
      { frames: cli.smokeFrames, timeoutMs: cli.smokeTimeoutMs },
      overlays,
      {
        sendTestBurst: () => testBurst(1),
        exit: (code) => {
          shutdown();
          app.exit(code);
        },
      },
    );
    runtime.smoke = smoke;
    smoke.start();
  } else {
    process.on('uncaughtException', (err) => log.error('uncaught exception:', err));
    process.on('unhandledRejection', (reason) => log.error('unhandled rejection:', reason));
  }

  // ── Go ─────────────────────────────────────────────────────────────────
  overlays.start(); // emits 'overlays-changed' → applySettings
  tray.create();
  registerShortcuts({
    getSettings: () => store.get(),
    updateSettings: (patch) => store.update(patch),
    getTier: () => license.tier,
    testBurst: () => testBurst(1),
    quit,
  });
  if (!cli.smoke) license.startScheduler();
  if (cli.license) void license.activate(cli.license).then((r) => reportLicenseAction('Activation (--license)', r));
  if (cli.licenseWindow && !cli.smoke) licenseWindow.show();
}

/** invoke/send channels used by the licence window (and read-only by the overlays). */
function registerLicenseIpc(license: LicenseStore, licenseWindow: LicenseWindow): void {
  ipcMain.handle(IPC.getLicense, () => license.get());
  ipcMain.handle(IPC.activateLicense, (_event, key: unknown) => license.activate(key));
  ipcMain.handle(IPC.deactivateLicense, () => license.deactivate());
  ipcMain.handle(IPC.checkLicense, () => license.checkOnline());
  ipcMain.handle(IPC.openBuyPage, async () => {
    await shell.openExternal(license.get().buyUrl);
  });
  ipcMain.handle(IPC.closeLicenseWindow, (event) => {
    if (licenseWindow.owns(event.sender.id)) licenseWindow.close();
  });
}

function broadcastCursor(overlays: OverlayManager, sample: CursorSample): void {
  overlays.sendToAll<CursorEvent>(IPC.cursor, (info) => {
    const local = toLocalPoint(sample, info.bounds);
    return {
      x: local.x,
      y: local.y,
      gx: sample.x,
      gy: sample.y,
      inside: rectContainsPoint(info.bounds, sample),
      t: sample.t,
    };
  });
}

function broadcastActiveWindow(overlays: OverlayManager, info: ActiveWindowInfo | null): void {
  if (!info) {
    overlays.sendToAll<ActiveWindowEvent | null>(IPC.activeWindow, () => null);
    return;
  }
  log.debug(
    `active window: "${info.title}" (${info.app}, pid ${info.pid}) ${JSON.stringify(info.bounds)}${isSelfWindow(info) ? ' [self]' : ''}`,
  );
  overlays.sendToAll<ActiveWindowEvent | null>(IPC.activeWindow, (display) => toActiveWindowEvent(info, display.bounds));
}

/** Our own windows: same process (macOS/Windows report the main pid) or our titles (X11 reports a helper pid). */
function isSelfWindow(info: ActiveWindowInfo): boolean {
  return info.pid === process.pid || /^Prăjeal[aă](\s|$)/.test(info.title);
}

function toActiveWindowEvent(info: ActiveWindowInfo, displayBounds: Rect): ActiveWindowEvent {
  return {
    title: info.title,
    app: info.app,
    bounds: toLocalRect(info.bounds, displayBounds),
    intersects: rectsIntersect(info.bounds, displayBounds),
    isSelf: isSelfWindow(info),
  };
}

/** Idempotent teardown used by will-quit and the smoke runner (app.exit skips will-quit). */
function shutdown(): void {
  const rt = runtime;
  if (!rt || rt.shuttingDown) return;
  rt.shuttingDown = true;
  log.debug('shutting down');
  unregisterShortcuts();
  rt.license.stopScheduler();
  rt.cursor.stop();
  rt.activeWindow.stop();
  rt.tray.destroy();
  rt.licenseWindow.destroy();
  rt.store.flushSync();
  rt.overlays.destroy();
}
