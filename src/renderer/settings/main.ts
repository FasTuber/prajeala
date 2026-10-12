/**
 * Settings / Prăjeală Pro window. Built once from the first UiState, then
 * every control is re-synced in place on each state push (so sliders and the
 * licence-key field keep working while main broadcasts changes).
 *
 * Opened directly in a browser (no preload) it runs against an in-page mock,
 * which is handy for UI work: `dist/renderer/settings.html?lang=ro&tier=free`.
 */
import {
  CURSOR_LABELS,
  INTENSITY_LABELS,
  QUALITY_LABELS,
  QUALITY_PRESETS,
  paletteLabel,
  translator,
  type StringKey,
  type Translate,
} from '../../shared/i18n';
import { FOCUS_PRESETS_MIN, clampFocusMinutes, formatClock } from '../../shared/focus';
import type { PrajealaUiApi, UiFocus, UiState } from '../../shared/ipc';
import type { LicenseActionResult } from '../../shared/license';
import { resolvePalette, type PaletteDefinition } from '../../shared/palettes';
import { isIntensityLocked, isPaletteLocked } from '../../shared/pro';
import { SCENES, SCENE_EMOJI, activeScene, sceneNeedsPro, scenePatch, seasonAt, type Scene } from '../../shared/scenes';
import { CURSOR_MODES, INTENSITIES, PALETTES, SETTINGS_LIMITS, type Settings } from '../../shared/settings';
import { createMockUiApi } from './mock';

type Sync = (state: UiState) => void;
type Child = Node | string | null | undefined | false;

function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: { class?: string; text?: string; attrs?: Record<string, string>; on?: Record<string, (e: Event) => void> } = {},
  children: Child[] = [],
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (props.class) el.className = props.class;
  if (props.text !== undefined) el.textContent = props.text;
  for (const [k, v] of Object.entries(props.attrs ?? {})) el.setAttribute(k, v);
  for (const [k, fn] of Object.entries(props.on ?? {})) el.addEventListener(k, fn);
  for (const c of children) if (c !== null && c !== undefined && c !== false) el.append(c);
  return el;
}

function paletteGradient(def: PaletteDefinition): string {
  // Skip the transparent-black cold end so the swatch shows the flame colours.
  const stops = def.stops.filter(([t]) => t >= 0.12);
  const span = 1 - (stops[0]?.[0] ?? 0);
  const css = stops.map(([t, r, g, b]) => {
    const pos = span > 0 ? ((t - (stops[0]?.[0] ?? 0)) / span) * 100 : 0;
    return `rgb(${Math.round(r * 255)} ${Math.round(g * 255)} ${Math.round(b * 255)}) ${pos.toFixed(1)}%`;
  });
  return `linear-gradient(90deg, ${css.join(', ')})`;
}

class SettingsPage {
  private state: UiState;
  private readonly t: Translate;
  private readonly syncs: Sync[] = [];
  private proCard!: HTMLElement;
  private proHint!: HTMLElement;
  private welcome!: HTMLElement;
  private keyInput!: HTMLInputElement;
  private message!: HTMLElement;
  private busy = false;

  constructor(
    private readonly api: PrajealaUiApi,
    initial: UiState,
    private readonly root: HTMLElement,
  ) {
    this.state = initial;
    this.t = translator(initial.lang);
    document.documentElement.lang = initial.lang;
    this.build();
    this.sync(initial);
  }

  sync(state: UiState): void {
    this.state = state;
    for (const s of this.syncs) s(state);
  }

  focus(focus: UiFocus): void {
    if (focus === 'welcome') {
      this.welcome.hidden = false;
      this.welcome.scrollIntoView({ block: 'start' });
    } else if (focus === 'pro') {
      this.flashPro();
    }
  }

  // ───────────────────────────── layout ─────────────────────────────

