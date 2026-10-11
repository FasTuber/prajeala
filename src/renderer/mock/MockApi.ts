/**
 * Stand-in for the preload bridge when the page is opened directly in a
 * browser (no `window.prajeala`). Drives the cursor from DOM mouse events and,
 * when the mouse is idle, from a synthetic path; mouse buttons become bursts.
 *
 * Dev keys: 1-4 intensity · p palette · c cursor mode · b bottom fire ·
 * w fake window · s sparks · m sound reactivity · k typing fire · h HUD ·
 * space burst · Esc toggle enabled.
 */
import type {
  ActiveWindowEvent,
  CursorEvent,
  DisplayInfo,
  HostCapabilities,
  KeyEvent,
  KeyKind,
  PointerButtonEvent,
  PrajealaApi,
  RendererReadyReport,
  RendererStats,
  Unsubscribe,
} from '../../shared/ipc';
import { FREE_LICENSE_INFO, applyTierLimits, parseLicenseKey, type LicenseActionResult, type LicenseInfo } from '../../shared/license';
import { CURSOR_MODES, INTENSITIES, PALETTES, mergeSettings, normalizeSettings, type Settings } from '../../shared/settings';
import { BUILTIN_THEMES, type ThemeDefinition } from '../../shared/theme';
import { classifyDomKey } from '../../main/keys';
import type { RendererOptions } from '../app/options';
import { SyntheticCursor } from './SyntheticCursor';

class Signal<T> {
  private readonly listeners = new Set<(v: T) => void>();
  on(cb: (v: T) => void): Unsubscribe {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }
  emit(v: T): void {
    for (const cb of this.listeners) cb(v);
  }
}

function cycle<T extends string>(list: readonly T[], current: T): T {
  const i = list.indexOf(current);
  return list[(i + 1) % list.length] ?? current;
}

