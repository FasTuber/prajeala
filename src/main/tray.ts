/**
 * System tray icon + context menu. The menu is rebuilt from the current
 * settings/capabilities on every change (radio/checkbox state lives in main).
 */
import { Menu, Tray, nativeImage, type MenuItemConstructorOptions, type NativeImage } from 'electron';
import { existsSync, readFileSync } from 'node:fs';
import type { HostCapabilities } from '../shared/ipc';
import { PALETTE_DEFINITIONS } from '../shared/palettes';
import { CURSOR_MODES, INTENSITIES, PALETTES, type Settings } from '../shared/settings';
import { createLogger } from './log';
import { trayAssetPath } from './paths';

const log = createLogger('tray');

export const TRAY_TOOLTIP = 'Prăjeală — foc pe ecran';

/** 16×16 flame PNG used when assets/tray/* are missing (keeps the app usable from a bare checkout). */
const FALLBACK_ICON_DATA_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAhElEQVR42s2TIRKAMAwE+4h7HY/AYDAYDAaDwWAwGB7GNw5FmwTCtDMIOrMqe+sawm8fa1BSHmhASdm4BZ/IG3fgG+/jHszBDwxg5Kg04vY8HsGIHV8I5x6YwIgXEI4ez6DCCxgvBRZQ4QWMlwIrqPACxkuBDVR4AeOlwA4qvIDxPvl0J24EgbDFTAGYAAAAAElFTkSuQmCC';

const INTENSITY_LABELS: Record<Settings['intensity'], string> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  inferno: 'Inferno',
};

const CURSOR_LABELS: Record<Settings['cursorMode'], string> = {
  off: 'Off',
  halo: 'Halo',
  trail: 'Trail',
  comet: 'Comet',
};

const FPS_CHOICES = [30, 60, 120, 144] as const;
const QUALITY_CHOICES: ReadonlyArray<{ label: string; simScale: number }> = [
  { label: 'Low', simScale: 0.15 },
  { label: 'Medium', simScale: 0.25 },
  { label: 'High', simScale: 0.4 },
  { label: 'Ultra', simScale: 0.6 },
];

export interface TrayActions {
  getSettings(): Settings;
  updateSettings(patch: Partial<Settings>): void;
  getCapabilities(): HostCapabilities;
  testBurst(): void;
  openSettingsFile(): void;
  quit(): void;
}

export class TrayController {
  private tray: Tray | null = null;

  constructor(private readonly actions: TrayActions) {}

  /** Creates the tray; failures are logged (e.g. no status-notifier host on Linux) and never fatal. */
  create(): boolean {
    if (this.tray) return true;
    try {
      const icon = loadTrayIcon();
      this.tray = new Tray(icon);
      this.tray.setToolTip(TRAY_TOOLTIP);
      this.tray.on('click', () => {
        // Windows/Linux: left click opens the menu as well.
        if (process.platform !== 'darwin') this.tray?.popUpContextMenu();
      });
      this.refresh();
      log.info('tray created');
      return true;
    } catch (err) {
      log.warn('tray unavailable:', (err as Error).message);
      this.tray = null;
      return false;
    }
  }

  /** Rebuilds the context menu from the current settings/capabilities. */
  refresh(): void {
    if (!this.tray) return;
    try {
      this.tray.setContextMenu(Menu.buildFromTemplate(this.buildTemplate()));
      const s = this.actions.getSettings();
      this.tray.setToolTip(s.enabled ? TRAY_TOOLTIP : `${TRAY_TOOLTIP} (paused)`);
    } catch (err) {
      log.warn('menu rebuild failed:', err);
    }
  }

  destroy(): void {
    if (!this.tray) return;
    try {
      this.tray.destroy();
    } catch {
      /* ignore */
    }
    this.tray = null;
  }