  private build(): void {
    const t = this.t;
    this.root.replaceChildren(
      this.header(),
      this.welcomeCard(),
      this.seasonCard(),
      this.proSection(),
      this.card(t('sectionFire'), [
        this.labeled(t('scenes'), this.sceneControl()),
        this.toggleRow('enabled', t('fireOn'), null, () => true),
        this.labeled(t('intensity'), this.intensityControl()),
        this.labeled(t('palette'), this.paletteControl()),
        this.labeled(t('cursorFire'), this.cursorControl()),
        this.toggleRow('clickBursts', t('clickBursts'), t('clickBurstsUnavailable'), (s) => s.capabilities.globalClicks),
        this.toggleRow('burnActiveWindow', t('burnActiveWindow'), t('burnActiveWindowUnavailable'), (s) => s.capabilities.activeWindow),
        this.toggleRow('screenBottomFire', t('screenBottomFire'), null, () => true),
        this.toggleRow('sparks', t('sparks'), null, () => true),
        this.typingRow(),
        this.torchRow(),
        h('div', {}, [h('button', { class: 'btn', text: `🔥 ${t('testBurst')}`, on: { click: () => this.api.testBurst() } })]),
      ]),
      this.focusCard(),
      this.card(t('sectionAudio'), [
        h('p', { class: 'small muted', text: t('audioDesc') }),
        this.labeled(t('audioSource'), this.audioSourceControl()),
        this.labeled(t('audioStyle'), this.audioStyleControl()),
        this.toggleRow('audioDrops', t('audioDrops'), null, () => true),
        this.sensitivityRow(),
        this.audioMeter(),
        h('p', { class: 'small muted', text: `🔒 ${t('audioPrivacy')}` }),
      ]),
      this.card(t('sectionBurn'), [
        h('p', { class: 'small muted', text: t('burnDesc') }),
        h('div', { class: 'seg' }, [
          h('button', { class: 'btn primary', text: `🔥 ${t('burnScreen')}`, on: { click: () => this.api.burn('screen') } }),
          this.burnWindowButton(),
          h('button', { class: 'btn', text: t('burnImage'), on: { click: () => this.api.burn('image') } }),
        ]),
        h('p', { class: 'small muted' }, [h('kbd', { text: `${this.state.platform === 'darwin' ? '⌘' : 'Ctrl'}+Alt+Shift+F` })]),
      ]),
      this.card(t('sectionPower'), [
        this.powerStatus(),
        this.toggleRow('idleSleep', t('idleSleep'), null, () => true, t('idleSleepNote')),
        this.labeled(t('idleAfter'), this.idleAfterControl()),
        this.labeled(t('batteryMode'), this.batteryControl()),
        this.toggleRow('gameMode', t('gameMode'), null, (s) => s.capabilities.activeWindow, t('gameModeNote')),
        this.toggleRow('fireOverTaskbar', t('fireOverTaskbar'), null, () => true, t('fireOverTaskbarNote')),
      ]),
      this.card(t('sectionPerformance'), [
        this.labeled(t('quality'), this.qualityControl()),
        this.labeled(t('fps'), this.fpsControl()),
        this.rangeRow('pressureIterations', t('pressureIterations'), t('lowerIsFaster')),
      ]),
      this.card(t('sectionSystem'), [
        this.toggleRow('launchAtLogin', t('launchAtLogin'), t('linuxNoLogin'), (s) => s.platform !== 'linux'),
        this.toggleRow('showDebugHud', t('debugHud'), null, () => true),
        this.shortcuts(),
        h('div', {}, [h('button', { class: 'btn', text: t('openSettingsFile'), on: { click: () => this.api.openSettingsFile() } })]),
      ]),
      this.footer(),
    );
  }

  private header(): HTMLElement {
    const badge = h('span', { class: 'badge' });
    this.syncs.push((s) => {
      const tier = s.license.tier;
      badge.className = `badge ${tier}`;
      badge.textContent =
        tier === 'pro' ? `★ ${this.t('tierPro')}` : tier === 'trial' ? this.t('tierTrial', { days: s.license.trialDaysLeft }) : this.t('tierFree');
    });
    return h('header', { class: 'top' }, [
      h('img', { attrs: { src: '../../assets/icon-256.png', alt: '' } }),
      h('div', { class: 'grow' }, [h('h1', { text: 'Prăjeală' }), h('p', { class: 'tagline', text: this.t('tagline') })]),
      badge,
    ]);
  }

  private welcomeCard(): HTMLElement {
    const t = this.t;
    const trial = h('p', { class: 'small' });
    this.syncs.push((s) => {
      trial.textContent = s.license.tier === 'trial' ? `✨ ${t('welcomeTrial', { days: s.license.trialDaysLeft })}` : '';
      trial.hidden = s.license.tier !== 'trial';
    });
    this.welcome = h('section', { class: 'card welcome', attrs: { hidden: '' } }, [
      h('h3', { text: `🔥 ${t('welcomeTitle')}` }),
      h('p', { class: 'muted', text: t('welcomeBody') }),
      trial,
      h('div', {}, [
        h('button', {
          class: 'btn primary',
          text: t('gotIt'),
          on: {
            click: () => {
              this.welcome.hidden = true;
            },
          },
        }),
      ]),
    ]);
    return this.welcome;
  }

