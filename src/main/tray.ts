/**
 * System tray icon + context menu. The menu is rebuilt from the current
 * settings/capabilities on every change (radio/checkbox state lives in main).
 */
import { Menu, Tray, nativeImage, type MenuItemConstructorOptions, type NativeImage } from 'electron';
import { existsSync, readFileSync } from 'node:fs';
import {
  CURSOR_LABELS,
  INTENSITY_LABELS,
  QUALITY_LABELS,
  QUALITY_PRESETS,
  paletteLabel,
  translator,
  type Lang,
} from '../shared/i18n';
import type { HostCapabilities } from '../shared/ipc';
import type { LicenseStatus } from '../shared/license';
import { FOCUS_PRESETS_MIN, type FocusPhase } from '../shared/focus';
import { isIntensityLocked, isPaletteLocked } from '../shared/pro';
import { SCENES, SCENE_EMOJI, activeScene, sceneNeedsPro, scenePatch, type Scene } from '../shared/scenes';
import { PRODUCT } from '../shared/product';
import { CURSOR_MODES, INTENSITIES, PALETTES, ZMEU_TEMPERS, type Settings, type ZmeuTemper } from '../shared/settings';
import { createLogger } from './log';
import { trayAssetPath } from './paths';

const log = createLogger('tray');

/** 16×16 flame PNG used when assets/tray/* are missing (keeps the app usable from a bare checkout). */
const FALLBACK_ICON_DATA_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAhElEQVR42s2TIRKAMAwE+4h7HY/AYDAYDAaDwWAwGB7GNw5FmwTCtDMIOrMqe+sawm8fa1BSHmhASdm4BZ/IG3fgG+/jHszBDwxg5Kg04vY8HsGIHV8I5x6YwIgXEI4ez6DCCxgvBRZQ4QWMlwIrqPACxkuBDVR4AeOlwA4qvIDxPvl0J24EgbDFTAGYAAAAAElFTkSuQmCC';

const FPS_CHOICES = [30, 60, 120, 144] as const;

export interface TrayActions {
  getSettings(): Settings;
  updateSettings(patch: Partial<Settings>): void;
  getCapabilities(): HostCapabilities;
  getLicense(): LicenseStatus;
  /** Short state suffix for the tooltip ('' when burning normally). */
  getStatus(): string;
  lang: Lang;
  testBurst(): void;
  /** Arde tot (screen / focused window / an image the user picks). */
  burn(mode: 'screen' | 'window' | 'image'): void;
  /** Termen limită: the focus timer (label = remaining time, '' when idle). */
  focus: {
    state(): { phase: FocusPhase; label: string };
    start(minutes: number): void;
    togglePause(): void;
    cancel(): void;
  };
  /** Zmeul: "call the dragon" to the cursor. */
  zmeuCall(): void;
  /** Opens the settings window; `pro` scrolls to the Prăjeală Pro card. */
  openSettingsWindow(focus?: 'pro'): void;
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
      this.tray.setToolTip(translator(this.actions.lang)('tooltip'));
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

