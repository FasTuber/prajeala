/**
 * System tray icon + context menu. The menu is rebuilt from the current
 * settings/capabilities on every change (radio/checkbox state lives in main).
 */
import { Menu, Tray, nativeImage, type MenuItemConstructorOptions, type NativeImage } from 'electron';
import { existsSync, readFileSync } from 'node:fs';
import type { AudioStatus, HostCapabilities } from '../shared/ipc';
import { applyTierLimits, isIntensityAllowed, isPaletteAllowed, limitsFor, type LicenseInfo } from '../shared/license';
import { PALETTE_DEFINITIONS } from '../shared/palettes';
import { AUDIO_SOURCES, CURSOR_MODES, INTENSITIES, PALETTES, type AudioSource, type Settings } from '../shared/settings';
import type { ThemeDefinition } from '../shared/theme';
import { createLogger } from './log';
import { trayAssetPath } from './paths';

const log = createLogger('tray');

export const TRAY_TOOLTIP = 'Prăjeală — foc pe ecran';
const PRO_SUFFIX = '  (Pro)';

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

const AUDIO_SOURCE_LABELS: Record<AudioSource, string> = {
  microphone: 'Microphone',
  system: 'System audio',
};
const AUDIO_GAIN_CHOICES: ReadonlyArray<{ label: string; gain: number }> = [
  { label: 'Low', gain: 0.5 },
  { label: 'Normal', gain: 1 },
  { label: 'High', gain: 2 },
  { label: 'Max', gain: 4 },
];

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
  getLicense(): LicenseInfo;
  /** Latest sound-reactivity status reported by the overlays (null = nothing yet). */
  getAudioStatus(): AudioStatus | null;
  /** Imported themes on disk. */
  listThemes(): ThemeDefinition[];
  importTheme(): void;
  exportTheme(): void;
  openThemesFolder(): void;
  testBurst(): void;
  openSettingsFile(): void;
  openLicenseWindow(): void;
  activateLicenseFromClipboard(): void;
  checkLicenseOnline(): void;
  openBuyPage(): void;
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
    const stored = this.actions.getSettings();
    const caps = this.actions.getCapabilities();
    const license = this.actions.getLicense();
    const tier = license.tier;
    // Radios reflect what the renderer actually runs (stored values above the tier's limits are clamped).
    const s = applyTierLimits(stored, tier);
    const set = (patch: Partial<Settings>) => () => this.actions.updateSettings(patch);
    const lock = (label: string, locked: boolean): string => (locked ? `${label}${PRO_SUFFIX}` : label);
    // Shortcut hints only: the real bindings live in shortcuts.ts. GTK asserts when a
    // tray item carries an accelerator, so the hint goes into the label on Linux.
    const hint = (label: string, accelerator: string): Pick<MenuItemConstructorOptions, 'label' | 'accelerator' | 'registerAccelerator'> =>
      process.platform === 'linux'
        ? { label: `${label}  (${accelerator.replace('CommandOrControl', 'Ctrl')})` }
        : { label, accelerator, registerAccelerator: false };

    const intensity: MenuItemConstructorOptions[] = INTENSITIES.map((value) => {
      const allowed = isIntensityAllowed(tier, value);
      return {
        label: lock(INTENSITY_LABELS[value], !allowed),
        type: 'radio',
        checked: s.intensity === value,
        enabled: allowed,
        click: set({ intensity: value }),
      };
    });

    const palette: MenuItemConstructorOptions[] = PALETTES.map((value) => {
      const allowed = isPaletteAllowed(tier, value);
      return {
        label: lock(PALETTE_DEFINITIONS[value].label, !allowed),
        type: 'radio',
        checked: s.themeId === '' && s.palette === value,
        enabled: allowed,
        click: set({ palette: value, themeId: '' }),
      };
    });
    const themesAllowed = limitsFor(tier).customThemes;
    const customThemes = safeList(() => this.actions.listThemes());
    if (customThemes.length > 0) {
      palette.push({ type: 'separator' });
      for (const theme of customThemes) {
        palette.push({
          label: lock(theme.name, !themesAllowed),
          type: 'radio',
          checked: s.themeId === theme.id,
          enabled: themesAllowed,
          click: set({ themeId: theme.id }),
        });
      }
    }
    palette.push(
      { type: 'separator' },
      { label: lock('Import theme…', !themesAllowed), enabled: themesAllowed, click: () => this.actions.importTheme() },
      { label: 'Export current theme…', click: () => this.actions.exportTheme() },
      { label: 'Open themes folder', click: () => this.actions.openThemesFolder() },
    );
    const windowAllowed = limitsFor(tier).burnActiveWindow;
    const audioAllowed = limitsFor(tier).audioReactive;

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
      { label: 'Theme', submenu: palette },
      { label: 'Cursor fire', submenu: cursor },
      {
        label: caps.globalClicks ? 'Click bursts' : 'Click bursts (needs uiohook)',
        type: 'checkbox',
        checked: s.clickBursts,
        enabled: caps.globalClicks,
        click: () => this.actions.updateSettings({ clickBursts: !this.actions.getSettings().clickBursts }),
      },
      {
        label: lock(caps.activeWindow ? 'Burn active window' : 'Burn active window (needs get-windows)', !windowAllowed),
        type: 'checkbox',
        checked: s.burnActiveWindow,
        enabled: caps.activeWindow && windowAllowed,
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
        label: lock('Sound reactive', !audioAllowed),
        type: 'checkbox',
        checked: s.audioReactive,
        enabled: audioAllowed,
        click: () => this.actions.updateSettings({ audioReactive: !this.actions.getSettings().audioReactive }),
      },
      { label: 'Sound', submenu: this.buildAudioSubmenu(s, caps, audioAllowed) },
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
      { label: licenseLabel(license), submenu: this.buildLicenseSubmenu(license, s) },
      { type: 'separator' },
      { ...hint('Test burst', 'CommandOrControl+Shift+B'), click: () => this.actions.testBurst() },
      { label: 'Open settings file', click: () => this.actions.openSettingsFile() },
      { type: 'separator' },
      { ...hint('Quit Prăjeală', 'CommandOrControl+Shift+Q'), click: () => this.actions.quit() },
    ];
  }

  private buildAudioSubmenu(s: Settings, caps: HostCapabilities, allowed: boolean): MenuItemConstructorOptions[] {
    const status = this.actions.getAudioStatus();
    const items: MenuItemConstructorOptions[] = [{ label: audioStatusLabel(s, status), enabled: false }, { type: 'separator' }];
    for (const value of AUDIO_SOURCES) {
      const loopback = value === 'system';
      const supported = !loopback || caps.audioLoopback === true;
      items.push({
        label: loopback && !supported ? `${AUDIO_SOURCE_LABELS[value]} (Windows only; falls back to the microphone)` : AUDIO_SOURCE_LABELS[value],
        type: 'radio',
        checked: s.audioSource === value,
        enabled: allowed,
        click: () => this.actions.updateSettings({ audioSource: value }),
      });
    }
    items.push({ type: 'separator' });
    for (const g of AUDIO_GAIN_CHOICES) {
      items.push({
        label: `Sensitivity: ${g.label}`,
        type: 'radio',
        checked: Math.abs(s.audioGain - g.gain) < 1e-6,
        enabled: allowed,
        click: () => this.actions.updateSettings({ audioGain: g.gain }),
      });
    }
    return items;
  }

  private buildLicenseSubmenu(license: LicenseInfo, s: Settings): MenuItemConstructorOptions[] {
    const hasKey = license.kind !== 'none';
    const canCheck = hasKey && !license.busy && license.canCheckOnline;
    const items: MenuItemConstructorOptions[] = [
      { label: license.message, enabled: false },
    ];
    if (license.name || license.email) items.push({ label: [license.name, license.email].filter(Boolean).join(' · '), enabled: false });
    if (license.lastOnlineCheckAt) {
      items.push({
        label: `Last online check: ${license.lastOnlineCheckAt.slice(0, 10)} (${license.lastOnlineResult ?? 'n/a'})`,
        enabled: false,
      });
    }
    items.push(
      { type: 'separator' },
      { label: hasKey ? 'Manage licence…' : 'Enter licence key…', click: () => this.actions.openLicenseWindow() },
      { label: 'Activate key from clipboard', enabled: !license.busy, click: () => this.actions.activateLicenseFromClipboard() },
      { label: 'Check licence online now', enabled: canCheck, click: () => this.actions.checkLicenseOnline() },
      {
        label: 'Re-verify online periodically',
        type: 'checkbox',
        checked: s.licenseOnlineCheck,
        click: () => this.actions.updateSettings({ licenseOnlineCheck: !this.actions.getSettings().licenseOnlineCheck }),
      },
    );
    if (license.tier !== 'pro') {
      items.push({ type: 'separator' }, { label: 'Buy Prăjeală Pro…', click: () => this.actions.openBuyPage() });
    }
    return items;
  }
}