  private proSection(): HTMLElement {
    const t = this.t;
    const price = this.state.product.priceLabel;
    this.proHint = h('p', { class: 'message warn' });
    this.message = h('p', { class: 'message' });
    const notice = h('p', { class: 'message warn' });

    // ── upsell (free / trial) ──
    const trialLine = h('p', { class: 'small' });
    this.keyInput = h('input', {
      attrs: { type: 'text', spellcheck: 'false', autocomplete: 'off', placeholder: t('keyPlaceholder'), 'aria-label': t('keyPlaceholder') },
      on: {
        keydown: (e) => {
          if ((e as KeyboardEvent).key === 'Enter') void this.activate();
        },
      },
    });
    const activateBtn = h('button', { class: 'btn', text: t('activate'), on: { click: () => void this.activate() } });
    const upsell = h('div', { class: 'stack' }, [
      h('div', { class: 'pro-head' }, [h('h3', { text: `🔥 ${this.state.product.name}` }), h('span', { class: 'price', text: t('proPrice', { price }) })]),
      h('p', { class: 'muted', text: t('proPitch') }),
      h('ul', { class: 'features' }, [
        h('li', { text: t('proFeaturePalettes', { count: PALETTES.length }) }),
        h('li', { text: t('proFeatureInferno') }),
        h('li', { text: t('proFeatureTorch') }),
        h('li', { text: t('proFeatureEq') }),
        h('li', { text: t('proFeatureMonitors') }),
        h('li', { text: t('proFeatureSupport') }),
      ]),
      trialLine,
      h('button', { class: 'btn primary big', text: t('buyPro', { price }), on: { click: () => this.api.openLink('buy') } }),
      h('p', { class: 'small muted', text: t('haveKey') }),
      h('div', { class: 'key-form' }, [this.keyInput, activateBtn]),
    ]);

    // ── active licence ──
    const who = h('p', { class: 'small muted' });
    const keyLine = h('p', { class: 'small muted' });
    const manageBtn = h('button', { class: 'btn', text: t('manageOrder'), on: { click: () => this.api.openLink('manage') } });
    const deactivateBtn = h('button', { class: 'btn', text: t('deactivate'), on: { click: () => void this.deactivate() } });
    const owned = h('div', { class: 'stack' }, [
      h('div', { class: 'pro-head' }, [h('h3', { text: `★ ${t('proActive')}` })]),
      who,
      keyLine,
      h('div', { class: 'seg' }, [deactivateBtn, manageBtn]),
    ]);

    this.syncs.push((s) => {
      const lic = s.license;
      const licensed = lic.tier === 'pro' && lic.source !== null;
      upsell.hidden = licensed;
      owned.hidden = !licensed;
      trialLine.textContent = lic.tier === 'trial' ? `⏳ ${t('trialActive', { days: lic.trialDaysLeft })}` : lic.trialEndsAt ? t('trialOver') : '';
      trialLine.className = lic.tier === 'trial' ? 'small' : 'small muted';
      who.textContent = lic.licensee ? t('licensedTo', { name: lic.licensee }) : '';
      who.hidden = !lic.licensee;
      keyLine.textContent = `${t('licenseKey', { key: lic.keyHint })}${lic.source === 'offline' ? ` · ${t('offlineKey')}` : ''}`;
      manageBtn.hidden = lic.source !== 'store';
      notice.textContent = lic.notice;
      activateBtn.disabled = this.busy;
      deactivateBtn.disabled = this.busy;
      // Free install with several monitors: say why only one burns.
      if (lic.pro) this.proHint.textContent = '';
      else if (s.displays > 1 && !this.proHint.textContent) {
        this.proHint.textContent = t('lockedHint', { feature: t('lockedMonitors', { count: s.displays }) });
      }
    });

    this.proCard = h('section', { class: 'card pro', attrs: { id: 'pro' } }, [notice, upsell, owned, this.proHint, this.message]);
    return this.proCard;
  }

  private card(title: string, rows: Child[]): HTMLElement {
    return h('section', { class: 'card' }, [h('h2', { text: title }), ...rows]);
  }

  private labeled(label: string, control: HTMLElement): HTMLElement {
    return h('div', { class: 'stack' }, [h('div', { class: 'small muted', text: label }), control]);
  }

  // ───────────────────────────── controls ─────────────────────────────

  private toggleRow(
    key:
      | 'enabled'
      | 'clickBursts'
      | 'burnActiveWindow'
      | 'screenBottomFire'
      | 'sparks'
      | 'launchAtLogin'
      | 'showDebugHud'
      | 'idleSleep'
      | 'gameMode'
      | 'fireOverTaskbar'
      | 'audioDrops',
    label: string,
    unavailableNote: string | null,
    available: (s: UiState) => boolean,
    note = '',
  ): HTMLElement {
    const input = h('input', {
      attrs: { type: 'checkbox', role: 'switch', 'aria-label': label },
      on: { change: () => void this.update({ [key]: input.checked }) },
    });
    const noteEl = h('span', { class: 'note' });
    this.syncs.push((s) => {
      input.checked = s.settings[key];
      const ok = available(s);
      input.disabled = !ok;
      noteEl.textContent = ok || !unavailableNote ? note : unavailableNote;
      noteEl.hidden = !noteEl.textContent;
    });
    return h('label', { class: 'row' }, [h('span', { class: 'label' }, [h('span', { text: label }), noteEl]), h('span', { class: 'switch' }, [input, h('span')])]);
  }

