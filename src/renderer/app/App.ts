/**
 * Renderer orchestrator: talks to the preload bridge, owns the frame loop and
 * wires input → emitters → simulation → render passes. Never throws out of
 * init(); failures are reported through `reportReady({ ok: false })`.
 */
import type {
  ActiveWindowEvent,
  CursorEvent,
  DisplayInfo,
  HostCapabilities,
  PointerButtonEvent,
  PrajealaApi,
  RendererReadyReport,
  Unsubscribe,
} from '../../shared/ipc';
import type { LicenseInfo } from '../../shared/license';
import {
  DEFAULT_SETTINGS,
  INTENSITY_PRESETS,
  normalizeSettings,
  type IntensityPreset,
  type Settings,
} from '../../shared/settings';
import { BUILTIN_THEMES, themePalette, themesEqual, type ThemeDefinition } from '../../shared/theme';
import { AudioReactor } from '../audio/AudioReactor';
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
}

export interface AppEnvironment {
  /** True when the API is the in-page mock (standalone browser). */
  mock: boolean;
}

const MAX_DT = 1 / 30;
const IDLE_INTERVAL_MS = 250;
const HUD_INTERVAL_MS = 250;

export class App {
  private settings: Settings = DEFAULT_SETTINGS;
  private preset: IntensityPreset = INTENSITY_PRESETS[DEFAULT_SETTINGS.intensity];
  /** Resolved theme (built-in palette flavour or an imported JSON theme). */
  private theme: ThemeDefinition = BUILTIN_THEMES[DEFAULT_SETTINGS.palette];
  /** True once the host pushed a theme; until then the palette setting picks a built-in. */
  private themeFromHost = false;
  private display: DisplayInfo | null = null;
  private caps: HostCapabilities | null = null;
  /** Read-only here (the main process already clamps the settings it sends); shown in the HUD. */
  private license: LicenseInfo | null = null;
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
  private audio: AudioReactor | null = null;
  private audioWanted: { source: Settings['audioSource'] } | null = null;

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
    try {
      // Older hosts have no getTheme: the palette setting then selects a built-in theme.
      if (typeof this.api.getTheme === 'function') this.applyTheme(await this.api.getTheme(), true);
    } catch (err) {
      this.log('debug', `theme unavailable, using the palette: ${describe(err)}`);
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
    // Licence is informational for the overlay; never block start-up on it.
    void Promise.resolve()
      .then(() => this.api.getLicense())
      .then((info) => {
        this.license = info;
      })
      .catch(() => undefined);

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
      renderer.setPalette(themePalette(this.theme));
      fireCursor = new FireCursor(device);
      const sparkRenderer = new SparkRenderer(device, this.sparks.capacity);
      this.gpu = { device, sim, renderer, fireCursor, sparkRenderer };
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
    this.updateSimSize();
    this.watchDpr();
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
    if (!this.themeFromHost && next.palette !== prev.palette) this.applyTheme(BUILTIN_THEMES[next.palette], false);
    if (next.simScale !== prev.simScale) this.updateSimSize();
    if (!next.sparks) this.sparks.clear();
    if (next.enabled && !prev.enabled) {
      this.clearedWhileDisabled = false;
      this.lastTickAt = 0;
      this.scheduleRaf();
    }
    this.syncAudio();
  }

  // ───────────────────────────── Sound reactivity ─────────────────────────────

