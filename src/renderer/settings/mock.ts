/**
 * In-page stand-in for the settings preload, used when settings.html is opened
 * in a plain browser (UI work, screenshots). Query flags:
 *   ?lang=ro|en   ?tier=free|trial|pro   ?displays=N   ?focus=pro|welcome
 * Keys starting with “PRJ1-” or shaped like a UUID “activate”; anything else fails.
 */
import { pickLang } from '../../shared/i18n';
import type { PrajealaUiApi, UiFocus, UiState } from '../../shared/ipc';
import { FREE_STATUS, classifyKey, maskKey, type LicenseActionResult, type LicenseStatus } from '../../shared/license';
import { effectiveSettings, stripLockedChoices } from '../../shared/pro';
import { PRODUCT } from '../../shared/product';
import { DEFAULT_SETTINGS, mergeSettings, type Settings } from '../../shared/settings';

export function createMockUiApi(search: string): PrajealaUiApi {
  const params = new URLSearchParams(search);
  const tier = params.get('tier') ?? 'trial';
  let settings: Settings = { ...DEFAULT_SETTINGS, palette: tier === 'free' ? 'aurora' : 'classic' };
  let license: LicenseStatus = {
    ...FREE_STATUS,
    storeConfigured: true,
    offlineConfigured: true,
    ...(tier === 'pro'
      ? { tier: 'pro', pro: true, source: 'store', licensee: 'Ana Pop', keyHint: maskKey('38b1460a-5104-4067-a91d-77b872934d51') }
      : tier === 'trial'
        ? { tier: 'trial', pro: true, trialDaysLeft: 5, trialEndsAt: Date.now() + 5 * 86_400_000 }
        : { trialEndsAt: Date.now() - 86_400_000 }),
  };
  const stateListeners = new Set<(s: UiState) => void>();
  const focusListeners = new Set<(f: UiFocus) => void>();
  const state = (): UiState => ({
    settings,
    effective: effectiveSettings(settings, license.pro),
    license,
    capabilities: { globalClicks: true, activeWindow: true, platform: 'linux', smoke: false },
    version: '0.0.0-mock',
    platform: navigator.platform.toLowerCase().includes('mac') ? 'darwin' : 'linux',
    displays: Number(params.get('displays') ?? 2) || 1,
    lang: pickLang(params.get('lang') ?? navigator.language),
    product: { name: PRODUCT.name, priceLabel: PRODUCT.priceLabel, trialDays: PRODUCT.trialDays, hasSponsor: true },
  });
  const focus = params.get('focus');
  if (focus === 'pro' || focus === 'welcome') {
    setTimeout(() => focusListeners.forEach((cb) => cb(focus)), 50);
  }
  const result = (ok: boolean, code: LicenseActionResult['code'], message: string): LicenseActionResult => ({ ok, code, message, status: license });
  return {
    getState: async () => state(),
    updateSettings: async (patch) => {
      settings = mergeSettings(settings, stripLockedChoices(patch, license.pro));
      return state();
    },
    activate: async (key) => {
      await new Promise((r) => setTimeout(r, 400));
      const kind = classifyKey(key);
      if (kind === 'unknown') return result(false, 'malformed', 'malformed');
      license = { ...license, tier: 'pro', pro: true, source: kind, licensee: 'Ana Pop', keyHint: maskKey(key), trialDaysLeft: 0 };
      stateListeners.forEach((cb) => cb(state()));
      return result(true, 'activated', 'activated');
    },
    deactivate: async () => {
      license = { ...FREE_STATUS, storeConfigured: true, offlineConfigured: true, trialEndsAt: Date.now() - 1 };
      stateListeners.forEach((cb) => cb(state()));
      return result(true, 'deactivated', 'deactivated');
    },
    openLink: (link) => console.info('[mock] open link', link),
    openSettingsFile: () => console.info('[mock] open settings file'),
    testBurst: () => console.info('[mock] test burst'),
    reportReady: (r) => console.info('[mock] ready', r),
    onState: (cb) => {
      stateListeners.add(cb);
      return () => stateListeners.delete(cb);
    },
    onFocus: (cb) => {
      focusListeners.add(cb);
      return () => focusListeners.delete(cb);
    },
  };
}