  private audioSourceControl(): HTMLElement {
    const t = this.t;
    const labels = { off: t('audioOff'), system: t('audioSystem'), mic: t('audioMic') } as const;
    return this.segmented(
      ['off', 'system', 'mic'] as const,
      (v) => labels[v],
      (s) => s.settings.audioSource,
      () => false,
      (v) => void this.update({ audioSource: v }),
      () => undefined,
    );
  }

  private audioStyleControl(): HTMLElement {
    const t = this.t;
    const labels = { pulse: t('audioPulse'), eq: t('audioEq') } as const;
    return this.segmented(
      ['pulse', 'eq'] as const,
      (v) => labels[v],
      (s) => s.effective.audioStyle,
      (v, s) => v === 'eq' && !s.license.pro,
      (v) => void this.update({ audioStyle: v }),
      () => this.showLocked(t('lockedEq')),
      (v) => v === 'eq',
    );
  }

  private sensitivityRow(): HTMLElement {
    const value = h('span', { class: 'value' });
    const input = h('input', {
      attrs: { type: 'range', min: '0', max: '100', step: '5', 'aria-label': this.t('audioSensitivity') },
      on: {
        input: () => {
          value.textContent = `${input.value}%`;
        },
        change: () => void this.update({ audioSensitivity: Number(input.value) / 100 }),
      },
    });
    this.syncs.push((s) => {
      const pct = Math.round(s.settings.audioSensitivity * 100);
      if (document.activeElement !== input) input.value = String(pct);
      value.textContent = `${pct}%`;
    });
    return h('div', { class: 'row' }, [h('span', { class: 'label' }, [h('span', { text: this.t('audioSensitivity') })]), h('span', { class: 'seg' }, [input, value])]);
  }

  /** 32-bar live meter + capture status (proof that the app hears something). */
  private audioMeter(): HTMLElement {
    const t = this.t;
    const canvas = h('canvas', { class: 'meter', attrs: { width: '320', height: '40', 'aria-hidden': 'true' } });
    const status = h('p', { class: 'small' });
    let bands: number[] = [];
    const draw = (): void => {
      const g = canvas.getContext('2d');
      if (!g) return;
      g.clearRect(0, 0, canvas.width, canvas.height);
      const n = 32;
      const w = canvas.width / n;
      for (let i = 0; i < n; i++) {
        const v = Math.max(0.03, Math.min(1, bands[i] ?? 0));
        const bh = v * canvas.height;
        const grad = g.createLinearGradient(0, canvas.height, 0, 0);
        grad.addColorStop(0, '#ff5a1f');
        grad.addColorStop(1, '#ffc24a');
        g.fillStyle = grad;
        g.fillRect(i * w + 1, canvas.height - bh, w - 2, bh);
      }
    };
    this.api.onAudioLevel((l) => {
      bands = l.bands;
      draw();
    });
    this.syncs.push((s) => {
      const a = s.audio;
      const source = a.source === 'mic' ? t('audioMic') : t('audioSystem');
      const text: Record<string, string> = {
        off: t('audioStatusOff'),
        starting: t('audioStatusStarting'),
        ok: t('audioStatusOk', { source }),
        silent: t('audioStatusSilent'),
        unsupported: a.source === 'mic' ? t('audioStatusNoMic') : t('audioStatusUnsupported'),
        denied: t('audioStatusDenied'),
        error: t('audioStatusError', { detail: a.detail ?? '' }),
      };
      status.textContent = text[a.status] ?? '';
      status.className = `small ${a.status === 'ok' ? '' : a.status === 'off' || a.status === 'starting' || a.status === 'silent' ? 'muted' : 'message err'}`.trim();
      canvas.hidden = s.settings.audioSource === 'off';
      if (canvas.hidden) {
        bands = [];
        draw();
      }
    });
    draw();
    return h('div', { class: 'stack' }, [canvas, status]);
  }

  private burnWindowButton(): HTMLElement {
    const b = h('button', { class: 'btn', text: this.t('burnWindow'), on: { click: () => this.api.burn('window') } });
    this.syncs.push((s) => {
      b.toggleAttribute('disabled', !s.capabilities.activeWindow);
    });
    return b;
  }