  /** Starts/stops/re-sources the audio capture to match the settings. */
  private syncAudio(): void {
    const s = this.settings;
    const want = s.enabled && s.audioReactive ? { source: s.audioSource } : null;
    if (want) {
      if (!this.audio) {
        this.audio = new AudioReactor({
          simulate: this.options.audioSim,
          loopbackAvailable: this.caps?.audioLoopback ?? false,
          onStatus: (status) => {
            this.log(status.state === 'active' || status.state === 'off' ? 'info' : 'warn', `audio: ${status.state} (${status.source})${status.message ? ` — ${status.message}` : ''}`);
            try {
              this.api.reportAudioStatus(status);
            } catch {
              /* ignore */
            }
          },
        });
      }
      this.audio.setGain(s.audioGain);
      if (!this.audioWanted || this.audioWanted.source !== want.source) {
        this.audioWanted = want;
        void this.audio.start(want.source);
      }
    } else if (this.audio) {
      this.audioWanted = null;
      this.audio.stop();
      this.ctx.audio = this.audio.levels; // zeroed by stop()
    }
  }

  private updateAudio(dt: number): void {
    const a = this.audio;
    if (!a) return;
    const levels = a.update(dt);
    this.ctx.audio = levels;
    // A strong beat under the cursor: a small burst, so kicks are visible even when the mouse rests.
    if (levels.beatHit && levels.bass > 0.55 && this.cursor.hasPosition && this.cursor.inside) {
      this.burstEmitter.trigger(this.cursor.x, this.cursor.y, this.preset.burst * (0.25 + 0.35 * levels.bass), 'other');
    }
  }

  /** Applies a theme: palette LUT, look and simulation flavour. */
  private applyTheme(theme: ThemeDefinition, fromHost: boolean): void {
    if (fromHost) this.themeFromHost = true;
    if (themesEqual(theme, this.theme)) return;
    this.theme = theme;
    this.gpu?.renderer.setPalette(themePalette(theme));
    this.look.detail = theme.look.detail;
    this.look.glow = theme.look.glow;
    this.look.smoke = theme.look.smoke;
    this.look.smokeColor = theme.look.smokeColor;
    this.look.noiseSpeed = theme.look.noiseSpeed * (theme.sim.flow < 0 ? -1 : 1);
    this.ctx.flow = theme.sim.flow;
    this.refreshSimParams();
  }

