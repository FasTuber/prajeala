/**
 * "Arde tot" orchestration in the main process.
 *
 *   screen — every overlay clears itself, each display is captured once with
 *            desktopCapturer (kept in memory only, never written to disk) and
 *            sent to its overlay, which burns it away;
 *   window — the same, but only the focused window's rectangle burns;
 *   image  — a picture the user chose burns in the middle of the screen
 *            (no capture, no permission needed).
 *
 * While a burn runs the overlays stop being click-through, so clicks start new
 * fires instead of hitting the (frozen-looking) apps underneath and Esc stops
 * it. A watchdog always restores click-through, even if a renderer dies.
 */
import { desktopCapturer, globalShortcut, nativeImage, screen, systemPreferences, type NativeImage } from 'electron';
import { BURN_DURATION_MS, BURN_MAX_SIDE, downscaleFactor, fitContain, intersectRect, type BurnDoneReport, type BurnMode, type BurnStart } from '../shared/burn';
import { IPC } from '../shared/ipc';
import type { ActiveWindowInfo } from './active-window-tracker';
import { rectContainsPoint, rectCenter, toLocalPoint, toLocalRect, type Point } from './geometry';
import { createLogger } from './log';
import type { Overlay, OverlayManager } from './overlay-manager';

const log = createLogger('burn');

const PREPARE_TIMEOUT_MS = 400;
const COMPOSITOR_SETTLE_MS = 90;
const WATCHDOG_SLACK_MS = 5000;

export interface BurnOutcome {
  ok: boolean;
  /** 'permission' when macOS refused screen capture, 'busy' when a burn is already running. */
  reason?: 'permission' | 'busy' | 'no-window' | 'no-overlay' | 'capture' | 'image' | 'renderer';
  error?: string;
  aborted?: boolean;
}

export interface BurnOptions {
  durationMs?: number;
  imagePath?: string;
}

export interface BurnDeps {
  overlays: OverlayManager;
  readCursor(): Point | null;
  activeWindow(): ActiveWindowInfo | null;
}

interface Pending {
  overlays: Overlay[];
  done: Map<number, BurnDoneReport>;
  resolve: (outcome: BurnOutcome) => void;
  watchdog: NodeJS.Timeout;
}

export class BurnController {
  private pending: Pending | null = null;
  private busy = false;
  private escRegistered = false;

  constructor(private readonly deps: BurnDeps) {
    deps.overlays.on('burn-done', (overlay: Overlay, report: BurnDoneReport) => this.onDone(overlay, report));
  }

  get burning(): boolean {
    return this.busy;
  }

  /** macOS: has the user allowed screen capture? (Always true elsewhere.) */
  static screenCaptureAllowed(): boolean {
    if (process.platform !== 'darwin') return true;
    try {
      const status = systemPreferences.getMediaAccessStatus('screen');
      return status === 'granted' || status === 'not-determined';
    } catch {
      return true;
    }
  }

  async start(mode: BurnMode, options: BurnOptions = {}): Promise<BurnOutcome> {
    if (this.busy) return { ok: false, reason: 'busy' };
    this.busy = true;
    try {
      const outcome = await this.run(mode, options);
      if (!outcome.ok) this.busy = false;
      return outcome;
    } catch (err) {
      this.busy = false;
      log.error('burn failed:', err);
      return { ok: false, reason: 'capture', error: (err as Error).message };
    }
  }

  abort(): void {
    const p = this.pending;
    if (!p) return;
    for (const overlay of p.overlays) this.deps.overlays.sendTo(overlay, IPC.burnAbort, null);
  }

  // ── internals ──────────────────────────────────────────────────────────