  /** Termen limită: presets, a custom length, the live clock and the controls. */
  private focusCard(): HTMLElement {
    const t = this.t;
    const clock = h('div', { class: 'focus-clock', attrs: { 'aria-live': 'polite' } });
    const status = h('p', { class: 'small muted' });
    const custom = h('input', {
      class: 'num',
      attrs: { type: 'number', min: '1', max: '180', step: '1', 'aria-label': t('focusCustom') },
      on: {
        change: () => {
          const minutes = clampFocusMinutes(custom.value, this.state.settings.focusMinutes);
          custom.value = String(minutes); // a cleared or junk entry snaps back
          void this.update({ focusMinutes: minutes });
        },
      },
    });
    const start = h('button', {
      class: 'btn primary',
      text: `🔥 ${t('focusStart')}`,
      // Read the field itself: its change event may still be on its way to main.
      on: { click: () => this.api.focusAction({ type: 'start', minutes: clampFocusMinutes(custom.value, this.state.settings.focusMinutes) }) },
    });
    const pause = h('button', {
      class: 'btn',
      on: { click: () => this.api.focusAction({ type: this.state.focus.phase === 'paused' ? 'resume' : 'pause' }) },
    });
    const stop = h('button', { class: 'btn', text: t('focusStop'), on: { click: () => this.api.focusAction({ type: 'cancel' }) } });

    // main pushes the state every few seconds; the clock ticks locally in between.
    let receivedAt = performance.now();
    const paint = (): void => {
      const f = this.state.focus;
      const remaining = f.phase === 'running' ? Math.max(0, f.remainingMs - (performance.now() - receivedAt)) : f.remainingMs;
      const active = f.phase === 'running' || f.phase === 'paused';
      clock.textContent = active ? formatClock(remaining) : f.phase === 'blaze' ? '🔥 0:00' : formatClock(this.state.settings.focusMinutes * 60_000);
      clock.classList.toggle('live', active);
      status.textContent =
        f.phase === 'running'
          ? t('focusRunning', { time: formatClock(remaining) })
          : f.phase === 'paused'
            ? t('focusPaused', { time: formatClock(remaining) })
            : f.phase === 'blaze'
              ? t('focusBlaze')
              : t('focusIdle');
    };
    this.syncs.push((s) => {
      receivedAt = performance.now();
      const active = s.focus.phase === 'running' || s.focus.phase === 'paused';
      start.hidden = active;
      start.disabled = s.focus.phase === 'blaze';
      pause.hidden = !active;
      stop.hidden = !active;
      pause.textContent = s.focus.phase === 'paused' ? t('focusResume') : t('focusPause');
      if (document.activeElement !== custom) custom.value = String(s.settings.focusMinutes);
      paint();
    });
    window.setInterval(paint, 500);

    const presets = this.segmented(
      FOCUS_PRESETS_MIN,
      (v) => t('focusMinutes', { n: v }),
      (s) => FOCUS_PRESETS_MIN.find((v) => v === s.settings.focusMinutes) ?? null,
      () => false,
      (v) => void this.update({ focusMinutes: v }),
      () => undefined,
    );
    return this.card(`⏳ ${t('sectionFocus')}`, [
      h('p', { class: 'small muted', text: t('focusDesc') }),
      clock,
      h('div', { class: 'focus-row' }, [presets, h('label', { class: 'small muted focus-custom' }, [t('focusCustom'), custom])]),
      h('div', { class: 'seg' }, [start, pause, stop]),
      status,
    ]);
  }

  private powerStatus(): HTMLElement {
    const el = h('p', { class: 'small' });
    this.syncs.push((s) => {
      const p = s.power;
      const t = this.t;
      const main =
        p.reason === 'locked' ? t('powerLocked') : p.reason === 'battery' ? t('powerBattery') : p.sleeping ? t('powerSleeping') : t('powerAwake');
      const extra = [p.eco ? t('powerEco') : '', p.gameDisplays > 0 ? t('powerGame', { n: p.gameDisplays }) : ''].filter(Boolean);
      el.textContent = `${p.sleeping || p.paused ? '💤' : '🔥'} ${main}${extra.length ? ` · ${extra.join(' · ')}` : ''}`;
    });
    return el;
  }

  private idleAfterControl(): HTMLElement {
    const choices = [60, 120, 300, 600] as const;
    return this.segmented(
      choices,
      (v) => this.t('minutesShort', { n: v / 60 }),
      (s) => choices.find((v) => v === s.settings.idleSleepSeconds) ?? null,
      () => false,
      (v) => void this.update({ idleSleepSeconds: v }),
      () => undefined,
    );
  }

  private batteryControl(): HTMLElement {
    const t = this.t;
    const labels = { normal: t('batteryNormal'), eco: t('batteryEco'), pause: t('batteryPause') } as const;
    return this.segmented(
      ['normal', 'eco', 'pause'] as const,
      (v) => labels[v],
      (s) => s.settings.batteryMode,
      () => false,
      (v) => void this.update({ batteryMode: v }),
      () => undefined,
    );
  }

  private sceneLabel(scene: Scene): string {
    const key = `scene${scene[0]!.toUpperCase()}${scene.slice(1)}`;
    return this.t(key as StringKey);
  }

  /** One click sets a whole mood; Pro scenes ask for Pro instead of half-applying. */
  private sceneControl(): HTMLElement {
    return this.segmented(
      SCENES,
      (v) => `${SCENE_EMOJI[v]} ${this.sceneLabel(v)}`,
      (s) => activeScene(s.effective),
      (v, s) => sceneNeedsPro(v) && !s.license.pro,
      (v) => void this.update(scenePatch(v, this.state.license.pro)),
      (v) => this.showLocked(`${this.t('lockedScene')} (${this.sceneLabel(v)})`),
      (v) => sceneNeedsPro(v),
    );
  }