  private refreshSimParams(): void {
    const p = this.preset;
    const s = this.simParams;
    const a = this.ctx.audio;
    const th = this.theme.sim;
    // Music lifts and twists the whole field a little: buoyancy follows the level, swirl the highs.
    const lift = a.active ? 1 + 0.45 * a.level + 0.3 * a.beat : 1;
    const swirl = a.active ? 1 + 0.5 * a.high : 1;
    // Flame lifetime ≈ 1 / cooling: low 0.25 s, medium 0.36 s, high 0.56 s, inferno 1 s.
    s.heatDissipation = clamp(1 - (1 - p.heatDissipation) * th.heatLoss, 0, 1);
    s.smokeDissipation = 0.4;
    // Presets express velocity retention generously; swirl should settle within a couple of seconds.
    s.velocityDissipation = clamp(1 - (1 - Math.pow(p.velocityDissipation, 8)) * th.velocityLoss, 0, 1);
    s.cooling = (1 - p.heatDissipation) * 35 * th.cooling;
    s.buoyancy = p.buoyancy * 1.1 * lift * th.buoyancy;
    s.curl = p.curl * 2 * swirl * th.curl;
    s.maxSpeed = (1.0 + p.buoyancy * 0.35) * lift * th.maxSpeed;
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
      api.onLicense((info) => {
        this.license = info;
      }),
    );
    if (typeof api.onTheme === 'function') this.unsubscribers.push(api.onTheme((theme) => this.applyTheme(theme, true)));
  }

  private handleCursor(e: CursorEvent): void {
    this.cursor.push(e);
    if (this.settings.enabled && this.gpu && !this.contextLost) this.cursorEmitter.onMove(e);
  }

  private handlePointerButton(e: PointerButtonEvent): void {
    if (e.type !== 'down' || !this.settings.clickBursts || !this.settings.enabled) return;
    if (!e.inside && !this.ctx.inView(e.x, e.y, this.ctx.radius * 6)) return;
    this.burstEmitter.trigger(e.x, e.y, this.preset.burst, e.button);
  }

  private handleTestBurst(p: { x: number; y: number; strength: number }): void {
    if (!this.settings.enabled) return;
    this.burstEmitter.trigger(p.x, p.y, Number.isFinite(p.strength) ? p.strength : this.preset.burst);
  }

  private handleActiveWindow(e: ActiveWindowEvent | null): void {
    this.windowEmitter.setTarget(e);
  }

  private handleDisplay(d: DisplayInfo): void {
    this.display = d;
    this.measure();
  }

  private handleCapabilities(c: HostCapabilities): void {
    this.caps = c;
    this.updateSmokeDriver();
    this.syncAudio();
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
    this.canvas.addEventListener('webglcontextlost', (e) => {
      e.preventDefault();
      this.contextLost = true;
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
    const idle = document.hidden || !this.settings.enabled || this.contextLost || !this.gpu;
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
    this.frames++;
    this.fpsCounter++;
    if (now - this.lastHudAt > HUD_INTERVAL_MS) {
      this.lastHudAt = now;
      this.updateHud();
    }
    this.scheduleRaf();
  };

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

  /** Disabled / hidden: clear everything once, then do nothing. */
  private idleFrame(): void {
    const g = this.gpu;
    if (!this.settings.enabled && !this.clearedWhileDisabled && g && !this.contextLost) {
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
    if (this.audio) {
      this.updateAudio(dt);
      this.refreshSimParams();
    }
    this.driveSynthetic();
    for (const e of this.emitters) e.update(this.ctx);
    if (this.settings.sparks) this.sparks.update(dt, this.cssWidth, this.cssHeight, this.time);
    g.sim.step(dt, this.simParams);
  }

  private render(): void {
    const g = this.gpu;
    if (!g) return;
    const s = this.settings;
    g.renderer.render(
      g.sim.temperatureTexture,
      g.sim.width,
      g.sim.height,
      this.canvas.width,
      this.canvas.height,
      this.time,
      this.look,
    );
    const c = this.cursor;
    if (s.cursorMode !== 'off' && c.hasPosition && c.inside) {
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
    if (s.sparks) {
      g.sparkRenderer.draw(this.sparks, this.cssWidth, this.cssHeight, this.dpr, this.theme.spark);
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
    if (s.audioReactive) {
      const a = this.ctx.audio;
      const st = this.audio?.currentStatus;
      active.push(
        `audio:${st?.state ?? 'off'}${a.active ? ` L${a.level.toFixed(2)} B${a.bass.toFixed(2)} M${a.mid.toFixed(2)} H${a.high.toFixed(2)}${a.bpm ? ` ${a.bpm}bpm` : ''}` : ''}`,
      );
    }
    const state =!s.enabled ? 'PAUSED' : this.contextLost ? 'CONTEXT LOST' : !g ? 'NO GPU' : document.hidden ? 'HIDDEN' : 'running';
    const lines = [
      `prăjeală ${state} · ${this.fps} fps (cap ${s.maxFps}) · frames ${this.frames}${this.env.mock ? ' · mock' : ''}`,
      `sim ${g?.sim.width ?? 0}×${g?.sim.height ?? 0} (scale ${s.simScale}, ${s.pressureIterations} it) · canvas ${this.canvas.width}×${this.canvas.height} @${this.dpr.toFixed(2)}x`,
      `gpu ${caps?.renderer ?? 'n/a'} · float ${caps?.floatTextures ? 'yes' : 'no'} · linear ${caps?.linearFiltering ? 'yes' : 'no'}`,
      `intensity ${s.intensity} · theme ${this.theme.id}${this.theme.basePalette && this.theme.id !== this.theme.basePalette ? ` (${this.theme.basePalette})` : ''} · tier ${this.license?.tier ?? '?'} · emitters ${active.join(' ') || 'none'}`,
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
    this.audio?.stop();
    this.audio = null;
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
