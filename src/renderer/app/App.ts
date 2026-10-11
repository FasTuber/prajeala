/**
 * Renderer orchestrator: talks to the preload bridge, owns the frame loop and
 * wires input → emitters → simulation → render passes. Never throws out of
 * init(); failures are reported through `reportReady({ ok: false })`.
 */
import type {
  ActiveWindowEvent,
  PowerFrame,
  CursorEvent,
  DisplayInfo,
  HostCapabilities,
  PointerButtonEvent,
  PrajealaApi,
  RendererReadyReport,
  Unsubscribe,
} from '../../shared/ipc';
import { resolvePalette } from '../../shared/palettes';
import {
  DEFAULT_SETTINGS,
  INTENSITY_PRESETS,
  normalizeSettings,
  type IntensityPreset,
  type Settings,
} from '../../shared/settings';
import type { BurnStart } from '../../shared/burn';
import { BurnLayer } from '../burn/BurnLayer';
import { FireCursor } from '../cursor/FireCursor';
import { BurstEmitter } from '../emitters/BurstEmitter';
import { CursorEmitter } from '../emitters/CursorEmitter';
import { EmitterContext, type Emitter } from '../emitters/EmitterContext';
import { ScreenBottomEmitter } from '../emitters/ScreenBottomEmitter';
import { WindowFrameEmitter } from '../emitters/WindowFrameEmitter';
import { Device } from '../gl/Device';
import { DebugHud } from '../hud/DebugHud';
import { CursorState } from '../input/CursorState';
import { SyntheticCursor } from '../mock/SyntheticCursor';
import { DEFAULT_LOOK, FireRenderer, type RenderLook } from '../render/FireRenderer';
import { FireSimulation, SIM_MAX_SIDE, SIM_MIN_SIDE, type SimParams } from '../sim/FireSimulation';
import { SplatQueue } from '../sim/SplatQueue';
import { SparkRenderer } from '../sparks/SparkRenderer';
import { Sparks } from '../sparks/Sparks';
import { clamp, clamp01, lerp } from '../util/math';
import type { RendererOptions } from './options';

interface GpuScene {
  device: Device;
  sim: FireSimulation;
  renderer: FireRenderer;
  fireCursor: FireCursor;
  sparkRenderer: SparkRenderer;
  burn: BurnLayer;
}

export interface AppEnvironment {
  /** True when the API is the in-page mock (standalone browser). */
  mock: boolean;
}

const MAX_DT = 1 / 30;
/** Without new heat or sparks for this long the field is invisible: stop rendering until something happens. */
const COLD_AFTER_MS = 3000;
const IDLE_INTERVAL_MS = 250;
const HUD_INTERVAL_MS = 250;

export class App {
  private settings: Settings = DEFAULT_SETTINGS;
  private preset: IntensityPreset = INTENSITY_PRESETS[DEFAULT_SETTINGS.intensity];
  private display: DisplayInfo | null = null;
  private caps: HostCapabilities | null = null;
  private gpu: GpuScene | null = null;

  private readonly queue = new SplatQueue();
  private readonly sparks = new Sparks();
  private readonly cursor = new CursorState();
  private readonly hud = new DebugHud();
  private readonly ctx: EmitterContext;
  private readonly cursorEmitter: CursorEmitter;
  private readonly burstEmitter: BurstEmitter;
  private readonly windowEmitter = new WindowFrameEmitter();
  private readonly bottomEmitter = new ScreenBottomEmitter();
  private readonly emitters: Emitter[];
  private readonly simParams: SimParams = {
    heatDissipation: 0.93,
    smokeDissipation: 0.95,
    velocityDissipation: 0.96,
    cooling: 0.56,
    buoyancy: 0.6,
    curl: 22,
    maxSpeed: 1.4,
    pressureIterations: 12,
  };
  private readonly look: RenderLook = { ...DEFAULT_LOOK };

  private synthetic: SyntheticCursor | null = null;
  private readonly syntheticPoint = { x: 0, y: 0 };
  private nextSyntheticBurst = 0;

  private cssWidth = 1;
  private cssHeight = 1;
  private dpr = 1;