function safeList<T>(fn: () => T[]): T[] {
  try {
    return fn();
  } catch (err) {
    log.warn('could not list themes:', err);
    return [];
  }
}

export function audioStatusLabel(s: Settings, status: AudioStatus | null): string {
  if (!s.audioReactive) return 'Sound reactivity is off';
  if (!status) return 'Sound: starting…';
  const src = AUDIO_SOURCE_LABELS[status.source].toLowerCase();
  switch (status.state) {
    case 'active':
      return `Sound: listening to the ${src}${status.message?.startsWith('simulated') ? ' (simulated)' : ''}`;
    case 'starting':
      return `Sound: opening the ${src}…`;
    case 'denied':
      return 'Sound: microphone access denied (check the OS privacy settings)';
    case 'unavailable':
      return 'Sound: no audio input device found';
    case 'off':
      return 'Sound: stopped';
    default:
      return `Sound: error${status.message ? ` — ${status.message}` : ''}`;
  }
}

export function licenseLabel(license: LicenseInfo): string {
  if (license.tier === 'pro') return `Licence: Pro${license.busy ? ' (checking…)' : ''}`;
  switch (license.status) {
    case 'none':
      return 'Licence: Free';
    case 'unverified':
      return 'Licence: Free (key needs online verification)';
    case 'expired':
      return 'Licence: Free (key expired)';
    case 'revoked':
      return 'Licence: Free (key revoked)';
    case 'unsupported':
      return 'Licence: Free (signed keys unsupported)';
    default:
      return 'Licence: Free (invalid key)';
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