  /** A seasonal suggestion (Sumedru, Halloween, winter) — hidden the rest of the year. */
  private seasonCard(): HTMLElement {
    const t = this.t;
    const override = new URLSearchParams(location.search).get('today');
    const today = override ? new Date(`${override}T12:00:00`) : new Date();
    const season = seasonAt(Number.isNaN(today.getTime()) ? new Date() : today);
    const card = h('section', { class: 'card season', attrs: { hidden: '' } });
    if (!season) return card;
    const text = season.event === 'sumedru' ? t('seasonSumedru') : season.event === 'halloween' ? t('seasonHalloween') : t('seasonWinter');
    const emoji = season.event === 'halloween' ? '🎃' : season.event === 'sumedru' ? '🍂' : '❄️';
    const scene = season.scene;
    const btn = h('button', {
      class: 'btn primary',
      on: {
        click: () => {
          if (sceneNeedsPro(scene) && !this.state.license.pro) this.showLocked(`${t('lockedScene')} (${this.sceneLabel(scene)})`);
          else void this.update(scenePatch(scene, this.state.license.pro));
        },
      },
    });
    this.syncs.push((s) => {
      card.hidden = activeScene(s.effective) === scene;
      btn.replaceChildren(`${SCENE_EMOJI[scene]} ${t('seasonTry', { scene: this.sceneLabel(scene) })}`, ...(sceneNeedsPro(scene) && s.license.tier !== 'pro' ? [h('span', { class: 'lock', text: 'PRO' })] : []));
    });
    card.append(h('p', { text: `${emoji} ${text}` }), h('div', {}, [btn]));
    return card;
  }

  /** Mod Torță: Pro-only toggle. */
  private torchRow(): HTMLElement {
    const t = this.t;
    const input = h('input', { attrs: { type: 'checkbox', role: 'switch', 'aria-label': t('torch') } });
    input.addEventListener('change', () => {
      if (!this.state.license.pro) {
        input.checked = false;
        this.showLocked(t('lockedTorch'));
        return;
      }
      void this.update({ torch: input.checked });
    });
    const lock = h('span', { class: 'lock', text: 'PRO' });
    this.syncs.push((s) => {
      input.checked = s.license.pro && s.settings.torch;
      lock.hidden = s.license.tier === 'pro';
    });
    return h('label', { class: 'row' }, [
      h('span', { class: 'label' }, [h('span', {}, [`🔦 ${t('torch')}`, lock]), h('span', { class: 'note', text: t('torchNote') })]),
      h('span', { class: 'switch' }, [input, h('span')]),
    ]);
  }

  /** Typing fire: Pro-only toggle (the switch shows the lock instead of flipping without Pro). */
  private typingRow(): HTMLElement {
    const t = this.t;
    const input = h('input', { attrs: { type: 'checkbox', role: 'switch', 'aria-label': t('typingFire') } });
    input.addEventListener('change', () => {
      if (!this.state.license.pro) {
        input.checked = false;
        this.showLocked(t('lockedTyping'));
        return;
      }
      void this.update({ typingFire: input.checked });
    });
    const lock = h('span', { class: 'lock', text: 'PRO' });
    this.syncs.push((s) => {
      input.checked = s.license.pro && s.settings.typingFire;
      input.disabled = !s.capabilities.globalClicks;
      lock.hidden = s.license.tier === 'pro';
    });
    return h('label', { class: 'row' }, [
      h('span', { class: 'label' }, [h('span', {}, [t('typingFire'), lock]), h('span', { class: 'note', text: t('typingFireNote') })]),
      h('span', { class: 'switch' }, [input, h('span')]),
    ]);
  }

  private segmented<T extends string | number>(
    values: readonly T[],
    label: (v: T) => string,
    selected: (s: UiState) => T | null,
    locked: (v: T, s: UiState) => boolean,
    pick: (v: T) => void,
    onLocked: (v: T) => void,
    /** Pro-only value: tagged “PRO” until a licence is active (also during the trial). */
    proOnly: (v: T) => boolean = () => false,
  ): HTMLElement {
    const buttons = values.map((v) => {
      const b = h('button', { attrs: { type: 'button' } });
      b.addEventListener('click', () => (locked(v, this.state) ? onLocked(v) : pick(v)));
      return b;
    });
    this.syncs.push((s) => {
      const current = selected(s);
      values.forEach((v, i) => {
        const b = buttons[i]!;
        const isLocked = locked(v, s);
        b.className = `${current === v ? 'on' : ''} ${isLocked ? 'locked' : ''}`.trim();
        b.setAttribute('aria-pressed', String(current === v));
        const tagged = isLocked || (proOnly(v) && s.license.tier !== 'pro');
        b.replaceChildren(label(v), ...(tagged ? [h('span', { class: 'lock', text: 'PRO' })] : []));
      });
    });
    return h('div', { class: 'seg' }, buttons);
  }