export function createMockApi(options: RendererOptions): PrajealaApi {
  let settings: Settings = normalizeSettings(options.settingsOverrides);
  const cursor = new Signal<CursorEvent>();
  const button = new Signal<PointerButtonEvent>();
  const key = new Signal<KeyEvent>();
  const activeWindow = new Signal<ActiveWindowEvent | null>();
  const settingsSignal = new Signal<Settings>();
  const displaySignal = new Signal<DisplayInfo>();
  const capsSignal = new Signal<HostCapabilities>();
  const testBurst = new Signal<{ x: number; y: number; strength: number }>();
  const licenseSignal = new Signal<LicenseInfo>();
  // The standalone demo shows everything: it behaves like a perpetual Pro licence.
  let license: LicenseInfo = {
    ...FREE_LICENSE_INFO,
    tier: options.freeTier ? 'free' : 'pro',
    status: options.freeTier ? 'none' : 'active',
    kind: options.freeTier ? 'none' : 'signed',
    maskedKey: options.freeTier ? '' : 'PRAJ1…demo',
    message: options.freeTier ? 'Free — demo without a licence.' : 'Pro — demo licence (mock).',
    signedKeysSupported: true,
    buyUrl: 'https://github.com/FasTuber/prajeala#pro',
  };
  /** Like the main process: the renderer only ever sees settings clamped to the tier. */
  const effective = (): Settings => applyTierLimits(settings, license.tier);
  const themeSignal = new Signal<ThemeDefinition>();
  const currentTheme = (): ThemeDefinition => BUILTIN_THEMES[effective().palette];
  const setLicense = (next: LicenseInfo): void => {
    license = next;
    licenseSignal.emit(license);
    settingsSignal.emit(effective());
    themeSignal.emit(currentTheme());
  };
  const start = performance.now();
  const synthetic = new SyntheticCursor(0.5);
  const point = { x: 0, y: 0 };
  let lastRealMove = -Infinity;
  let fakeWindow = options.fakeWindow;

  const display = (): DisplayInfo => ({
    id: 1,
    bounds: { x: 0, y: 0, width: window.innerWidth, height: window.innerHeight },
    workArea: { x: 0, y: 0, width: window.innerWidth, height: window.innerHeight - 40 },
    scaleFactor: window.devicePixelRatio || 1,
    isPrimary: true,
    index: 0,
    total: 1,
  });
  const caps = (): HostCapabilities => ({
    globalClicks: true,
    activeWindow: fakeWindow,
    platform: 'browser',
    smoke: options.smoke,
    audioLoopback: false,
    globalKeys: true,
  });

  const now = (): number => performance.now() - start;
  const inside = (x: number, y: number): boolean => x >= 0 && y >= 0 && x < window.innerWidth && y < window.innerHeight;

  // Standalone pages can receive real mouse input; the overlay CSS disables it.
  document.documentElement.style.pointerEvents = 'auto';
  document.body.style.pointerEvents = 'auto';
  document.body.style.background = '#1c1f26';
  document.addEventListener('contextmenu', (e) => e.preventDefault());

  window.addEventListener('mousemove', (e) => {
    lastRealMove = now();
    cursor.emit({ x: e.clientX, y: e.clientY, gx: e.clientX, gy: e.clientY, inside: true, t: now() });
  });
  const buttonName = (b: number): PointerButtonEvent['button'] => (b === 0 ? 'left' : b === 2 ? 'right' : b === 1 ? 'middle' : 'other');
  window.addEventListener('mousedown', (e) => {
    button.emit({ x: e.clientX, y: e.clientY, gx: e.clientX, gy: e.clientY, inside: true, button: buttonName(e.button), type: 'down', t: now() });
  });
  window.addEventListener('mouseup', (e) => {
    button.emit({ x: e.clientX, y: e.clientY, gx: e.clientX, gy: e.clientY, inside: true, button: buttonName(e.button), type: 'up', t: now() });
  });
  window.addEventListener('resize', () => displaySignal.emit(display()));

  const setSettings = (patch: Partial<Settings>): void => {
    const before = effective().palette;
    settings = mergeSettings(settings, patch);
    settingsSignal.emit(effective());
    if (effective().palette !== before) themeSignal.emit(currentTheme());
  };
  // Typing fire: every key press on the page counts (the dev keys below as well).
  window.addEventListener('keydown', (e) => {
    if (!e.repeat) key.emit({ kind: classifyDomKey(e.key), t: now() });
  });
  if (options.typingSim) {
    // Fake typist: ~7 keys/s with pauses, a space every few letters, Enter now and then.
    let typed = 0;
    const tick = (): void => {
      typed++;
      const kind: KeyKind = typed % 23 === 0 ? 'enter' : typed % 17 === 0 ? 'backspace' : typed % 6 === 0 ? 'space' : 'char';
      key.emit({ kind, t: now() });
      const pause = typed % 40 === 0 ? 1800 : 90 + Math.random() * 140;
      setTimeout(tick, pause);
    };
    setTimeout(tick, 500);
  }
  window.addEventListener('keydown', (e) => {
    switch (e.key) {
      case '1':
      case '2':
      case '3':
      case '4':
        setSettings({ intensity: INTENSITIES[Number(e.key) - 1] });
        break;
      case 'p':
        setSettings({ palette: cycle(PALETTES, settings.palette) });
        break;
      case 'c':
        setSettings({ cursorMode: cycle(CURSOR_MODES, settings.cursorMode) });
        break;
      case 'b':
        setSettings({ screenBottomFire: !settings.screenBottomFire });
        break;
      case 's':
        setSettings({ sparks: !settings.sparks });
        break;
      case 'h':
        setSettings({ showDebugHud: !settings.showDebugHud });
        break;
      case 'm':
        setSettings({ audioReactive: !settings.audioReactive });
        break;
      case 'k':
        setSettings({ typingFire: !settings.typingFire });
        break;
      case 'w':
        fakeWindow = !fakeWindow;
        capsSignal.emit(caps());
        if (!fakeWindow) activeWindow.emit(null);
        break;
      case ' ':
        testBurst.emit({ x: point.x, y: point.y, strength: 2.5 });
        break;
      case 'Escape':
        setSettings({ enabled: !settings.enabled });
        break;
      default:
        return;
    }
  });

  // Synthetic cursor while the real mouse is idle (and always with ?synthetic=1),
  // unless smoke mode is on (then the App drives its own synthetic cursor).
  const tickSynthetic = (): void => {
    const t = now();
    if (options.pin) {
      point.x = options.pin.x;
      point.y = options.pin.y;
      cursor.emit({ x: point.x, y: point.y, gx: point.x, gy: point.y, inside: true, t });
    } else if (!options.smoke && (options.synthetic || t - lastRealMove > 1500)) {
      synthetic.sample(t / 1000, window.innerWidth, window.innerHeight, point);
      cursor.emit({ x: point.x, y: point.y, gx: point.x, gy: point.y, inside: inside(point.x, point.y), t });
    }
    if (fakeWindow) {
      const w = window.innerWidth;
      const h = window.innerHeight;
      const s = t / 1000;
      const bw = Math.round(w * 0.42);
      const bh = Math.round(h * 0.48);
      const bx = Math.round(w * 0.5 - bw * 0.5 + Math.sin(s * 0.35) * w * 0.18);
      const by = Math.round(h * 0.6 - bh * 0.5 + Math.cos(s * 0.27) * h * 0.1);
      activeWindow.emit({
        title: 'Mock window',
        app: 'mock',
        bounds: { x: bx, y: by, width: bw, height: bh },
        intersects: true,
        isSelf: false,
      });
    }
  };
  setInterval(tickSynthetic, 1000 / 90);

  return {
    getSettings: () => Promise.resolve(effective()),
    getDisplay: () => Promise.resolve(display()),
    getCapabilities: () => Promise.resolve(caps()),
    updateSettings: (patch) => {
      setSettings(patch);
      return Promise.resolve(settings);
    },
    getTheme: () => Promise.resolve(currentTheme()),
    onTheme: (cb) => themeSignal.on(cb),
    getLicense: () => Promise.resolve(license),
    activateLicense: (key): Promise<LicenseActionResult> => {
      const parsed = parseLicenseKey(key);
      if (!parsed) return Promise.resolve({ ok: false, error: 'That does not look like a licence key.', info: license });
      setLicense({
        ...license,
        tier: 'pro',
        status: 'active',
        kind: parsed.kind,
        maskedKey: parsed.kind === 'signed' ? 'PRAJ1…mock' : `${parsed.key.slice(0, 8)}…${parsed.key.slice(-4)}`,
        activatedAt: new Date().toISOString(),
        canCheckOnline: parsed.kind === 'lemonsqueezy' || !!parsed.payload.key,
        message: 'Pro — accepted by the mock (no real verification in the browser).',
      });
      return Promise.resolve({ ok: true, info: license });
    },
    deactivateLicense: () => {
      setLicense({ ...FREE_LICENSE_INFO, signedKeysSupported: true, buyUrl: license.buyUrl });
      return Promise.resolve({ ok: true, info: license });
    },
    checkLicenseOnline: () =>
      Promise.resolve({ ok: license.tier === 'pro', error: license.tier === 'pro' ? undefined : 'no key', info: license }),
    openBuyPage: () => {
      window.open(license.buyUrl, '_blank', 'noopener');
      return Promise.resolve();
    },
    closeLicenseWindow: () => Promise.resolve(),
    onLicense: (cb) => licenseSignal.on(cb),
    onCursor: (cb) => {
      const off = cursor.on(cb);
      // Deliver an initial position right away so warm-up frames have a cursor.
      queueMicrotask(tickSynthetic);
      return off;
    },
    onPointerButton: (cb) => button.on(cb),
    onKey: (cb) => key.on(cb),
    onActiveWindow: (cb) => activeWindow.on(cb),
    onSettings: (cb) => settingsSignal.on(cb),
    onDisplay: (cb) => displaySignal.on(cb),
    onCapabilities: (cb) => capsSignal.on(cb),
    onTestBurst: (cb) => testBurst.on(cb),
    reportReady: (report: RendererReadyReport) => console.info('[prajeala:mock] ready', report),
    reportStats: (stats: RendererStats) => console.debug('[prajeala:mock] stats', stats),
    reportAudioStatus: (status) => console.info('[prajeala:mock] audio', status),
    log: (level, message) => console[level === 'debug' ? 'debug' : level === 'info' ? 'info' : level === 'warn' ? 'warn' : 'error'](`[prajeala] ${message}`),
  };
}
