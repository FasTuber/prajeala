/**
 * Global keyboard shortcuts. Registration failures (another app owns the
 * combination, Wayland restrictions…) are logged, never fatal.
 */
import { globalShortcut } from 'electron';
import { nextAllowedIntensity } from '../shared/pro';
import type { Settings } from '../shared/settings';
import { createLogger } from './log';

const log = createLogger('shortcuts');

export interface ShortcutActions {
  getSettings(): Settings;
  /** Pro unlocked (licence or trial): the intensity shortcuts may reach Inferno. */
  isPro(): boolean;
  updateSettings(patch: Partial<Settings>): void;
  testBurst(): void;
  quit(): void;
}

export const SHORTCUTS = Object.freeze({
  toggle: 'CommandOrControl+Shift+F',
  quit: 'CommandOrControl+Shift+Q',
  intensityUp: 'CommandOrControl+Shift+Up',
  intensityDown: 'CommandOrControl+Shift+Down',
  testBurst: 'CommandOrControl+Shift+B',
});

export function registerShortcuts(actions: ShortcutActions): string[] {
  const bindings: Array<[string, () => void]> = [
    [SHORTCUTS.toggle, () => actions.updateSettings({ enabled: !actions.getSettings().enabled })],
    [SHORTCUTS.quit, () => actions.quit()],
    [
      SHORTCUTS.intensityUp,
      () => actions.updateSettings({ intensity: nextAllowedIntensity(actions.getSettings().intensity, 1, actions.isPro()) }),
    ],
    [
      SHORTCUTS.intensityDown,
      () => actions.updateSettings({ intensity: nextAllowedIntensity(actions.getSettings().intensity, -1, actions.isPro()) }),
    ],
    [SHORTCUTS.testBurst, () => actions.testBurst()],
  ];
  const registered: string[] = [];
  for (const [accelerator, handler] of bindings) {
    try {
      const ok = globalShortcut.register(accelerator, () => {
        try {
          handler();
        } catch (err) {
          log.warn(`handler for ${accelerator} threw:`, err);
        }
      });
      if (ok) registered.push(accelerator);
      else log.warn(`could not register ${accelerator} (taken by another application?)`);
    } catch (err) {
      log.warn(`could not register ${accelerator}:`, (err as Error).message);
    }
  }
  log.info(`registered ${registered.length}/${bindings.length} global shortcuts`);
  return registered;
}

export function unregisterShortcuts(): void {
  try {
    globalShortcut.unregisterAll();
  } catch (err) {
    log.debug('unregisterAll failed:', err);
  }
}