  private intensityControl(): HTMLElement {
    const lang = this.state.lang;
    return this.segmented(
      INTENSITIES,
      (v) => INTENSITY_LABELS[lang][v],
      (s) => s.effective.intensity,
      (v, s) => isIntensityLocked(v, s.license.pro),
      (v) => void this.update({ intensity: v }),
      () => this.showLocked(this.t('lockedInferno')),
      (v) => isIntensityLocked(v, false),
    );
  }

  private cursorControl(): HTMLElement {
    const lang = this.state.lang;
    return this.segmented(
      CURSOR_MODES,
      (v) => CURSOR_LABELS[lang][v],
      (s) => s.settings.cursorMode,
      () => false,
      (v) => void this.update({ cursorMode: v }),
      () => undefined,
    );
  }

  private qualityControl(): HTMLElement {
    const lang = this.state.lang;
    const keys = QUALITY_PRESETS.map((q) => q.key);
    return this.segmented(
      keys,
      (k) => QUALITY_LABELS[lang][k],
      (s) => QUALITY_PRESETS.find((q) => Math.abs(q.simScale - s.settings.simScale) < 1e-6)?.key ?? null,
      () => false,
      (k) => void this.update({ simScale: QUALITY_PRESETS.find((q) => q.key === k)?.simScale }),
      () => undefined,
    );
  }

  private fpsControl(): HTMLElement {
    return this.segmented(
      [30, 60, 120, 144] as const,
      (v) => String(v),
      (s) => ([30, 60, 120, 144] as const).find((v) => v === s.settings.maxFps) ?? null,
      () => false,
      (v) => void this.update({ maxFps: v }),
      () => undefined,
    );
  }

  private paletteControl(): HTMLElement {
    const fallback = h('p', { class: 'small muted' });
    const swatches = PALETTES.map((name) => {
      const bar = h('span', { class: 'bar', attrs: { style: `background:${paletteGradient(resolvePalette(name, this.state.settings.customColors))}` } });
      const lock = h('span', { class: 'lock', text: 'PRO' });
      const el = h(
        'button',
        {
          class: 'swatch',
          attrs: { type: 'button', title: paletteLabel(this.state.lang, name) },
          on: {
            click: () => {
              if (isPaletteLocked(name, this.state.license.pro)) {
                this.showLocked(this.t('lockedPalette', { name: paletteLabel(this.state.lang, name) }));
              } else {
                void this.update({ palette: name });
              }
            },
          },
        },
        [bar, h('span', {}, [paletteLabel(this.state.lang, name), lock])],
      );
      return { name, el, lock, bar };
    });
    const pickers = [0, 1, 2].map((i) =>
      h('input', {
        attrs: { type: 'color', 'aria-label': `${this.t('customColors')} ${i + 1}` },
        on: {
          change: () => {
            const colors = [...this.state.settings.customColors] as [string, string, string];
            colors[i] = pickers[i]!.value;
            void this.update({ customColors: colors });
          },
        },
      }),
    );
    const customRow = h('div', { class: 'row' }, [h('span', { class: 'small muted', text: this.t('customColors') }), h('span', { class: 'seg' }, pickers)]);
    this.syncs.push((s) => {
      for (const sw of swatches) {
        const isLocked = isPaletteLocked(sw.name, s.license.pro);
        sw.el.classList.toggle('on', s.effective.palette === sw.name);
        sw.el.classList.toggle('locked', isLocked);
        sw.el.setAttribute('aria-pressed', String(s.effective.palette === sw.name));
        sw.lock.hidden = !isPaletteLocked(sw.name, false) || s.license.tier === 'pro';
      }
      const custom = swatches.find((sw) => sw.name === 'custom');
      if (custom) custom.bar.style.background = paletteGradient(resolvePalette('custom', s.settings.customColors));
      pickers.forEach((p, i) => {
        if (document.activeElement !== p) p.value = s.settings.customColors[i] ?? '#ffffff';
      });
      customRow.hidden = !(s.license.pro && s.settings.palette === 'custom');
      const wanted = s.settings.palette;
      fallback.hidden = wanted === s.effective.palette;
      fallback.textContent = fallback.hidden ? '' : this.t('usingFallback', { name: paletteLabel(s.lang, s.effective.palette) });
    });
    return h('div', { class: 'stack' }, [h('div', { class: 'palettes' }, swatches.map((s) => s.el)), customRow, fallback]);
  }

  private rangeRow(key: 'pressureIterations', label: string, note: string): HTMLElement {
    const limits = SETTINGS_LIMITS[key];
    const value = h('span', { class: 'value' });
    const input = h('input', {
      attrs: { type: 'range', min: String(limits.min), max: String(limits.max), step: '1', 'aria-label': label },
      on: {
        input: () => {
          value.textContent = input.value;
        },
        // `change` fires on release: no settings round-trip while dragging.
        change: () => void this.update({ [key]: Number(input.value) }),
      },
    });
    this.syncs.push((s) => {
      if (document.activeElement !== input) input.value = String(s.settings[key]);
      value.textContent = String(s.settings[key]);
    });
    return h('div', { class: 'row' }, [
      h('span', { class: 'label' }, [h('span', { text: label }), h('span', { class: 'note', text: note })]),
      h('span', { class: 'seg' }, [input, value]),
    ]);
  }

