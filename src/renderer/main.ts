/**
 * Renderer entry point. Picks the preload bridge (`window.prajeala`) or the
 * standalone mock, then boots the App. Nothing here may throw.
 */
import { App } from './app/App';
import { parseOptions } from './app/options';
import { createMockApi } from './mock/MockApi';

function boot(): void {
  const options = parseOptions(window.location.search);
  const bridge: unknown = (window as { prajeala?: unknown }).prajeala;
  const hasBridge = typeof bridge === 'object' && bridge !== null && typeof (bridge as { getSettings?: unknown }).getSettings === 'function';
  const api = hasBridge ? window.prajeala : createMockApi(options);
  if (!hasBridge) console.info('[prajeala] no preload bridge found: using the in-page mock API (dev keys: 1-4 p c b w s h space esc)');

  const canvas = document.getElementById('fire');
  if (!(canvas instanceof HTMLCanvasElement)) {
    api.reportReady({
      ok: false,
      webgl2: false,
      floatTextures: false,
      renderer: '',
      simWidth: 0,
      simHeight: 0,
      canvasWidth: 0,
      canvasHeight: 0,
      error: 'canvas#fire not found in index.html',
    });
    return;
  }
  const app = new App(canvas, api, options, { mock: !hasBridge });
  app.init().catch((err: unknown) => {
    console.error('[prajeala] init failed', err);
  });
}

try {
  boot();
} catch (err) {
  console.error('[prajeala] fatal renderer error', err);
}