  /** Rebuilds the context menu from the current settings/capabilities/licence. */
  refresh(): void {
    if (!this.tray) return;
    try {
      this.tray.setContextMenu(Menu.buildFromTemplate(this.buildTemplate()));
      const t = translator(this.actions.lang);
      const s = this.actions.getSettings();
      const status = s.enabled ? this.actions.getStatus() : t('paused');
      this.tray.setToolTip(status ? `${t('tooltip')} (${status})` : t('tooltip'));
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
    const lang = this.actions.lang;
    const t = translator(lang);
    const s = this.actions.getSettings();
    const caps = this.actions.getCapabilities();
    const license = this.actions.getLicense();
    const pro = license.pro;
    const set = (patch: Partial<Settings>) => () => this.actions.updateSettings(patch);
    const toggle = (
      key: 'clickBursts' | 'burnActiveWindow' | 'screenBottomFire' | 'sparks' | 'showDebugHud' | 'launchAtLogin' | 'gameMode' | 'idleSleep',
    ) => () =>
      this.actions.updateSettings({ [key]: !this.actions.getSettings()[key] });
    const upsell = () => this.actions.openSettingsWindow('pro');
    const locked = (label: string): MenuItemConstructorOptions => ({ label: t('proLocked', { label }), click: upsell });
    // Shortcut hints only: the real bindings live in shortcuts.ts. GTK asserts when a
    // tray item carries an accelerator, so the hint goes into the label on Linux.
    const hint = (label: string, accelerator: string): Pick<MenuItemConstructorOptions, 'label' | 'accelerator' | 'registerAccelerator'> =>
      process.platform === 'linux'
        ? { label: `${label}  (${accelerator.replace('CommandOrControl', 'Ctrl')})` }
        : { label, accelerator, registerAccelerator: false };

    const intensity: MenuItemConstructorOptions[] = INTENSITIES.map((value) =>
      isIntensityLocked(value, pro)
        ? locked(INTENSITY_LABELS[lang][value])
        : { label: INTENSITY_LABELS[lang][value], type: 'radio', checked: s.intensity === value, click: set({ intensity: value }) },
    );

    const palette: MenuItemConstructorOptions[] = PALETTES.map((value) =>
      isPaletteLocked(value, pro)
        ? locked(paletteLabel(lang, value))
        : { label: paletteLabel(lang, value), type: 'radio', checked: s.palette === value, click: set({ palette: value }) },
    );

    const cursor: MenuItemConstructorOptions[] = CURSOR_MODES.map((value) => ({
      label: CURSOR_LABELS[lang][value],
      type: 'radio',
      checked: s.cursorMode === value,
      click: set({ cursorMode: value }),
    }));

    const audioLabels = { off: t('audioOff'), system: t('audioSystem'), mic: t('audioMic') } as const;
    const audio: MenuItemConstructorOptions[] = (['off', 'system', 'mic'] as const).map((value) => ({
      label: audioLabels[value],
      type: 'radio',
      checked: s.audioSource === value,
      click: set({ audioSource: value }),
    }));

    const sceneLabels: Record<Scene, string> = {
      classic: t('sceneClassic'),
      hearth: t('sceneHearth'),
      subtle: t('sceneSubtle'),
      party: t('sceneParty'),
      inferno: t('sceneInferno'),
      haunted: t('sceneHaunted'),
    };
    // Radio state follows what actually burns (scenes never touch the keys the power profile changes).
    const current = activeScene(s);
    const scenes: MenuItemConstructorOptions[] = SCENES.map((scene) => {
      const label = `${SCENE_EMOJI[scene]} ${sceneLabels[scene]}`;
      return sceneNeedsPro(scene) && !pro
        ? locked(label)
        : { label, type: 'radio', checked: current === scene, click: () => this.actions.updateSettings(scenePatch(scene, pro)) };
    });

    // Zmeul (Pro): on/off, temper, and "call" while it is out.
    const temperLabels: Record<ZmeuTemper, string> = { calm: t('zmeuCalm'), playful: t('zmeuPlayful'), wild: t('zmeuWild') };
    const zmeu: MenuItemConstructorOptions = pro
      ? {
          label: `🐉 ${t('zmeu')}`,
          submenu: [
            { label: t('zmeu'), type: 'checkbox', checked: s.zmeu, click: () => this.actions.updateSettings({ zmeu: !this.actions.getSettings().zmeu }) },
            { type: 'separator' },
            ...ZMEU_TEMPERS.map(
              (value): MenuItemConstructorOptions => ({ label: temperLabels[value], type: 'radio', checked: s.zmeuTemper === value, click: set({ zmeuTemper: value }) }),
            ),
            { type: 'separator' },
            { label: `🐉 ${t('zmeuCall')}`, enabled: s.enabled && s.zmeu, click: () => this.actions.zmeuCall() },
          ],
        }
      : locked(`🐉 ${t('zmeu')}`);

    const fs = this.actions.focus.state();
    const focusItems: MenuItemConstructorOptions[] =
      fs.phase === 'running' || fs.phase === 'paused'
        ? [
            { label: fs.phase === 'paused' ? t('focusResume') : t('focusPause'), click: () => this.actions.focus.togglePause() },
            { label: t('focusStop'), click: () => this.actions.focus.cancel() },
          ]
        : FOCUS_PRESETS_MIN.map((n) => ({
            label: `${t('focusStart')}: ${t('focusMinutes', { n })}`,
            enabled: fs.phase === 'idle',
            click: () => {
              this.actions.updateSettings({ focusMinutes: n });
              this.actions.focus.start(n);
            },
          }));

    const fps: MenuItemConstructorOptions[] = FPS_CHOICES.map((value) => ({
      label: `${value} fps`,
      type: 'radio',
      checked: s.maxFps === value,
      click: set({ maxFps: value }),
    }));

    const quality: MenuItemConstructorOptions[] = QUALITY_PRESETS.map((q) => ({
      label: `${QUALITY_LABELS[lang][q.key]} (${q.simScale})`,
      type: 'radio',
      checked: Math.abs(s.simScale - q.simScale) < 1e-6,
      click: set({ simScale: q.simScale }),
    }));

    const status: MenuItemConstructorOptions =
      license.tier === 'pro'
        ? { label: t('trayPro'), enabled: false }
        : license.tier === 'trial'
          ? { label: t('trayTrial', { days: license.trialDaysLeft }), click: upsell }
          : { label: t('trayGetPro', { price: PRODUCT.priceLabel }), click: upsell };

    return [
      status,
      { type: 'separator' },
      {
        ...hint(s.enabled ? t('pause') : t('resume'), 'CommandOrControl+Shift+F'),
        type: 'checkbox',
        checked: s.enabled,
        click: () => this.actions.updateSettings({ enabled: !this.actions.getSettings().enabled }),
      },
      { type: 'separator' },
      { label: `🎬 ${t('scenes')}`, submenu: scenes },
      { label: t('intensity'), submenu: intensity },
      { label: t('palette'), submenu: palette },
      { label: t('cursorFire'), submenu: cursor },
      { label: `🎵 ${t('trayAudio')}`, submenu: audio },
      { label: `⏳ ${fs.label ? t('trayFocusRunning', { time: fs.label }) : t('trayFocus')}`, submenu: focusItems },
      {
        label: caps.globalClicks ? t('clickBursts') : t('clickBurstsUnavailable'),
        type: 'checkbox',
        checked: s.clickBursts,
        enabled: caps.globalClicks,
        click: toggle('clickBursts'),
      },
      {
        label: caps.activeWindow ? t('burnActiveWindow') : t('burnActiveWindowUnavailable'),
        type: 'checkbox',
        checked: s.burnActiveWindow,
        enabled: caps.activeWindow,
        click: toggle('burnActiveWindow'),
      },
      { label: t('screenBottomFire'), type: 'checkbox', checked: s.screenBottomFire, click: toggle('screenBottomFire') },
      pro
        ? { label: `🔦 ${t('torch')}`, type: 'checkbox', checked: s.torch, click: () => this.actions.updateSettings({ torch: !this.actions.getSettings().torch }) }
        : locked(`🔦 ${t('torch')}`),
      zmeu,
      { label: t('sparks'), type: 'checkbox', checked: s.sparks, click: toggle('sparks') },
      { label: t('debugHud'), type: 'checkbox', checked: s.showDebugHud, click: toggle('showDebugHud') },
      { label: t('idleSleep'), type: 'checkbox', checked: s.idleSleep, click: toggle('idleSleep') },
      {
        label: t('gameMode'),
        type: 'checkbox',
        checked: s.gameMode,
        enabled: caps.activeWindow,
        click: toggle('gameMode'),
      },
      { label: t('fps'), submenu: fps },
      { label: t('quality'), submenu: quality },
      {
        label: t('launchAtLogin'),
        type: 'checkbox',
        checked: s.launchAtLogin,
        enabled: process.platform !== 'linux',
        click: toggle('launchAtLogin'),
      },
      { type: 'separator' },
      { ...hint(`🔥 ${t('burnScreen')}`, 'CommandOrControl+Alt+Shift+F'), click: () => this.actions.burn('screen') },
      {
        label: t('burnMore'),
        submenu: [
          { label: t('burnWindow'), enabled: caps.activeWindow, click: () => this.actions.burn('window') },
          { label: t('burnImage'), click: () => this.actions.burn('image') },
        ],
      },
      { ...hint(t('testBurst'), 'CommandOrControl+Shift+B'), click: () => this.actions.testBurst() },
      { label: t('openSettingsWindow'), click: () => this.actions.openSettingsWindow() },
      { label: t('openSettingsFile'), click: () => this.actions.openSettingsFile() },
      { type: 'separator' },
      { ...hint(t('quit'), 'CommandOrControl+Shift+Q'), click: () => this.actions.quit() },
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