  private frames = 0;
  private fpsCounter = 0;
  private fps = 0;
  private time = 0;
  private lastFrameAt = 0;
  private lastTickAt = 0;
  private lastHudAt = 0;
  private rafId = 0;
  private idleTimer = 0;
  private statsTimer = 0;
  private running = false;
  private contextLost = false;
  private readyReported = false;
  private clearedWhileDisabled = false;
  /** Nothing burns on this display: the frame loop idles until an event wakes it. */
  private cold = false;
  private lastHeatAt = 0;
  private power: PowerFrame = { sleeping: false };
  /** Main is capturing the screen for a burn: draw nothing. */
  private capturing = false;
  private captureTimer = 0;
  private warmupPending = 0;
  private dprQuery: MediaQueryList | null = null;
  private readonly unsubscribers: Unsubscribe[] = [];

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly api: PrajealaApi,
    private readonly options: RendererOptions,
    private readonly env: AppEnvironment,
  ) {
    this.ctx = new EmitterContext(this.queue, this.sparks);
    this.cursorEmitter = new CursorEmitter(this.cursor, this.ctx);
    this.burstEmitter = new BurstEmitter(this.ctx);
    this.emitters = [this.cursorEmitter, this.burstEmitter, this.windowEmitter, this.bottomEmitter];
    this.warmupPending = options.warmup;
    this.look.view = options.view;
  }

  /** Boots the renderer. Resolves once reportReady() has been sent. */
  async init(): Promise<void> {
    try {
      const [settings, display, caps] = await Promise.all([
        this.api.getSettings(),
        this.api.getDisplay(),
        this.api.getCapabilities(),
      ]);
      this.display = display;
      this.caps = caps;
      this.applySettings(settings);
    } catch (err) {
      this.log('warn', `initial state unavailable, using defaults: ${describe(err)}`);
      this.applySettings(DEFAULT_SETTINGS);
    }

    let error: string | undefined;
    try {
      this.measure();
      this.buildGpu();
    } catch (err) {
      error = describe(err);
      this.log('error', `GPU initialisation failed: ${error}`);
      this.gpu = null;
    }

    try {
      this.subscribe();
      this.installDomListeners();
      this.updateSmokeDriver();
    } catch (err) {
      this.log('error', `listener setup failed: ${describe(err)}`);
    }

    this.reportReady(error);
    this.running = true;
    this.statsTimer = window.setInterval(() => this.reportStats(), 1000);
    this.scheduleRaf();
    this.installDevHooks();
  }

  /** `?losectx=ms`: simulate a GPU reset (context loss, then restore 800 ms later). */
  private installDevHooks(): void {
    if (this.options.loseContextAt > 0) {
      window.setTimeout(() => {
        const ext = this.gpu?.device.gl.getExtension('WEBGL_lose_context');
        if (!ext) return this.log('warn', 'WEBGL_lose_context unavailable');
        this.log('info', 'dev: losing WebGL context');
        ext.loseContext();
        window.setTimeout(() => ext.restoreContext(), 800);
      }, this.options.loseContextAt);
    }
  }

  // ───────────────────────────── GPU lifecycle ─────────────────────────────

  private buildGpu(): void {
    const device = Device.create(this.canvas, {
      forceByte: this.options.forceByte,
      forceNearest: this.options.forceNearest,
    });
    if (!device) throw new Error('WebGL2 is not available');
    const { w, h } = this.simSize();
    let sim: FireSimulation | null = null;
    let renderer: FireRenderer | null = null;
    let fireCursor: FireCursor | null = null;
    try {
      sim = new FireSimulation(device, w, h, this.queue);
      renderer = new FireRenderer(device, sim.width, sim.height);
      renderer.setPalette(resolvePalette(this.settings.palette, this.settings.customColors));
      fireCursor = new FireCursor(device);
      const sparkRenderer = new SparkRenderer(device, this.sparks.capacity);
      const burn = new BurnLayer(device);
      burn.onDone = (aborted) => this.onBurnDone(aborted);
      this.gpu = { device, sim, renderer, fireCursor, sparkRenderer, burn };
    } catch (err) {
      fireCursor?.dispose();
      renderer?.dispose();
      sim?.dispose();
      device.dispose();
      throw err;
    }
    this.clearedWhileDisabled = false;
    if (!device.caps.floatTextures) this.log('warn', 'half-float render targets unavailable: using the 8-bit fallback');
    if (!device.caps.linearFiltering) this.log('warn', 'linear filtering unavailable: using manual bilinear sampling');
  }

  private disposeGpu(): void {
    const g = this.gpu;
    this.gpu = null;
    if (!g) return;
    try {
      g.burn.dispose();
      g.sparkRenderer.dispose();
      g.fireCursor.dispose();
      g.renderer.dispose();
      g.sim.dispose();
      g.device.dispose();
    } catch {
      /* context may already be gone */
    }
  }

  /** Simulation size: canvas × simScale, aspect preserved, sides within [64, 1024]. */
  private simSize(): { w: number; h: number } {
    let w = Math.max(1, this.canvas.width) * this.settings.simScale;
    let h = Math.max(1, this.canvas.height) * this.settings.simScale;
    const maxSide = Math.max(w, h);
    if (maxSide > SIM_MAX_SIDE) {
      const f = SIM_MAX_SIDE / maxSide;
      w *= f;
      h *= f;
    }
    const minSide = Math.min(w, h);
    if (minSide < SIM_MIN_SIDE) {
      const f = SIM_MIN_SIDE / minSide;
      w *= f;
      h *= f;
    }
    return { w: Math.round(w), h: Math.round(h) };
  }

  private measure(): void {
    const w = Math.max(1, window.innerWidth);
    const h = Math.max(1, window.innerHeight);
    const dpr = clamp(window.devicePixelRatio || 1, 0.5, 4);
    const cw = Math.max(1, Math.round(w * dpr));
    const ch = Math.max(1, Math.round(h * dpr));
    if (this.canvas.width !== cw || this.canvas.height !== ch) {
      this.canvas.width = cw;
      this.canvas.height = ch;
    }
    this.cssWidth = w;
    this.cssHeight = h;
    this.dpr = dpr;
    this.ctx.width = w;
    this.ctx.height = h;
    this.ctx.floor = this.floorY(h);
    this.updateSimSize();
    this.watchDpr();
  }

  /** Local y the bottom fire stands on: the top of the taskbar/Dock unless the user wants it over the taskbar. */
  private floorY(cssHeight: number): number {
    const d = this.display;
    if (!d || this.settings.fireOverTaskbar) return cssHeight;
    const workBottom = d.workArea.y + d.workArea.height - d.bounds.y;
    return workBottom > cssHeight * 0.5 && workBottom < cssHeight ? workBottom : cssHeight;
  }

  private updateSimSize(): void {
    const g = this.gpu;
    if (!g) return;
    const { w, h } = this.simSize();
    g.sim.resize(w, h);
    g.renderer.resize(g.sim.width, g.sim.height);
  }

  private watchDpr(): void {
    if (this.dprQuery) this.dprQuery.removeEventListener('change', this.onDprChange);
    try {
      this.dprQuery = window.matchMedia(`(resolution: ${this.dpr}dppx)`);
      this.dprQuery.addEventListener('change', this.onDprChange);
    } catch {
      this.dprQuery = null;
    }
  }

  private readonly onDprChange = (): void => {
    this.measure();
  };

  // ───────────────────────────── Settings & state ─────────────────────────────

  private applySettings(input: Settings): void {
    const prev = this.settings;
    const next = normalizeSettings(input);
    this.settings = next;
    this.preset = INTENSITY_PRESETS[next.intensity];
    this.ctx.settings = next;
    this.ctx.preset = this.preset;
    this.sparks.budget = this.preset.sparkBudget;
    this.refreshSimParams();
    this.hud.setVisible(next.showDebugHud || this.options.hud);
    if (this.gpu && (next.palette !== prev.palette || next.customColors.join() !== prev.customColors.join())) {
      this.gpu.renderer.setPalette(resolvePalette(next.palette, next.customColors));
    }
    if (next.simScale !== prev.simScale) this.updateSimSize();
    if (next.fireOverTaskbar !== prev.fireOverTaskbar) this.ctx.floor = this.floorY(this.cssHeight);
    this.wake();
    if (!next.sparks) this.sparks.clear();
    if (next.enabled && !prev.enabled) {
      this.clearedWhileDisabled = false;
      this.lastTickAt = 0;
      this.scheduleRaf();
    }
  }

  private refreshSimParams(): void {
    const p = this.preset;
    const s = this.simParams;
    // Flame lifetime ≈ 1 / cooling: low 0.25 s, medium 0.36 s, high 0.56 s, inferno 1 s.
    s.heatDissipation = p.heatDissipation;
    s.smokeDissipation = 0.4;
    // Presets express velocity retention generously; swirl should settle within a couple of seconds.
    s.velocityDissipation = Math.pow(p.velocityDissipation, 8);
    s.cooling = (1 - p.heatDissipation) * 35;
    s.buoyancy = p.buoyancy * 1.1;
    s.curl = p.curl * 2;
    s.maxSpeed = 1.0 + p.buoyancy * 0.35;
    s.pressureIterations = this.settings.pressureIterations;
  }

  private subscribe(): void {
    const api = this.api;
    this.unsubscribers.push(
      api.onCursor((e) => this.handleCursor(e)),
      api.onPointerButton((e) => this.handlePointerButton(e)),
      api.onActiveWindow((e) => this.handleActiveWindow(e)),
      api.onSettings((s) => this.applySettings(s)),
      api.onDisplay((d) => this.handleDisplay(d)),
      api.onCapabilities((c) => this.handleCapabilities(c)),
      api.onTestBurst((p) => this.handleTestBurst(p)),
      api.onKeyPress(() => this.handleKeyPress()),
      api.onPower((p) => this.handlePower(p)),
      api.onBurnPrepare(() => this.handleBurnPrepare()),
      api.onBurnStart((p) => void this.handleBurnStart(p)),
      api.onBurnAbort(() => this.handleBurnAbort()),
    );
  }

  private handleCursor(e: CursorEvent): void {
    this.cursor.push(e);
    if (this.power.sleeping) return;
    if (e.inside && this.settings.cursorMode !== 'off') this.wake();
    if (this.settings.enabled && this.gpu && !this.contextLost) this.cursorEmitter.onMove(e);
  }

  private handlePower(p: PowerFrame): void {
    const wasSleeping = this.power.sleeping;
    this.power = { sleeping: p.sleeping === true };
    if (wasSleeping && !this.power.sleeping) this.wake();
  }

  // ───────────────────────────── Arde tot ─────────────────────────────

  /** Main is about to capture the screen: show nothing for a couple of frames, then say so. */
  private handleBurnPrepare(): void {
    this.capturing = true;
    this.clearCanvas();
    requestAnimationFrame(() => requestAnimationFrame(() => {
      this.clearCanvas();
      this.api.burnReady();
    }));
    window.clearTimeout(this.captureTimer);
    this.captureTimer = window.setTimeout(() => {
      this.capturing = false;
    }, 2000);
  }

  private async handleBurnStart(p: BurnStart): Promise<void> {
    window.clearTimeout(this.captureTimer);
    this.capturing = false;
    const g = this.gpu;
    if (!g || this.contextLost) {
      this.api.burnDone({ ok: false, aborted: false, error: 'no GPU' });
      return;
    }
    try {
      const bitmap = await createImageBitmap(new Blob([p.image as BlobPart], { type: p.mime }));
      if (this.gpu !== g) {
        bitmap.close();
        this.api.burnDone({ ok: false, aborted: false, error: 'GPU reset' });
        return;
      }
      g.burn.start(p, bitmap, this.canvas.width, this.canvas.height, this.cssWidth, this.cssHeight);
      bitmap.close();
      this.setInteractive(true);
      this.log('info', `burning (${p.mode})`);
      this.wake();
      this.scheduleRaf();
    } catch (err) {
      this.log('error', `could not start the burn: ${describe(err)}`);
      this.api.burnDone({ ok: false, aborted: false, error: describe(err) });
    }
  }

  private handleBurnAbort(): void {
    window.clearTimeout(this.captureTimer);
    this.capturing = false;
    this.gpu?.burn.abort();
  }

  private onBurnDone(aborted: boolean): void {
    this.setInteractive(false);
    this.api.burnDone({ ok: true, aborted });
  }

  /** During a burn the page takes clicks (new fires) and Esc (stop) itself. */
  private setInteractive(on: boolean): void {
    if (this.env.mock) return; // the mock page is always interactive
    const value = on ? 'auto' : 'none';
    document.documentElement.style.pointerEvents = value;
    document.body.style.pointerEvents = value;
    document.body.style.cursor = on ? 'crosshair' : '';
  }

  private readonly onPagePointerDown = (e: PointerEvent): void => {
    const burn = this.gpu?.burn;
    if (!burn?.active) return;
    burn.ignite(e.clientX, e.clientY, 1);
    this.burstEmitter.trigger(e.clientX, e.clientY, this.preset.burst * 0.6);
  };

  private readonly onPageKeyDown = (e: KeyboardEvent): void => {
    if (e.key === 'Escape' && this.gpu?.burn.active) this.gpu.burn.abort();
  };

  private clearCanvas(): void {
    const g = this.gpu;
    if (!g || this.contextLost) return;
    const gl = g.device.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
  }

  /** Leaves the cold idle state (an event may light something). */
  private wake(): void {
    this.lastHeatAt = performance.now();
    if (!this.cold) return;
    this.cold = false;
    this.lastTickAt = 0;
    this.scheduleRaf();
  }

  private handlePointerButton(e: PointerButtonEvent): void {
    if (e.type !== 'down' || !this.settings.clickBursts || !this.settings.enabled) return;
    if (!e.inside && !this.ctx.inView(e.x, e.y, this.ctx.radius * 6)) return;
    this.wake();
    this.burstEmitter.trigger(e.x, e.y, this.preset.burst, e.button);
  }

  private handleTestBurst(p: { x: number; y: number; strength: number }): void {
    if (!this.settings.enabled) return;
    this.wake();
    this.burstEmitter.trigger(p.x, p.y, Number.isFinite(p.strength) ? p.strength : this.preset.burst);
  }

  private lastKeyFlareAt = 0;

  /** Typing fire (Pro): a small flare on the focused window's frame for each key, at most ~25 per second. */
  private handleKeyPress(): void {
    const s = this.settings;
    if (!s.enabled || !s.typingFire || !this.gpu) return;
    const now = performance.now();
    if (now - this.lastKeyFlareAt < 40) return;
    this.lastKeyFlareAt = now;
    let x: number;
    let y: number;
    if (this.windowEmitter.visible) {
      const r = this.windowEmitter.rect;
      x = r.x + Math.random() * r.width;
      y = r.y;
    } else if (this.cursor.hasPosition && this.cursor.inside) {
      x = this.cursor.x + (Math.random() - 0.5) * this.ctx.radius * 4;
      y = this.cursor.y;
    } else {
      return;
    }
    if (!this.ctx.inView(x, y, 0)) return;
    this.wake();
    this.burstEmitter.trigger(x, y, this.preset.burst * 0.35, 'middle');
  }

  private handleActiveWindow(e: ActiveWindowEvent | null): void {
    this.windowEmitter.setTarget(e);
    if (e?.intersects) this.wake();
  }

  private handleDisplay(d: DisplayInfo): void {
    this.display = d;
    this.measure();
  }

  private handleCapabilities(c: HostCapabilities): void {
    this.caps = c;
    this.updateSmokeDriver();
  }

  private updateSmokeDriver(): void {
    const want = (this.caps?.smoke ?? false) || this.options.smoke;
    if (want && !this.synthetic) {
      this.synthetic = new SyntheticCursor(0.5);
      this.nextSyntheticBurst = this.time + 0.5;
      this.log('info', 'smoke mode: driving a synthetic cursor and periodic bursts');
    } else if (!want) {
      this.synthetic = null;
    }
  }

  private driveSynthetic(): void {
    const s = this.synthetic;
    if (!s) return;
    const p = this.syntheticPoint;
    s.sample(this.time, this.cssWidth, this.cssHeight, p);
    const t = performance.now();
    this.handleCursor({ x: p.x, y: p.y, gx: p.x, gy: p.y, inside: true, t });
    if (this.time >= this.nextSyntheticBurst) {
      this.nextSyntheticBurst = this.time + 0.85 + Math.random() * 0.3;
      this.handleTestBurst({ x: p.x, y: p.y, strength: this.preset.burst });
    }
  }

  // ───────────────────────────── DOM lifecycle ─────────────────────────────

  private installDomListeners(): void {
    window.addEventListener('resize', () => this.measure());
    window.addEventListener('pointerdown', this.onPagePointerDown);
    window.addEventListener('keydown', this.onPageKeyDown);
    this.canvas.addEventListener('webglcontextlost', (e) => {
      e.preventDefault();
      this.contextLost = true;
      if (this.gpu?.burn.active) {
        this.setInteractive(false);
        this.api.burnDone({ ok: false, aborted: true, error: 'WebGL context lost' });
      }
      this.gpu = null; // GPU objects are gone; nothing to dispose
      this.log('warn', 'WebGL context lost');
    });
    this.canvas.addEventListener('webglcontextrestored', () => {
      try {
        this.buildGpu();
        this.contextLost = false;
        this.lastTickAt = 0;
        this.log('info', 'WebGL context restored');
        this.scheduleRaf();
      } catch (err) {
        this.log('error', `could not rebuild after context restore: ${describe(err)}`);
      }
    });
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) {
        this.lastTickAt = 0;
        this.scheduleRaf();
      }
    });
  }

  // ───────────────────────────── Frame loop ─────────────────────────────

  private scheduleRaf(): void {
    if (this.rafId || !this.running) return;
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = 0;
    }
    this.rafId = requestAnimationFrame(this.frame);
  }

  private scheduleIdle(): void {
    if (this.idleTimer || !this.running) return;
    this.idleTimer = window.setTimeout(() => {
      this.idleTimer = 0;
      this.scheduleRaf();
    }, IDLE_INTERVAL_MS);
  }

  private readonly frame = (now: number): void => {
    this.rafId = 0;
    if (!this.running) return;
    const idle = document.hidden || !this.settings.enabled || this.contextLost || !this.gpu || this.cold || this.capturing;
    if (idle) {
      this.idleFrame();
      this.scheduleIdle();
      return;
    }
    if (this.warmupPending > 0) this.runWarmup();
    const interval = 1000 / clamp(this.settings.maxFps, 15, 240);
    const since = now - this.lastFrameAt;
    if (since < interval - 0.5) {
      this.scheduleRaf();
      return;
    }
    this.lastFrameAt = since > interval * 2 ? now : this.lastFrameAt + interval;
    const dt = this.lastTickAt ? clamp((now - this.lastTickAt) / 1000, 0.0005, MAX_DT) : 1 / 60;
    this.lastTickAt = now;
    this.time = (this.time + dt) % 3600;
    try {
      this.update(dt);
      this.render();
    } catch (err) {
      this.log('error', `frame failed: ${describe(err)}`);
    }
    this.checkCold(now);
    this.frames++;
    this.fpsCounter++;
    if (now - this.lastHudAt > HUD_INTERVAL_MS) {
      this.lastHudAt = now;
      this.updateHud();
    }
    this.scheduleRaf();
  };

  private emberAccumulator = 0;

  /** Embers and ash lifting off the burn front (positions from BurnLayer's probe). */
  private emitBurnEmbers(dt: number): void {
    const front = this.gpu?.burn.front;
    if (!front || front.count === 0) return;
    this.emberAccumulator += Math.min(160, 25 + front.count * 0.8) * dt;
    const n = Math.floor(this.emberAccumulator);
    this.emberAccumulator -= n;
    const rng = this.sparks.random;
    const cell = this.cssWidth / 64;
    for (let i = 0; i < n; i++) {
      const k = Math.floor(rng.next() * front.count);
      const x = (front.points[k * 2] ?? 0) + rng.range(-cell, cell) * 0.5;
      const y = (front.points[k * 2 + 1] ?? 0) + rng.range(-cell, cell) * 0.5;
      this.sparks.emit(x, y, rng.range(-50, 50), rng.range(-240, -60), rng.range(0.6, 1.7));
    }
  }

  /** Dev hook (`?warmup=N`): advance the simulation N fixed steps before the first visible frame. */
  private runWarmup(): void {
    const n = this.warmupPending;
    this.warmupPending = 0;
    const dt = 1 / 60;
    try {
      for (let i = 0; i < n; i++) {
        this.time = (this.time + dt) % 3600;
        this.update(dt);
      }
    } catch (err) {
      this.log('error', `warm-up failed: ${describe(err)}`);
    }
    this.log('info', `warm-up: ran ${n} steps`);
  }

  /** Goes cold once nothing has been lit for COLD_AFTER_MS and no spark is alive. */
  private checkCold(now: number): void {
    if (this.lastHeatAt === 0) this.lastHeatAt = now;
    if (this.sparks.count > 0 || now - this.lastHeatAt < COLD_AFTER_MS) return;
    this.cold = true;
    this.clearedWhileDisabled = false;
  }

  /** Disabled / hidden / cold: clear everything once, then do nothing. */
  private idleFrame(): void {
    const g = this.gpu;
    if ((!this.settings.enabled || this.cold) && !this.clearedWhileDisabled && g && !this.contextLost) {
      const gl = g.device.gl;
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, this.canvas.width, this.canvas.height);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      g.sim.clear();
      this.sparks.clear();
      this.queue.clear();
      this.clearedWhileDisabled = true;
    }
    if (this.hud.isVisible) this.updateHud();
  }

  private update(dt: number): void {
    const g = this.gpu;
    if (!g) return;
    this.cursor.tick(dt);
    this.ctx.dt = dt;
    this.ctx.time = this.time;
    this.driveSynthetic();
    for (const e of this.emitters) {
      // Asleep (user away): only events already in flight keep burning; nothing new is lit.
      if (this.power.sleeping && e !== this.burstEmitter) continue;
      e.update(this.ctx);
    }
    const now = performance.now();
    if (g.burn.active) {
      g.burn.update(dt, g.sim.temperatureTexture, now);
      this.emitBurnEmbers(dt);
      this.lastHeatAt = now;
    }
    if (this.queue.count > 0) this.lastHeatAt = now;
    if (this.settings.sparks || g.burn.active) this.sparks.update(dt, this.cssWidth, this.cssHeight, this.time);
    g.sim.step(dt, this.simParams, g.burn.source(now));
  }

  private render(): void {
    const g = this.gpu;
    if (!g) return;
    const s = this.settings;
    const now = performance.now();
    g.renderer.render(
      g.sim.temperatureTexture,
      g.sim.width,
      g.sim.height,
      this.canvas.width,
      this.canvas.height,
      this.time,
      this.look,
      g.burn.active
        ? () => g.burn.draw(this.canvas.width, this.canvas.height, g.sim.temperatureTexture, g.sim.width, g.sim.height, g.renderer.lutTexture, this.time, now)
        : undefined,
    );
    const c = this.cursor;
    if (s.cursorMode !== 'off' && c.hasPosition && c.inside && !this.power.sleeping) {
      const speedK = clamp01(c.speed / 1400);
      const r = this.ctx.radius;
      const comet = s.cursorMode === 'comet';
      const lean = (comet ? 0.95 : 0.6) * speedK;
      g.fireCursor.draw(
        {
          x: c.x,
          y: c.y,
          width: this.cssWidth,
          height: this.cssHeight,
          size: r * (s.cursorMode === 'halo' ? 2.3 : lerp(2.1, 3.1, comet ? speedK : speedK * 0.5)),
          leanX: -c.dirX * lean,
          leanY: c.dirY * lean,
          intensity: s.cursorMode === 'trail' ? 0.9 : 1 + 0.25 * speedK,
          time: this.time,
        },
        g.renderer.lutTexture,
      );
    }
    if (s.sparks || g.burn.active) {
      g.sparkRenderer.draw(this.sparks, this.cssWidth, this.cssHeight, this.dpr, resolvePalette(s.palette, s.customColors).spark);
    }
  }

  // ───────────────────────────── Reporting ─────────────────────────────

  private reportReady(error: string | undefined): void {
    if (this.readyReported) return;
    this.readyReported = true;
    const g = this.gpu;
    const report: RendererReadyReport = {
      ok: !error && !!g,
      webgl2: !!g || isWebGL2Supported(this.canvas),
      floatTextures: g?.device.caps.floatTextures ?? false,
      renderer: g?.device.caps.renderer ?? '',
      simWidth: g?.sim.width ?? 0,
      simHeight: g?.sim.height ?? 0,
      canvasWidth: this.canvas.width,
      canvasHeight: this.canvas.height,
    };
    if (error) report.error = error;
    try {
      this.api.reportReady(report);
    } catch (err) {
      console.error('[prajeala] reportReady failed', err);
    }
  }

  private reportStats(): void {
    this.fps = this.fpsCounter;
    this.fpsCounter = 0;
    const g = this.gpu;
    try {
      this.api.reportStats({
        frames: this.frames,
        fps: this.fps,
        simWidth: g?.sim.width ?? 0,
        simHeight: g?.sim.height ?? 0,
        sparks: this.sparks.count,
      });
    } catch (err) {
      console.error('[prajeala] reportStats failed', err);
    }
  }

  private updateHud(): void {
    if (!this.hud.isVisible) return;
    const g = this.gpu;
    const s = this.settings;
    const c = this.cursor;
    const caps = g?.device.caps;
    const active: string[] = [];
    if (s.cursorMode !== 'off') active.push(`cursor:${s.cursorMode}${this.cursorEmitter.active ? '*' : ''}`);
    if (s.clickBursts) active.push(`burst(${this.burstEmitter.total})${this.burstEmitter.active ? '*' : ''}`);
    if (s.burnActiveWindow) active.push(`window${this.windowEmitter.visible ? '*' : ''}`);
    if (s.screenBottomFire) active.push('bottom*');
    const state = !s.enabled
      ? 'PAUSED'
      : this.contextLost
        ? 'CONTEXT LOST'
        : !g
          ? 'NO GPU'
          : document.hidden
            ? 'HIDDEN'
            : this.power.sleeping
              ? `asleep${this.cold ? ' (cold)' : ''}`
              : this.cold
                ? 'cold (idle)'
                : 'running';
    const lines = [
      `prăjeală ${state} · ${this.fps} fps (cap ${s.maxFps}) · frames ${this.frames}${this.env.mock ? ' · mock' : ''}`,
      `sim ${g?.sim.width ?? 0}×${g?.sim.height ?? 0} (scale ${s.simScale}, ${s.pressureIterations} it) · canvas ${this.canvas.width}×${this.canvas.height} @${this.dpr.toFixed(2)}x`,
      `gpu ${caps?.renderer ?? 'n/a'} · float ${caps?.floatTextures ? 'yes' : 'no'} · linear ${caps?.linearFiltering ? 'yes' : 'no'}`,
      `intensity ${s.intensity} · palette ${s.palette} · emitters ${active.join(' ') || 'none'}`,
      `sparks ${this.sparks.count}/${this.sparks.budget} · queue drops ${this.queue.dropped}`,
      `cursor ${c.hasPosition ? `${c.x.toFixed(0)},${c.y.toFixed(0)} ${c.inside ? 'in' : 'out'} ${c.speed.toFixed(0)} px/s` : 'n/a'}`,
      `display ${this.display ? `#${this.display.index + 1}/${this.display.total} ${this.display.bounds.width}×${this.display.bounds.height} sf ${this.display.scaleFactor}` : 'n/a'} · caps ${this.caps ? `${this.caps.platform} clicks:${this.caps.globalClicks ? 'y' : 'n'} window:${this.caps.activeWindow ? 'y' : 'n'}${this.caps.smoke ? ' smoke' : ''}` : 'n/a'}`,
    ];
    if (this.windowEmitter.visible) {
      const r = this.windowEmitter.rect;
      lines.push(`window "${this.windowEmitter.title.slice(0, 40)}" ${r.x.toFixed(0)},${r.y.toFixed(0)} ${r.width.toFixed(0)}×${r.height.toFixed(0)}`);
    }
    this.hud.update(lines);
  }

  log(level: 'debug' | 'info' | 'warn' | 'error', message: string): void {
    try {
      this.api.log(level, message);
    } catch {
      /* ignore */
    }
    if (this.env.mock) return; // the mock already prints to the console
    const fn = level === 'error' ? console.error : level === 'warn' ? console.warn : console.info;
    fn(`[prajeala] ${message}`);
  }

  dispose(): void {
    this.running = false;
    if (this.rafId) cancelAnimationFrame(this.rafId);
    if (this.idleTimer) clearTimeout(this.idleTimer);
    if (this.statsTimer) clearInterval(this.statsTimer);
    for (const u of this.unsubscribers) u();
    this.unsubscribers.length = 0;
    this.disposeGpu();
    this.hud.dispose();
  }
}

function describe(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

function isWebGL2Supported(canvas: HTMLCanvasElement): boolean {
  try {
    return typeof WebGL2RenderingContext !== 'undefined' && canvas.getContext('webgl2') !== null;
  } catch {
    return false;
  }
}
