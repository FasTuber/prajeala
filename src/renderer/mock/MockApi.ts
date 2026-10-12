/**
 * Stand-in for the preload bridge when the page is opened directly in a
 * browser (no `window.prajeala`). Drives the cursor from DOM mouse events and,
 * when the mouse is idle, from a synthetic path; mouse buttons become bursts.
 *
 * Dev keys: 1-4 intensity · p palette · c cursor mode · b bottom fire ·
 * w fake window · s sparks · h HUD · space burst · Esc toggle enabled.
 */
import type {
  ActiveWindowEvent,
  CursorEvent,
  DisplayInfo,
  HostCapabilities,
  PointerButtonEvent,
  PrajealaApi,
  RendererReadyReport,
  RendererStats,
  Unsubscribe,
} from '../../shared/ipc';
import { CURSOR_MODES, INTENSITIES, PALETTES, mergeSettings, normalizeSettings, type Settings } from '../../shared/settings';
import type { AudioFrame } from '../../shared/audio-contract';
import type { BurnStart } from '../../shared/burn';
import { startAudioDemo } from './AudioDemo';
import { FocusClock, type FocusFrame } from '../../shared/focus';
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
  const activeWindow = new Signal<ActiveWindowEvent | null>();
  const settingsSignal = new Signal<Settings>();
  const displaySignal = new Signal<DisplayInfo>();
  const capsSignal = new Signal<HostCapabilities>();
  const testBurst = new Signal<{ x: number; y: number; strength: number }>();
  const burnPrepare = new Signal<null>();
  const burnStart = new Signal<BurnStart>();
  const burnAbort = new Signal<null>();
  const audioSignal = new Signal<AudioFrame>();
  if (options.audioDemo) startAudioDemo((f) => audioSignal.emit(f));
  const focusSignal = new Signal<FocusFrame>();
  if (options.focusDemo > 0) {
    // The same FocusClock main uses, ticked here; frames go out every 250 ms.
    const clock = new FocusClock();
    clock.start(options.focusDemo * 1000, performance.now() - options.focusAt * 1000);
    const timer = window.setInterval(() => {
      const now = performance.now();
      const event = clock.tick(now);
      focusSignal.emit(clock.frame(now, 'GATA!'));
      if (event === 'ended') window.clearInterval(timer);
    }, 250);
  }
  if (options.burnDemo) {
    const mode = options.burnDemo;
    window.setTimeout(() => {
      void fakeDesktop(window.innerWidth, window.innerHeight).then((image) => {
        const full = { x: 0, y: 0, width: window.innerWidth, height: window.innerHeight };
        const win = { x: Math.round(full.width * 0.22), y: Math.round(full.height * 0.16), width: Math.round(full.width * 0.5), height: Math.round(full.height * 0.55) };
        burnStart.emit({
          mode,
          image,
          mime: 'image/jpeg',
          imageRect: full,
          burnRect: mode === 'window' ? win : full,
          ignite: options.pin ?? { x: full.width * 0.5, y: full.height * 0.8 },
          durationMs: 10_000,
        });
      });
    }, 1000);
  }
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
    settings = mergeSettings(settings, patch);
    settingsSignal.emit(settings);
  };
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
        bounds: options.fakeWindowRect ? { ...options.fakeWindowRect } : { x: bx, y: by, width: bw, height: bh },
        intersects: true,
        isSelf: false,
      });
    }
  };
  setInterval(tickSynthetic, 1000 / 90);

  return {
    getSettings: () => Promise.resolve(settings),
    getDisplay: () => Promise.resolve(display()),
    getCapabilities: () => Promise.resolve(caps()),
    updateSettings: (patch) => {
      setSettings(patch);
      return Promise.resolve(settings);
    },
    onCursor: (cb) => {
      const off = cursor.on(cb);
      // Deliver an initial position right away so warm-up frames have a cursor.
      queueMicrotask(tickSynthetic);
      return off;
    },
    onPointerButton: (cb) => button.on(cb),
    onActiveWindow: (cb) => activeWindow.on(cb),
    onSettings: (cb) => settingsSignal.on(cb),
    onDisplay: (cb) => displaySignal.on(cb),
    onCapabilities: (cb) => capsSignal.on(cb),
    onTestBurst: (cb) => testBurst.on(cb),
    onKeyPress: () => () => undefined,
    onPower: () => () => undefined,
    onAudio: (cb) => audioSignal.on(cb),
    onFocusTimer: (cb) => focusSignal.on(cb),
    onVisibility: () => () => undefined,
    onBurnPrepare: (cb) => burnPrepare.on(() => cb()),
    onBurnStart: (cb) => burnStart.on(cb),
    onBurnAbort: (cb) => burnAbort.on(() => cb()),
    burnReady: () => console.info('[prajeala:mock] burn ready'),
    burnDone: (r) => console.info('[prajeala:mock] burn done', r),
    reportReady: (report: RendererReadyReport) => console.info('[prajeala:mock] ready', report),
    reportStats: (stats: RendererStats) => console.debug('[prajeala:mock] stats', stats),
    log: (level, message) => console[level === 'debug' ? 'debug' : level === 'info' ? 'info' : level === 'warn' ? 'warn' : 'error'](`[prajeala] ${message}`),
  };
}