  private async run(mode: BurnMode, options: BurnOptions): Promise<BurnOutcome> {
    const overlays = this.deps.overlays.list().filter((o) => o.loaded && !o.window.isDestroyed());
    if (overlays.length === 0) return { ok: false, reason: 'no-overlay' };
    const durationMs = options.durationMs ?? BURN_DURATION_MS;
    const cursor = this.deps.readCursor();
    const underCursor = (cursor && overlays.find((o) => rectContainsPoint(o.info.bounds, cursor))) || overlays[0]!;

    if (mode === 'image') {
      if (!options.imagePath) return { ok: false, reason: 'image' };
      const img = nativeImage.createFromPath(options.imagePath);
      if (img.isEmpty()) return { ok: false, reason: 'image', error: 'unreadable image' };
      const { width, height } = img.getSize();
      const k = downscaleFactor(width, height);
      const pic = k < 1 ? img.resize({ width: Math.round(width * k), height: Math.round(height * k), quality: 'good' }) : img;
      const b = underCursor.info.bounds;
      const rect = fitContain(width, height, { x: 0, y: 0, width: b.width, height: b.height }, Math.round(Math.min(b.width, b.height) * 0.06));
      const ignite = { x: rect.x + rect.width / 2, y: rect.y + rect.height * 0.9 };
      return this.launch([{ overlay: underCursor, payload: { mode, image: pic.toPNG(), mime: 'image/png', imageRect: rect, burnRect: rect, ignite, durationMs } }]);
    }

    if (!BurnController.screenCaptureAllowed()) return { ok: false, reason: 'permission' };

    let targets = overlays;
    let windowRect: { overlay: Overlay; rect: { x: number; y: number; width: number; height: number } } | null = null;
    if (mode === 'window') {
      const w = this.deps.activeWindow();
      if (!w) return { ok: false, reason: 'no-window' };
      const c = rectCenter(w.bounds);
      const host = overlays.find((o) => rectContainsPoint(o.info.bounds, c));
      if (!host) return { ok: false, reason: 'no-window' };
      const local = intersectRect(toLocalRect(w.bounds, host.info.bounds), { x: 0, y: 0, width: host.info.bounds.width, height: host.info.bounds.height });
      if (local.width < 40 || local.height < 40) return { ok: false, reason: 'no-window' };
      targets = [host];
      windowRect = { overlay: host, rect: local };
    }

    // 1. Every target clears its fire so the capture shows the desktop only.
    await this.prepare(targets);

    // 2. One capture per display.
    const images = await this.capture(targets);
    if (!images) {
      for (const o of targets) this.deps.overlays.sendTo(o, IPC.burnAbort, null);
      return { ok: false, reason: 'capture' };
    }

    // 3. Send each display its own picture.
    const jobs = targets.map((overlay, i) => {
      const b = overlay.info.bounds;
      const full = { x: 0, y: 0, width: b.width, height: b.height };
      const burnRect = windowRect && windowRect.overlay === overlay ? windowRect.rect : full;
      const local = cursor && rectContainsPoint(b, cursor) ? toLocalPoint(cursor, b) : null;
      const ignite =
        local && rectContainsPoint(burnRect, local)
          ? local
          : { x: burnRect.x + burnRect.width / 2, y: burnRect.y + burnRect.height * (mode === 'window' ? 0.15 : 0.85) };
      const payload: BurnStart = { mode, image: images[i]!.toJPEG(90), mime: 'image/jpeg', imageRect: full, burnRect, ignite, durationMs };
      return { overlay, payload };
    });
    return this.launch(jobs);
  }

  private launch(jobs: Array<{ overlay: Overlay; payload: BurnStart }>): Promise<BurnOutcome> {
    return new Promise<BurnOutcome>((resolve) => {
      const durationMs = Math.max(...jobs.map((j) => j.payload.durationMs));
      const pending: Pending = {
        overlays: jobs.map((j) => j.overlay),
        done: new Map(),
        resolve,
        watchdog: setTimeout(() => this.finish('watchdog'), durationMs + WATCHDOG_SLACK_MS),
      };
      this.pending = pending;
      for (const { overlay, payload } of jobs) {
        this.deps.overlays.setInteractive(overlay, true);
        this.deps.overlays.sendTo(overlay, IPC.burnStart, payload);
      }
      this.registerEsc();
      log.info(`burning ${jobs[0]?.payload.mode} on ${jobs.length} display(s)`);
    });
  }

