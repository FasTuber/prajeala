/**
 * Prăjeală — main process entry (ESM, bundled to dist/main/index.mjs).
 *
 * Wires: CLI flags → Chromium switches → settings store + licence → overlay windows →
 * cursor / active-window trackers → tray, settings window, global shortcuts →
 * optional smoke run.
 * This is a tray application: closing every window never quits; only the
 * tray, the global shortcut or the smoke runner do.
 */
import { app, dialog, net, Notification, screen, shell } from 'electron';
import type { AudioStatusReport } from '../shared/audio-contract';
import type { BurnMode } from '../shared/burn';
import { formatClock } from '../shared/focus';
import { pickLang, translator } from '../shared/i18n';
import {
  IPC,
  type ActiveWindowEvent,
  type CursorEvent,
  type HostCapabilities,
  type PointerButtonEvent,
  type Rect,
  type UiState,
} from '../shared/ipc';
import { applyPowerProfile, coversDisplay, isDesktopShell } from '../shared/power';
import { FREE_MAX_DISPLAYS, effectiveSettings, stripLockedChoices } from '../shared/pro';
import { PRODUCT, externalUrl } from '../shared/product';
import type { Settings } from '../shared/settings';
import { ActiveWindowTracker, type ActiveWindowInfo } from './active-window-tracker';
import { parseCli, type CliOptions } from './cli';
import { CursorTracker, type CursorSample } from './cursor-tracker';
import { rectCenter, rectContainsPoint, rectsIntersect, toLocalPoint, toLocalRect } from './geometry';
import { createLogger, setVerbose } from './log';
import { LicenseManager } from './license/license-manager';
import { BurnController } from './burn';
import { FocusService } from './focus-service';
import { MediaHost, hardenDefaultSession } from './media-host';
import { OverlayManager } from './overlay-manager';
import { PowerGovernor } from './power-governor';
import {
  appIconPath,
  licenseFilePath,
  mediaHtmlPath,
  mediaPreloadPath,
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
if (process.platform === 'linux') {
  // Ritmul Focului: lets getDisplayMedia capture the PulseAudio/PipeWire monitor (system sound).
  // Merged with any --enable-features given on the command line (a second switch would replace it).
  const existing = app.commandLine.getSwitchValue('enable-features');
  app.commandLine.appendSwitch('enable-features', [existing, 'PulseaudioLoopbackForScreenShare'].filter(Boolean).join(','));
}
if (process.platform === 'linux' && cli.linuxTransparentVisuals) {
  // Legacy X11 setups: transparent windows only work with these two switches.
  app.commandLine.appendSwitch('enable-transparent-visuals');
  app.commandLine.appendSwitch('disable-gpu-compositing');
}

interface Runtime {
  store: SettingsStore;
  mediaHost: MediaHost;
  focus: FocusService;
  governor: PowerGovernor;
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

  // No text field needs spell-checking, and on Linux the checker downloads Hunspell
  // dictionaries from Google as soon as a session exists: keep the app silent on the
  // network (licence checks aside). Must run before the default session is created.
  app.on('session-created', (s) => {
    s.setSpellCheckerEnabled(false);
    s.setSpellCheckerLanguages([]);
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
  // Windows only shows toasts for an AppUserModelID that matches the installer's shortcut.
  if (process.platform === 'win32') app.setAppUserModelId('ro.codulzilei.prajeala');
  log.info(`Prăjeală ${app.getVersion()} — electron ${process.versions.electron}, ${process.platform}/${process.arch}`);
  log.debug('cli', cli);

  // Overlays and the settings window never need camera/mic/notifications…: deny all on their session.
  hardenDefaultSession();

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

  const governor = new PowerGovernor(() => store.get());
  /** What the overlays draw: the stored settings reduced to what the licence and the power profile allow. */
  const effective = (): Settings => applyPowerProfile(effectiveSettings(store.get(), license.pro), governor.current);
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
    onMove: (sample) => {
      governor.noteInput();
      broadcastCursor(overlays, sample);
    },
    onKey: () => {
      governor.noteInput();
      const s = effective();
      if (s.enabled && s.typingFire) overlays.sendToAll(IPC.keyPress, () => null);
    },
    onButton: (sample, button, type) => {
      governor.noteInput();
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
  /** Displays currently hidden because a fullscreen app covers them (game mode). */
  let gameDisplays = new Set<number>();
  const updateGameMode = (): void => {
    const s = store.get();
    const next = new Set<number>();
    const w = lastActiveWindow;
    if (s.gameMode && w && !isSelfWindow(w) && !isDesktopShell(w.app, w.title, process.platform)) {
      for (const d of overlays.displayBounds()) if (coversDisplay(w.bounds, d.bounds)) next.add(d.id);
    }
    const changed = next.size !== gameDisplays.size || [...next].some((id) => !gameDisplays.has(id));
    if (!changed) return;
    log.info(next.size ? `game mode: fullscreen app "${w?.app ?? ''}", hiding ${next.size} overlay(s)` : 'game mode: fullscreen app gone');
    gameDisplays = next;
    overlays.setSuppressed(gameDisplays);
    // May run before the tray/settings window exist (first active-window poll).
    runtime?.tray.refresh();
    runtime?.settingsWindow.pushState();
  };
  const activeWindow = new ActiveWindowTracker({
    hz: cli.windowHz,
    allowed: !cli.noActiveWindow,
    onChange: (info) => {
      lastActiveWindow = info;
      broadcastActiveWindow(overlays, info);
      updateGameMode();
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

  // ── Arde tot ─────────────────────────────────────────────────────────
  /** Arde tot → window: the focused window queried right before the burn. */
  let burnWindow: ActiveWindowInfo | null = null;
  const burn = new BurnController({
    overlays,
    readCursor: () => cursor.readPoint(),
    activeWindow: () => {
      const w = burnWindow ?? lastActiveWindow;
      return w && !isSelfWindow(w) ? w : null;
    },
  });
  const startBurn = async (mode: BurnMode): Promise<void> => {
    const tt = translator(lang);
    if (governor.current.paused) return;
    if (!store.get().enabled) updateSettings({ enabled: true });
    let imagePath: string | undefined;
    if (mode === 'image') {
      const res = await dialog.showOpenDialog({
        title: tt('burnPickImage'),
        properties: ['openFile'],
        filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'] }],
      });
      if (res.canceled || !res.filePaths[0]) return;
      imagePath = res.filePaths[0];
    }
    // The poller may be off (fire paused, no window fire, no game mode): ask once.
    burnWindow = mode === 'window' ? await activeWindow.queryOnce() : null;
    const outcome = await burn.start(mode, { imagePath }).finally(() => {
      burnWindow = null;
    });
    if (outcome.reason === 'permission') {
      const r = await dialog.showMessageBox({
        type: 'info',
        title: tt('burnPermissionTitle'),
        message: tt('burnPermissionTitle'),
        detail: tt('burnPermissionBody'),
        buttons: [tt('burnPermissionOpen'), tt('burnPermissionImage'), tt('cancel')],
        defaultId: 0,
        cancelId: 2,
      });
      if (r.response === 0) void shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture');
      else if (r.response === 1) void startBurn('image');
    } else if (outcome.reason === 'no-window') {
      void dialog.showMessageBox({ type: 'info', message: tt('burnNoWindow'), buttons: ['OK'] });
    } else if (!outcome.ok && outcome.reason !== 'busy') {
      log.warn(`burn did not run: ${outcome.reason ?? 'unknown'}${outcome.error ? ` (${outcome.error})` : ''}`);
    }
  };

  // ── Ritmul Focului ───────────────────────────────────────────────────
  const mediaHost = new MediaHost({ preloadPath: mediaPreloadPath, htmlPath: mediaHtmlPath });
  let audioStatus: AudioStatusReport = { status: 'off', source: null };
  let audioRunning: 'system' | 'mic' | null = null;
  /**
   * A source that just failed (denied / unsupported / error). It is not retried on
   * unrelated settings changes, only once the user picks something else (or off) and
   * comes back to it.
   */
  let audioFailed: 'system' | 'mic' | null = null;
  /** The stored choice last seen: only a change of it (not pausing or locking) clears a failure. */
  let audioChoice = store.get().audioSource;
  let lastLevelPush = 0;
  const syncAudio = (): void => {
    const s = store.get();
    if (s.audioSource !== audioChoice) {
      audioChoice = s.audioSource;
      audioFailed = null;
    }
    const want = s.audioSource !== 'off' && s.enabled && !governor.current.paused && !cli.smoke ? s.audioSource : null;
    if (want && want === audioFailed) return;
    if (want && want !== audioRunning) {
      audioRunning = want;
      mediaHost.start({ source: want, sensitivity: s.audioSensitivity });
    } else if (want) {
      mediaHost.setSensitivity(s.audioSensitivity);
    } else if (!want && (audioRunning || audioStatus.status !== 'off')) {
      // Also after a failure: closes the idle capture page and clears the error shown.
      audioRunning = null;
      mediaHost.stop();
    }
  };
  mediaHost.on('frame', (frame) => {
    overlays.sendToAll(IPC.audio, () => frame);
    // Music playing counts as presence: the fire keeps dancing while you listen.
    if (!frame.silent && frame.loud > 0.12) governor.noteInput();
    const now = Date.now();
    if (now - lastLevelPush >= 66) {
      lastLevelPush = now;
      settingsWindow.sendAudioLevel({ level: frame.loud, bands: frame.bands });
    }
  });
  mediaHost.on('status', (report) => {
    audioStatus = report;
    if ((report.status === 'denied' || report.status === 'unsupported' || report.status === 'error') && audioRunning) {
      audioFailed = audioRunning;
      audioRunning = null;
    }
    log.info(`audio: ${report.status}${report.source ? ` (${report.source})` : ''}${report.detail ? ` — ${report.detail}` : ''}`);
    settingsWindow.pushState();
  });

  // ── Termen limită ────────────────────────────────────────────────────
  const focus = new FocusService(() => translator(lang)('focusDoneWord'));
  const startFocus = (minutes: number): void => {
    if (!store.get().enabled) updateSettings({ enabled: true });
    focus.start(minutes);
    log.info(`focus: ${minutes} min fuse lit`);
  };
  /** Tray label: whole minutes (seconds in the last one), so the menu is rebuilt about once a minute. */
  const focusTrayLabel = (): string => {
    if (focus.phase === 'idle') return '';
    const ms = focus.remainingMs;
    return ms < 60_000 ? formatClock(ms) : `${Math.ceil(ms / 60_000)} min`;
  };
  let lastFocusTray = '';
  focus.on('frame', (frame) => {
    overlays.sendToAll(IPC.focusTimer, () => frame);
    const key = `${frame.phase}|${focusTrayLabel()}`;
    if (key !== lastFocusTray) {
      lastFocusTray = key;
      runtime?.tray.refresh();
    }
    runtime?.settingsWindow.pushState();
  });
  focus.on('finished', ({ durationMs }) => {
    log.info('focus: time is up');
    if (cli.smoke || !Notification.isSupported()) return;
    const tt = translator(lang);
    const icon = appIconPath();
    new Notification({
      title: tt('focusDoneTitle'),
      body: tt('focusDoneBody', { n: Math.round(durationMs / 60_000) }),
      silent: false,
      ...(icon ? { icon } : {}),
    }).show();
  });

  const uiState = (): UiState => ({
    settings: store.get(),
    effective: effective(),
    license: license.status(),
    capabilities,
    version: app.getVersion(),
    platform: process.platform,
    displays: screen.getAllDisplays().length,
    lang,
    power: { ...governor.current, gameDisplays: gameDisplays.size },
    audio: {
      status: audioStatus.status,
      source: audioStatus.source,
      level: 0,
      bands: [],
      ...(audioStatus.detail ? { detail: audioStatus.detail } : {}),
    },
    focus: { phase: focus.phase, remainingMs: focus.remainingMs, durationMs: focus.durationMs },
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
    burn: (mode) => void startBurn(mode),
    focusAction: (action) => {
      if (action.type === 'start') startFocus(action.minutes);
      else if (action.type === 'pause') focus.pause();
      else if (action.type === 'resume') focus.resume();
      else focus.cancel();
    },
    onReady: (report) => smokeRunner?.uiReady(report),
  });

  const tray = new TrayController({
    getSettings: effective,
    updateSettings,
    getCapabilities: () => capabilities,
    getLicense: () => license.status(),
    getStatus: () => {
      const tt = translator(lang);
      const p = governor.current;
      if (p.reason === 'locked') return tt('paused');
      if (p.reason === 'battery') return tt('batteryPause');
      if (p.sleeping) return tt('traySleeping');
      if (gameDisplays.size > 0) return tt('trayGamePaused');
      return p.eco ? tt('powerEco') : '';
    },
    lang,
    testBurst: () => testBurst(1),
    burn: (mode) => void startBurn(mode),
    focus: {
      state: () => ({ phase: focus.phase, label: focusTrayLabel() }),
      start: startFocus,
      togglePause: () => focus.togglePause(),
      cancel: () => focus.cancel(),
    },
    openSettingsWindow: (focus) => settingsWindow.open(focus ?? null),
    openSettingsFile,
    quit,
  });

  runtime = { store, mediaHost, focus, governor, license, settingsWindow, overlays, cursor, activeWindow, tray, smoke: null, capabilities, shuttingDown: false };

  // ── Settings → everything else ─────────────────────────────────────────
  let lastEnabled: boolean | null = null;
  const applySettings = (s: Settings): void => {
    overlays.setVisible(s.enabled && !governor.current.paused);
    activeWindow.setEnabled(s.enabled && (s.burnActiveWindow || s.gameMode) && capabilities.activeWindow);
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
    governor.evaluate();
    broadcastSettings();
    updateGameMode();
    syncAudio();
  });
  governor.onChange((power) => {
    overlays.sendToAll(IPC.power, () => ({ sleeping: power.sleeping }));
    broadcastSettings(); // eco profile, paused visibility, tray tooltip, settings window
    syncAudio();
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
    overlays.sendTo(overlay, IPC.power, { sleeping: governor.current.sleeping });
    if (focus.phase !== 'idle') overlays.sendTo(overlay, IPC.focusTimer, focus.frame);
  });

  // ── Smoke mode ─────────────────────────────────────────────────────────
  if (cli.smoke) {
    const smoke = new SmokeRunner(
      { frames: cli.smokeFrames, timeoutMs: cli.smokeTimeoutMs, expectUi: true, expectBurn: true },
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
    // Arde tot end to end: capture the (Xvfb) screen, burn it, get the overlay's report.
    overlays.once('ready', () => {
      setTimeout(() => {
        void burn.start('screen', { durationMs: 2500 }).then((outcome) => {
          smoke.burnResult(outcome);
          // Termen limită end to end (fuse, countdown, blaze) — must not disturb the run.
          focus.start(3 / 60);
        });
      }, 800);
    });
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
    burn: () => void startBurn('screen'),
    quit,
  });
  license.start();
  if (!cli.smoke) governor.start();
  syncAudio(); // smoke runs on an idle Xvfb display: never let it sleep

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
  rt.governor.stop();
  rt.mediaHost.destroy();
  rt.focus.destroy();
  rt.license.stop();
  rt.settingsWindow.destroy();
  rt.cursor.stop();
  rt.activeWindow.stop();
  rt.tray.destroy();
  rt.store.flushSync();
  rt.overlays.destroy();
}
