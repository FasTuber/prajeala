/**
 * Global keyboard shortcuts. Registration failures (another app owns the
 * combination, Wayland restrictions…) are logged, never fatal.
 */
import { globalShortcut } from 'electron';
import { clampIntensity, type Tier } from '../shared/license';
import { nextIntensity, type Intensity, type Settings } from '../shared/settings';
import { createLogger } from './log';

const log = createLogger('shortcuts');

export interface ShortcutActions {
  getSettings(): Settings;
  updateSettings(patch: Partial<Settings>): void;
  /** Current licence tier; intensity steps never leave what the tier allows. */
  getTier(): Tier;
  testBurst(): void;
  quit(): void;
}

/** Next intensity in `direction`, clamped to the tier (so Free stops at its maximum instead of storing a locked value). */
export function stepIntensity(current: Intensity, direction: 1 | -1, tier: Tier): Intensity {
  return clampIntensity(tier, nextIntensity(clampIntensity(tier, current), direction));
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
      () => actions.updateSettings({ intensity: stepIntensity(actions.getSettings().intensity, 1, actions.getTier()) }),
    ],
    [
      SHORTCUTS.intensityDown,
      () => actions.updateSettings({ intensity: stepIntensity(actions.getSettings().intensity, -1, actions.getTier()) }),
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
