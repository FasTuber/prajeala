/**
 * Renderer URL flags (development / diagnostics):
 *   ?hud=1        show the debug HUD
 *   ?nofloat=1    force the 8-bit texture fallback
 *   ?nearest=1    force NEAREST sampling + manual bilinear in shaders
 *   ?smoke=1      synthetic cursor path + periodic bursts (also set by HostCapabilities.smoke)
 *   ?synthetic=1  mock only: always drive the cursor synthetically
 *   ?pin=x,y      mock only: hold the cursor at a fixed position
 *   ?window=1     mock only: fake a moving active window
 *   ?warmup=N     run N fixed-step (1/60 s) updates before the first frame (screenshots)
 *   ?view=heat|smoke|glow   show a raw simulation field instead of the composite
 *   ?losectx=ms   lose the WebGL context after `ms` and restore it 800 ms later
 *   ?free=1       mock only: pretend there is no licence (Free tier limits apply)
 * Mock-only settings overrides: enabled, intensity, palette, cursorMode (or cursor),
 * bottom, window, sparks, bursts, simScale, fps, pressure.
 */
import type { Settings } from '../../shared/settings';

export interface RendererOptions {
  hud: boolean;
  forceByte: boolean;
  forceNearest: boolean;
  smoke: boolean;
  synthetic: boolean;
  pin: { x: number; y: number } | null;
  fakeWindow: boolean;
  warmup: number;
  /** Debug field view: 0 normal, 1 heat, 2 smoke, 3 glow. */
  view: number;
  /** Dev: lose the WebGL context after this many ms (0 = never). */
  loseContextAt: number;
  /** Mock only: simulate the Free tier instead of the default Pro demo licence. */
  freeTier: boolean;
  settingsOverrides: Partial<Settings>;
}

const VIEWS: Record<string, number> = { heat: 1, smoke: 2, glow: 3 };

function flag(params: URLSearchParams, name: string): boolean {
  const v = params.get(name);
  return v !== null && v !== '0' && v !== 'false' && v !== 'off';
}

export function parseOptions(search: string): RendererOptions {
  const params = new URLSearchParams(search);
  const overrides: Partial<Settings> = {};
  const intensity = params.get('intensity');
  if (intensity) overrides.intensity = intensity as Settings['intensity'];
  const palette = params.get('palette');
  if (palette) overrides.palette = palette as Settings['palette'];
  const cursorMode = params.get('cursorMode') ?? params.get('cursor');
  if (cursorMode) overrides.cursorMode = cursorMode as Settings['cursorMode'];
  if (params.has('bottom')) overrides.screenBottomFire = flag(params, 'bottom');
  if (params.has('window')) overrides.burnActiveWindow = flag(params, 'window');
  if (params.has('sparks')) overrides.sparks = flag(params, 'sparks');
  if (params.has('bursts')) overrides.clickBursts = flag(params, 'bursts');
  if (params.has('simScale')) overrides.simScale = Number(params.get('simScale'));
  if (params.has('fps')) overrides.maxFps = Number(params.get('fps'));
  if (params.has('pressure')) overrides.pressureIterations = Number(params.get('pressure'));
  if (params.has('hud')) overrides.showDebugHud = flag(params, 'hud');
  if (params.has('enabled')) overrides.enabled = flag(params, 'enabled');
  let pin: RendererOptions['pin'] = null;
  const pinRaw = params.get('pin');
  if (pinRaw) {
    const [px, py] = pinRaw.split(',').map(Number);
    if (px !== undefined && py !== undefined && Number.isFinite(px) && Number.isFinite(py)) pin = { x: px, y: py };
  }
  const warmup = Number(params.get('warmup') ?? 0);
  return {
    hud: flag(params, 'hud'),
    forceByte: flag(params, 'nofloat'),
    forceNearest: flag(params, 'nearest'),
    smoke: flag(params, 'smoke'),
    synthetic: flag(params, 'synthetic'),
    pin,
    fakeWindow: flag(params, 'window'),
    warmup: Number.isFinite(warmup) ? Math.max(0, Math.min(3600, Math.floor(warmup))) : 0,
    view: VIEWS[params.get('view') ?? ''] ?? 0,
    loseContextAt: Math.max(0, Number(params.get('losectx') ?? 0) || 0),
    freeTier: flag(params, 'free'),
    settingsOverrides: overrides,
  };
}
