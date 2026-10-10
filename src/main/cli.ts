/**
 * Command-line flags understood by the main process. Pure module (no Electron
 * imports) so it can be unit-tested.
 *
 *   --smoke                 CI mode: software GL, wait for renderer reports, print
 *                           one `PRAJEALA_SMOKE_RESULT {...}` line and exit 0/1.
 *   --smoke-frames=N        frames every overlay must render before success (90).
 *   --smoke-timeout=MS      give up after this many ms (45000).
 *   --software-gl           force SwiftShader (ANGLE) even outside smoke mode.
 *   --debug-hud             ask the renderer to draw its diagnostics panel (?hud=1).
 *   --no-hooks              never load uiohook-napi (no global click bursts).
 *   --no-active-window      never load get-windows (no fire on the focused window).
 *   --cursor-hz=N           cursor polling rate (120).
 *   --window-hz=N           active-window polling rate (4).
 *   --display=N             only create an overlay for display index N.
 *   --verbose               print debug log lines.
 *   --renderer-url=URL      undocumented: load this URL/file instead of the bundled
 *                           renderer (used by tests to exercise the IPC path).
 *   --linux-transparent-visuals
 *                           Linux only: add --enable-transparent-visuals and
 *                           --disable-gpu-compositing (needed on some X11 setups).
 */

export interface CliOptions {
  smoke: boolean;
  smokeFrames: number;
  smokeTimeoutMs: number;
  softwareGl: boolean;
  debugHud: boolean;
  noHooks: boolean;
  noActiveWindow: boolean;
  cursorHz: number;
  windowHz: number;
  /** Restrict overlays to one display index, or null for all displays. */
  display: number | null;
  verbose: boolean;
  rendererUrl: string | null;
  linuxTransparentVisuals: boolean;
}

export const DEFAULT_CLI: Readonly<CliOptions> = Object.freeze({
  smoke: false,
  smokeFrames: 90,
  smokeTimeoutMs: 45_000,
  softwareGl: false,
  debugHud: false,
  noHooks: false,
  noActiveWindow: false,
  cursorHz: 120,
  windowHz: 4,
  display: null,
  verbose: false,
  rendererUrl: null,
  linuxTransparentVisuals: false,
});

function clampNumber(value: string | undefined, fallback: number, min: number, max: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/**
 * Parses `argv` (everything after the executable; `.`/app paths and Chromium
 * switches such as `--no-sandbox` are ignored). Unknown flags are ignored.
 */
export function parseCli(argv: readonly string[]): CliOptions {
  const out: CliOptions = { ...DEFAULT_CLI };
  for (const raw of argv) {
    if (!raw.startsWith('--')) continue;
    const eq = raw.indexOf('=');
    const name = eq === -1 ? raw.slice(2) : raw.slice(2, eq);
    const value = eq === -1 ? undefined : raw.slice(eq + 1);
    switch (name) {
      case 'smoke':
        out.smoke = true;
        break;
      case 'smoke-frames':
        out.smokeFrames = Math.round(clampNumber(value, out.smokeFrames, 1, 1_000_000));
        break;
      case 'smoke-timeout':
        out.smokeTimeoutMs = Math.round(clampNumber(value, out.smokeTimeoutMs, 1_000, 3_600_000));
        break;
      case 'software-gl':
        out.softwareGl = true;
        break;
      case 'debug-hud':
        out.debugHud = true;
        break;
      case 'no-hooks':
        out.noHooks = true;
        break;
      case 'no-active-window':
        out.noActiveWindow = true;
        break;
      case 'cursor-hz':
        out.cursorHz = clampNumber(value, out.cursorHz, 1, 1000);
        break;
      case 'window-hz':
        out.windowHz = clampNumber(value, out.windowHz, 0.1, 60);
        break;
      case 'display': {
        const n = Number(value);
        out.display = Number.isInteger(n) && n >= 0 ? n : null;
        break;
      }
      case 'verbose':
        out.verbose = true;
        break;
      case 'renderer-url':
        out.rendererUrl = value && value.length > 0 ? value : null;
        break;
      case 'linux-transparent-visuals':
        out.linuxTransparentVisuals = true;
        break;
      default:
        break;
    }
  }
  return out;
}