/** A believable desktop (wallpaper, editor window, taskbar) for burning in the mock. */
async function fakeDesktop(w: number, h: number): Promise<Uint8Array> {
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const g = canvas.getContext('2d');
  if (!g) return new Uint8Array(0);
  const bg = g.createLinearGradient(0, 0, w, h);
  bg.addColorStop(0, '#2b3a5a');
  bg.addColorStop(0.5, '#18202f');
  bg.addColorStop(1, '#0d1118');
  g.fillStyle = bg;
  g.fillRect(0, 0, w, h);
  const win = { x: w * 0.22, y: h * 0.16, w: w * 0.5, h: h * 0.55 };
  g.fillStyle = '#1e1f24';
  g.fillRect(win.x, win.y, win.w, win.h);
  g.fillStyle = '#2a2c33';
  g.fillRect(win.x, win.y, win.w, 30);
  g.font = '13px sans-serif';
  g.fillStyle = '#aab';
  g.fillText('deadline.ts — Visual Studio Code', win.x + 70, win.y + 20);
  ['#ff5f57', '#febc2e', '#28c840'].forEach((c, i) => {
    g.fillStyle = c;
    g.beginPath();
    g.arc(win.x + 16 + i * 18, win.y + 15, 6, 0, Math.PI * 2);
    g.fill();
  });
  const lines = ['// livrare: azi la 17:00', 'export async function shipIt(build: Build) {', '  const tests = await runTests(build);', '  if (tests.failed > 0) throw new Error("teste picate");', '  await deploy(build, { env: "production" });', "  return 'gata';", '}', '', '// TODO: de ce arde ecranul?'];
  g.font = '15px monospace';
  lines.forEach((line, i) => {
    g.fillStyle = line.startsWith('//') ? '#8b949e' : i % 3 === 1 ? '#ff7b72' : '#c9d1d9';
    g.fillText(line, win.x + 18, win.y + 60 + i * 24);
  });
  g.fillStyle = 'rgba(12,14,20,0.9)';
  g.fillRect(0, h - 40, w, 40);
  for (let i = 0; i < 5; i++) {
    g.fillStyle = i === 0 ? '#ff7a1a' : '#3a4256';
    g.fillRect(16 + i * 34, h - 32, 24, 24);
  }
  g.fillStyle = '#ccd';
  g.fillText('16:58', w - 70, h - 14);
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.9));
  return blob ? new Uint8Array(await blob.arrayBuffer()) : new Uint8Array(0);
}
