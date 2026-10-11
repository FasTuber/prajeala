/**
 * `--smoke` mode for CI: wait for every overlay's RendererReadyReport, then for
 * `frames >= smokeFrames` in the stats of every overlay, print exactly one
 * `PRAJEALA_SMOKE_RESULT {...}` line to stdout and exit 0. With `expectUi` the
 * settings page must report that it booted as well. Any failed ready report,
 * timeout or uncaught error prints a `{"ok":false,…}` line and exits 1.
 */
import type { RendererReadyReport, RendererStats } from '../shared/ipc';
import { createLogger } from './log';
import type { Overlay, OverlayManager } from './overlay-manager';

const log = createLogger('smoke');

export const SMOKE_RESULT_PREFIX = 'PRAJEALA_SMOKE_RESULT';

export interface SmokeOptions {
  frames: number;
  timeoutMs: number;
  /** Fire a test burst at the centre of every overlay this often. */
  burstIntervalMs?: number;
  /** Also wait for the settings window to report `ready`. */
  expectUi?: boolean;
}

export interface SmokeHooks {
  sendTestBurst(): void;
  /** Stops trackers/tray, then exits with the code. Must not return. */
  exit(code: number): void;
}

interface OverlayRecord {
  display: number;
  displayId: number;
  ready: RendererReadyReport | null;
  stats: RendererStats | null;
}

export class SmokeRunner {
  private readonly startedAt = Date.now();
  private readonly records = new Map<number, OverlayRecord>();
  private timeoutTimer: NodeJS.Timeout | null = null;
  private burstTimer: NodeJS.Timeout | null = null;
  private finished = false;
  private ui: { ok: boolean; error?: string } | null = null;

  constructor(
    private readonly options: SmokeOptions,
    private readonly overlays: OverlayManager,
    private readonly hooks: SmokeHooks,
  ) {}

  start(): void {
    log.info(`waiting for ${this.options.frames} frames per overlay (timeout ${this.options.timeoutMs} ms)`);
    this.overlays.on('ready', this.onReady);
    this.overlays.on('stats', this.onStats);
    this.overlays.on('load-failed', this.onLoadFailed);
    this.overlays.on('renderer-gone', this.onRendererGone);
    this.timeoutTimer = setTimeout(() => this.fail('timeout'), this.options.timeoutMs);
    this.burstTimer = setInterval(() => this.hooks.sendTestBurst(), this.options.burstIntervalMs ?? 1000);
    process.on('uncaughtException', this.onUncaught);
    process.on('unhandledRejection', this.onUncaught);
    // In case the overlays were created before we attached.
    if (this.overlays.count === 0) {
      // Give the manager a tick to create windows; if still none, fail.
      setTimeout(() => {
        if (!this.finished && this.overlays.count === 0) this.fail('no overlay windows created');
      }, 2000);
    }
  }

  /** Report from the settings page (see SettingsWindow.onReady). */
  uiReady(report: { ok: boolean; error?: string }): void {
    if (this.finished) return;
    this.ui = report;
    log.info(`settings window ready ok=${report.ok}${report.error ? ` error="${report.error}"` : ''}`);
    if (!report.ok) {
      this.fail(`settings window failed: ${report.error ?? 'unknown error'}`);
      return;
    }
    this.check();
  }

  /** Called by main on any fatal condition (e.g. uncaught error). */
  fail(reason: string, extra: Record<string, unknown> = {}): void {
    this.finish(false, { reason, ...extra });
  }

  private readonly onUncaught = (err: unknown): void => {
    const message = err instanceof Error ? (err.stack ?? err.message) : String(err);
    log.error('uncaught error:', message);
    this.fail(`uncaught error: ${err instanceof Error ? err.message : String(err)}`);
  };

  private record(overlay: Overlay): OverlayRecord {
    let rec = this.records.get(overlay.id);
    if (!rec) {
      rec = { display: overlay.info.index, displayId: overlay.id, ready: null, stats: null };
      this.records.set(overlay.id, rec);
    }
    return rec;
  }

  private readonly onReady = (overlay: Overlay, report: RendererReadyReport): void => {
    if (this.finished) return;
    const rec = this.record(overlay);
    rec.ready = report;
    log.info(
      `overlay#${overlay.info.index} ready ok=${report.ok} webgl2=${report.webgl2} float=${report.floatTextures} sim=${report.simWidth}x${report.simHeight} renderer="${report.renderer}"${report.error ? ` error="${report.error}"` : ''}`,
    );
    if (!report.ok) {
      this.fail(`renderer on display ${overlay.info.index} reported failure: ${report.error ?? 'unknown error'}`);
      return;
    }
    this.hooks.sendTestBurst();
    this.check();
  };

  private readonly onStats = (overlay: Overlay, stats: RendererStats): void => {
    if (this.finished) return;
    const rec = this.record(overlay);
    rec.stats = stats;
    log.debug(`overlay#${overlay.info.index} frames=${stats.frames} fps=${stats.fps.toFixed(1)}`);
    this.check();
  };

  private readonly onLoadFailed = (overlay: Overlay, description: string): void => {
    this.fail(`overlay ${overlay.info.index} failed to load: ${description}`);
  };

  private readonly onRendererGone = (overlay: Overlay, details: { reason: string; exitCode: number }): void => {
    this.fail(`overlay ${overlay.info.index} renderer process gone: ${details.reason} (${details.exitCode})`);
  };

  private check(): void {
    if (this.finished) return;
    const overlays = this.overlays.list();
    if (overlays.length === 0) return;
    if (this.options.expectUi && !this.ui?.ok) return;
    for (const overlay of overlays) {
      const rec = this.records.get(overlay.id);
      if (!rec?.ready?.ok) return;
      if (!rec.stats || rec.stats.frames < this.options.frames) return;
    }
    this.finish(true, {});
  }

  private finish(ok: boolean, extra: Record<string, unknown>): void {
    if (this.finished) return;
    this.finished = true;
    if (this.timeoutTimer) clearTimeout(this.timeoutTimer);
    if (this.burstTimer) clearInterval(this.burstTimer);
    this.overlays.off('ready', this.onReady);
    this.overlays.off('stats', this.onStats);
    this.overlays.off('load-failed', this.onLoadFailed);
    this.overlays.off('renderer-gone', this.onRendererGone);
    process.off('uncaughtException', this.onUncaught);
    process.off('unhandledRejection', this.onUncaught);

    const records = [...this.records.values()].sort((a, b) => a.display - b.display);
    const result = {
      ok,
      ...extra,
      displays: this.overlays.count,
      ...(this.options.expectUi ? { settingsWindow: this.ui ?? { ok: false } } : {}),
      framesRequired: this.options.frames,
      reports: records.map((r) => ({ display: r.display, displayId: r.displayId, ...(r.ready ?? { ok: false }) })),
      stats: records.map((r) => ({ display: r.display, displayId: r.displayId, ...(r.stats ?? {}) })),
      elapsedMs: Date.now() - this.startedAt,
    };
    const line = `${SMOKE_RESULT_PREFIX} ${JSON.stringify(result)}\n`;
    const code = ok ? 0 : 1;
    let exited = false;
    const exit = () => {
      if (exited) return;
      exited = true;
      this.hooks.exit(code);
    };
    // stdout can be an async pipe on Windows: exit from the write callback (with a safety net).
    process.stdout.write(line, exit);
    setTimeout(exit, 1500).unref?.();
  }
}