  private shortcuts(): HTMLElement {
    const mod = this.state.platform === 'darwin' ? '⌘' : 'Ctrl';
    const t = this.t;
    const rows: Array<[string, string]> = [
      [`${mod}+Shift+F`, `${t('pause')} / ${t('resume')}`],
      [`${mod}+Shift+↑ / ↓`, t('intensity')],
      [`${mod}+Shift+B`, t('testBurst')],
      [`${mod}+Shift+Q`, t('quit')],
    ];
    return h('div', { class: 'stack' }, [
      h('div', { class: 'small muted', text: t('shortcuts') }),
      h(
        'div',
        { class: 'shortcuts' },
        rows.flatMap(([k, v]) => [h('span', {}, [h('kbd', { text: k })]), h('span', { text: v })]),
      ),
    ]);
  }

  private footer(): HTMLElement {
    const t = this.t;
    const version = h('span');
    const sponsor = h('button', { class: 'btn link', text: `♥ ${t('supportProject')}`, on: { click: () => this.api.openLink('sponsor') } });
    this.syncs.push((s) => {
      version.textContent = `v${s.version}`;
      sponsor.hidden = !s.product.hasSponsor;
    });
    return h('footer', {}, [
      h('button', { class: 'btn link', text: t('website'), on: { click: () => this.api.openLink('website') } }),
      h('button', { class: 'btn link', text: t('sourceCode'), on: { click: () => this.api.openLink('repo') } }),
      sponsor,
      version,
    ]);
  }

  // ───────────────────────────── actions ─────────────────────────────

  private async update(patch: Partial<Settings>): Promise<void> {
    try {
      this.sync(await this.api.updateSettings(patch));
    } catch (err) {
      console.error('[prajeala] update failed', err);
    }
  }

  private showLocked(feature: string): void {
    this.proHint.textContent = this.t('lockedHint', { feature });
    this.flashPro();
  }

  private flashPro(): void {
    this.proCard.scrollIntoView({ behavior: 'smooth', block: 'start' });
    this.proCard.classList.remove('flash');
    void this.proCard.offsetWidth; // restart the animation
    this.proCard.classList.add('flash');
    if (!this.state.license.pro || this.state.license.tier === 'trial') this.keyInput.focus({ preventScroll: true });
  }

  private async activate(): Promise<void> {
    if (this.busy) return;
    await this.licenceAction(() => this.api.activate(this.keyInput.value), 'activating');
  }

  private async deactivate(): Promise<void> {
    if (this.busy) return;
    await this.licenceAction(() => this.api.deactivate(), 'deactivating');
  }

  private async licenceAction(run: () => Promise<LicenseActionResult>, pending: StringKey): Promise<void> {
    this.busy = true;
    this.setMessage(this.t(pending), '');
    this.sync(this.state);
    try {
      const res = await run();
      const known = `code.${res.code}` as StringKey;
      this.setMessage(this.t(known) !== known ? this.t(known) : res.message, res.ok ? 'ok' : 'err');
      if (res.ok) {
        this.keyInput.value = '';
        this.proHint.textContent = '';
      }
      this.busy = false;
      this.sync({ ...this.state, license: res.status });
      // Main pushes the full state (effective settings etc.) right after.
    } catch (err) {
      this.busy = false;
      this.setMessage(this.t('code.error'), 'err');
      this.sync(this.state);
      console.error('[prajeala] licence action failed', err);
    }
  }

  private setMessage(text: string, kind: '' | 'ok' | 'err'): void {
    this.message.textContent = text;
    this.message.className = `message ${kind}`.trim();
  }
}

async function boot(): Promise<void> {
  const root = document.getElementById('app');
  if (!root) return;
  const bridge: unknown = (window as { prajealaUi?: unknown }).prajealaUi;
  const hasBridge = typeof bridge === 'object' && bridge !== null;
  const api: PrajealaUiApi = hasBridge ? window.prajealaUi : createMockUiApi(window.location.search);
  try {
    const page = new SettingsPage(api, await api.getState(), root);
    api.onState((s) => page.sync(s));
    api.onFocus((f) => page.focus(f));
    api.reportReady({ ok: true });
  } catch (err) {
    const message = err instanceof Error ? (err.stack ?? err.message) : String(err);
    root.replaceChildren(h('pre', { class: 'boot-error', text: message }));
    try {
      api.reportReady({ ok: false, error: err instanceof Error ? err.message : String(err) });
    } catch {
      /* ignore */
    }
  }
}

void boot();
