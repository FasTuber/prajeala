/**
 * Prăjeală — main process entry (ESM, bundled to dist/main/index.mjs).
 *
 * Wires: CLI flags → Chromium switches → settings store + licence → overlay windows →
 * cursor / active-window trackers → tray, settings window, global shortcuts →
 * optional smoke run.
 * This is a tray application: closing every window never quits; only the
 * tray, the global shortcut or the smoke runner do.
 */
import { app, net, screen, shell } from 'electron';
import { pickLang } from '../shared/i18n';
import {
  IPC,
  type ActiveWindowEvent,
  type CursorEvent,
  type HostCapabilities,
  type PointerButtonEvent,
  type Rect,
  type UiState,
} from '../shared/ipc';
import { FREE_MAX_DISPLAYS, effectiveSettings, stripLockedChoices } from '../shared/pro';
import { PRODUCT, externalUrl } from '../shared/product';
import type { Settings } from '../shared/settings';
import { ActiveWindowTracker, type ActiveWindowInfo } from './active-window-tracker';
import { parseCli, type CliOptions } from './cli';
import { CursorTracker, type CursorSample } from './cursor-tracker';
import { rectCenter, rectContainsPoint, rectsIntersect, toLocalPoint, toLocalRect } from './geometry';
import { createLogger, setVerbose } from './log';
import { LicenseManager } from './license/license-manager';
import { OverlayManager } from './overlay-manager';
import {
  appIconPath,
  licenseFilePath,
  preloadPath,
  rendererHtmlPath,
  settingsFilePath,
  settingsHtmlPath,
  settingsPreloadPath,
} from './paths';
import { SettingsStore } from './settings-store';
import { SETTINGS_WINDOW_TITLE, SettingsWindow } from './settings-window';
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
  license: LicenseManager;
  settingsWindow: SettingsWindow;
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
    log.info('second instance launched; opening the settings window of the running one');
    runtime?.settingsWindow.open();
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
  log.debug('cli', cli);

  const store = new SettingsStore({ filePath: settingsFilePath(), persist: !cli.smoke });
  store.load();

  const license = new LicenseManager({
    filePath: licenseFilePath(),
    persist: !cli.smoke,
    product: PRODUCT,
    // Chromium's network stack: honours the system proxy configuration.
    fetch: (url, init) => net.fetch(url, init),
    platform: process.platform,
    forceTier: app.isPackaged ? null : cli.forceTier,
  });
  license.load();
  const lang = pickLang(app.getLocale());

  /** What the overlays draw: the stored settings reduced to what the licence allows. */
  const effective = (): Settings => effectiveSettings(store.get(), license.pro);
  /** Every settings change from tray, shortcuts and windows goes through here. */
  const updateSettings = (patch: unknown): Settings => store.update(stripLockedChoices(patch, license.pro));

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
    getSettings: effective,
    updateSettings,
    getCapabilities: () => capabilities,
    maxDisplays: () => (license.pro ? Infinity : FREE_MAX_DISPLAYS),
  });

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

  const uiState = (): UiState => ({
    settings: store.get(),
    effective: effective(),
    license: license.status(),
    capabilities,
    version: app.getVersion(),
    platform: process.platform,
    displays: screen.getAllDisplays().length,
    lang,
    product: {
      name: PRODUCT.name,
      priceLabel: PRODUCT.priceLabel,
      trialDays: PRODUCT.trialDays,
      hasSponsor: PRODUCT.sponsorUrl.length > 0,
    },
  });

  let smokeRunner: SmokeRunner | null = null;
  const settingsWindow = new SettingsWindow({
    preloadPath: settingsPreloadPath,
    htmlPath: settingsHtmlPath,
    iconPath: appIconPath(),
    getState: uiState,
    updateSettings: (patch) => {
      updateSettings(patch);
    },
    activate: (key) => license.activate(key),
    deactivate: () => license.deactivate(),
    openLink: (link) => {
      const url = externalUrl(link);
      if (url) void shell.openExternal(url).catch((err: unknown) => log.warn(`could not open ${url}:`, err));
    },
    openSettingsFile,
    testBurst: () => testBurst(1),
    onReady: (report) => smokeRunner?.uiReady(report),
  });

  const tray = new TrayController({
    getSettings: effective,
    updateSettings,
    getCapabilities: () => capabilities,
    getLicense: () => license.status(),
    lang,
    testBurst: () => testBurst(1),
    openSettingsWindow: (focus) => settingsWindow.open(focus ?? null),
    openSettingsFile,
    quit,
  });

  runtime = { store, license, settingsWindow, overlays, cursor, activeWindow, tray, smoke: null, capabilities, shuttingDown: false };

  // ── Settings → everything else ─────────────────────────────────────────
  let lastEnabled: boolean | null = null;
  const applySettings = (s: Settings): void => {
    overlays.setVisible(s.enabled);
    activeWindow.setEnabled(s.enabled && s.burnActiveWindow && capabilities.activeWindow);
    if (lastEnabled !== s.enabled) log.info(s.enabled ? 'fire enabled' : 'fire paused');
    lastEnabled = s.enabled;
  };
  const broadcastSettings = (): void => {
    const next = effective();
    overlays.sendToAll(IPC.settings, () => next);
    applySettings(next);
    tray.refresh();
    settingsWindow.pushState();
  };
  store.onChange((next) => {
    log.debug('settings changed', next);
    broadcastSettings();
  });
  license.onChange((status) => {
    log.info(`licence: ${status.tier}${status.source ? ` (${status.source})` : ''}`);
    broadcastSettings();
    overlays.syncDisplays('licence changed');
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
    applySettings(store.get());
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
      { frames: cli.smokeFrames, timeoutMs: cli.smokeTimeoutMs, expectUi: true },
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
    smokeRunner = smoke;
    smoke.start();
    // The settings page must boot too (hidden: nobody looks at CI screens).
    settingsWindow.open(null, { show: false });
  } else {
    process.on('uncaughtException', (err) => log.error('uncaught exception:', err));
    process.on('unhandledRejection', (reason) => log.error('unhandled rejection:', reason));
  }

  // ── Go ─────────────────────────────────────────────────────────────────
  overlays.start(); // emits 'overlays-changed' → applySettings
  const hasTray = tray.create();
  registerShortcuts({
    getSettings: () => store.get(),
    isPro: () => license.pro,
    updateSettings,
    testBurst: () => testBurst(1),
    quit,
  });
  license.start();

  // First launch: say hello (a tray-only app is otherwise invisible until something burns).
  // Without a tray (some Linux desktops) the window is the only way to reach the settings.
  if (!cli.smoke && (license.isFirstRun || cli.openSettings || !hasTray)) {
    setTimeout(() => settingsWindow.open(license.isFirstRun ? 'welcome' : null), 1200);
  }
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

/**
 * Our own overlays: same process (macOS/Windows report the main pid) or the overlay
 * title (X11 reports a helper pid). The settings window is deliberately *not* “self”:
 * it burns like any other app, which doubles as a live preview of the settings.
 */
function isSelfWindow(info: ActiveWindowInfo): boolean {
  if (/^Prăjeal[aă] overlay$/.test(info.title)) return true;
  return info.pid === process.pid && info.title !== SETTINGS_WINDOW_TITLE;
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
  rt.license.stop();
  rt.settingsWindow.destroy();
  rt.cursor.stop();
  rt.activeWindow.stop();
  rt.tray.destroy();
  rt.store.flushSync();
  rt.overlays.destroy();
}