  private onDone(overlay: Overlay, report: BurnDoneReport): void {
    const p = this.pending;
    if (!p || !p.overlays.includes(overlay)) return;
    p.done.set(overlay.id, report);
    if (!report.ok) log.warn(`overlay#${overlay.info.index} burn failed: ${report.error ?? 'unknown'}`);
    if (p.done.size >= p.overlays.length) this.finish('done');
  }

  private finish(why: 'done' | 'watchdog'): void {
    const p = this.pending;
    if (!p) return;
    this.pending = null;
    clearTimeout(p.watchdog);
    for (const overlay of p.overlays) this.deps.overlays.setInteractive(overlay, false);
    this.unregisterEsc();
    this.busy = false;
    const reports = [...p.done.values()];
    const ok = why === 'done' && reports.length > 0 && reports.every((r) => r.ok);
    if (why === 'watchdog') {
      log.warn('burn watchdog fired: restoring click-through');
      for (const overlay of p.overlays) this.deps.overlays.sendTo(overlay, IPC.burnAbort, null);
    }
    const error = reports.find((r) => r.error)?.error;
    p.resolve({ ok, aborted: reports.some((r) => r.aborted), ...(ok ? {} : { reason: 'renderer' as const }), ...(error ? { error } : {}) });
  }

  private prepare(targets: Overlay[]): Promise<void> {
    return new Promise((resolve) => {
      const waiting = new Set(targets.map((o) => o.id));
      const onReady = (overlay: Overlay): void => {
        waiting.delete(overlay.id);
        if (waiting.size === 0) done();
      };
      const timer = setTimeout(() => done(), PREPARE_TIMEOUT_MS);
      let finished = false;
      const done = (): void => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        this.deps.overlays.off('burn-ready', onReady);
        setTimeout(resolve, COMPOSITOR_SETTLE_MS);
      };
      this.deps.overlays.on('burn-ready', onReady);
      for (const o of targets) this.deps.overlays.sendTo(o, IPC.burnPrepare, null);
    });
  }

  /** Captures every target display; null when any capture fails. */
  private async capture(targets: Overlay[]): Promise<NativeImage[] | null> {
    let maxW = 1;
    let maxH = 1;
    for (const o of targets) {
      maxW = Math.max(maxW, Math.round(o.info.bounds.width * o.info.scaleFactor));
      maxH = Math.max(maxH, Math.round(o.info.bounds.height * o.info.scaleFactor));
    }
    const k = downscaleFactor(maxW, maxH, BURN_MAX_SIDE);
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: Math.round(maxW * k), height: Math.round(maxH * k) },
    });
    if (sources.length === 0) return null;
    const all = screen.getAllDisplays();
    const out: NativeImage[] = [];
    for (const o of targets) {
      const byId = sources.find((s) => s.display_id === String(o.info.id));
      const byIndex = sources[all.findIndex((d) => d.id === o.info.id)];
      const src = byId ?? (sources.length === 1 ? sources[0] : byIndex);
      if (!src || src.thumbnail.isEmpty()) {
        log.warn(`no capture for display ${o.info.id}`);
        return null;
      }
      out.push(src.thumbnail);
    }
    return out;
  }

  /**
   * Esc stops the burn. The focused overlay receives it as a key event on
   * Windows/macOS; Linux overlays cannot take focus, so a global Escape is
   * registered there for the duration of the burn only.
   */
  private registerEsc(): void {
    if (process.platform !== 'linux' || this.escRegistered) return;
    try {
      this.escRegistered = globalShortcut.register('Escape', () => this.abort());
    } catch {
      this.escRegistered = false;
    }
  }

  private unregisterEsc(): void {
    if (!this.escRegistered) return;
    try {
      globalShortcut.unregister('Escape');
    } catch {
      /* ignore */
    }
    this.escRegistered = false;
  }
}