  buildTemplate(): MenuItemConstructorOptions[] {
    const s = this.actions.getSettings();
    const caps = this.actions.getCapabilities();
    const set = (patch: Partial<Settings>) => () => this.actions.updateSettings(patch);
    // Shortcut hints only: the real bindings live in shortcuts.ts. GTK asserts when a
    // tray item carries an accelerator, so the hint goes into the label on Linux.
    const hint = (label: string, accelerator: string): Pick<MenuItemConstructorOptions, 'label' | 'accelerator' | 'registerAccelerator'> =>
      process.platform === 'linux'
        ? { label: `${label}  (${accelerator.replace('CommandOrControl', 'Ctrl')})` }
        : { label, accelerator, registerAccelerator: false };

    const intensity: MenuItemConstructorOptions[] = INTENSITIES.map((value) => ({
      label: INTENSITY_LABELS[value],
      type: 'radio',
      checked: s.intensity === value,
      click: set({ intensity: value }),
    }));

    const palette: MenuItemConstructorOptions[] = PALETTES.map((value) => ({
      label: PALETTE_DEFINITIONS[value].label,
      type: 'radio',
      checked: s.palette === value,
      click: set({ palette: value }),
    }));

    const cursor: MenuItemConstructorOptions[] = CURSOR_MODES.map((value) => ({
      label: CURSOR_LABELS[value],
      type: 'radio',
      checked: s.cursorMode === value,
      click: set({ cursorMode: value }),
    }));

    const fps: MenuItemConstructorOptions[] = FPS_CHOICES.map((value) => ({
      label: `${value} fps`,
      type: 'radio',
      checked: s.maxFps === value,
      click: set({ maxFps: value }),
    }));

    const quality: MenuItemConstructorOptions[] = QUALITY_CHOICES.map((q) => ({
      label: `${q.label} (${q.simScale})`,
      type: 'radio',
      checked: Math.abs(s.simScale - q.simScale) < 1e-6,
      click: set({ simScale: q.simScale }),
    }));

    return [
      {
        ...hint(s.enabled ? 'Pause' : 'Resume', 'CommandOrControl+Shift+F'),
        type: 'checkbox',
        checked: s.enabled,
        click: () => this.actions.updateSettings({ enabled: !this.actions.getSettings().enabled }),
      },
      { type: 'separator' },
      { label: 'Intensity', submenu: intensity },
      { label: 'Palette', submenu: palette },
      { label: 'Cursor fire', submenu: cursor },
      {
        label: caps.globalClicks ? 'Click bursts' : 'Click bursts (needs uiohook)',
        type: 'checkbox',
        checked: s.clickBursts,
        enabled: caps.globalClicks,
        click: () => this.actions.updateSettings({ clickBursts: !this.actions.getSettings().clickBursts }),
      },
      {
        label: caps.activeWindow ? 'Burn active window' : 'Burn active window (needs get-windows)',
        type: 'checkbox',
        checked: s.burnActiveWindow,
        enabled: caps.activeWindow,
        click: () => this.actions.updateSettings({ burnActiveWindow: !this.actions.getSettings().burnActiveWindow }),
      },
      {
        label: 'Screen bottom fire',
        type: 'checkbox',
        checked: s.screenBottomFire,
        click: () => this.actions.updateSettings({ screenBottomFire: !this.actions.getSettings().screenBottomFire }),
      },
      {
        label: 'Sparks',
        type: 'checkbox',
        checked: s.sparks,
        click: () => this.actions.updateSettings({ sparks: !this.actions.getSettings().sparks }),
      },
      {
        label: 'Debug HUD',
        type: 'checkbox',
        checked: s.showDebugHud,
        click: () => this.actions.updateSettings({ showDebugHud: !this.actions.getSettings().showDebugHud }),
      },
      { label: 'FPS', submenu: fps },
      { label: 'Quality', submenu: quality },
      {
        label: 'Launch at login',
        type: 'checkbox',
        checked: s.launchAtLogin,
        enabled: process.platform !== 'linux',
        click: () => this.actions.updateSettings({ launchAtLogin: !this.actions.getSettings().launchAtLogin }),
      },
      { type: 'separator' },
      { ...hint('Test burst', 'CommandOrControl+Shift+B'), click: () => this.actions.testBurst() },
      { label: 'Open settings file', click: () => this.actions.openSettingsFile() },
      { type: 'separator' },
      { ...hint('Quit Prăjeală', 'CommandOrControl+Shift+Q'), click: () => this.actions.quit() },
    ];
  }
}

/**
 * Loads the tray icon from assets/tray (template image on macOS, 16+32 px
 * representations elsewhere) and falls back to an inline PNG.
 */
export function loadTrayIcon(): NativeImage {
  try {
    if (process.platform === 'darwin') {
      const template = trayAssetPath('trayTemplate.png');
      if (existsSync(template)) {
        // Electron picks trayTemplate@2x.png automatically and treats the *Template suffix as a template image.
        const img = nativeImage.createFromPath(template);
        if (!img.isEmpty()) {
          img.setTemplateImage(true);
          return img;
        }
      }
    }
    const p16 = trayAssetPath('tray-16.png');
    const p32 = trayAssetPath('tray-32.png');
    const img = nativeImage.createEmpty();
    let added = 0;
    if (existsSync(p16)) {
      img.addRepresentation({ scaleFactor: 1, buffer: readFileSync(p16) });
      added++;
    }
    if (existsSync(p32)) {
      img.addRepresentation({ scaleFactor: 2, buffer: readFileSync(p32) });
      added++;
    }
    if (added > 0 && !img.isEmpty()) return img;
    if (existsSync(p32)) {
      const single = nativeImage.createFromPath(p32);
      if (!single.isEmpty()) return single;
    }
  } catch (err) {
    log.debug('tray asset load failed:', err);
  }
  log.warn('tray icon assets missing, using inline fallback icon');
  const fallback = nativeImage.createFromDataURL(FALLBACK_ICON_DATA_URL);
  if (process.platform === 'darwin') fallback.setTemplateImage(false);
  return fallback;
}
