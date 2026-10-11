/**
 * Licence window page (dist/renderer/license.html). Plain DOM, no framework.
 * Talks to the main process through the shared preload bridge; when opened in a
 * browser without the bridge it falls back to the in-page mock (always Pro).
 */
import type { PrajealaApi } from '../../shared/ipc';
import type { LicenseActionResult, LicenseInfo } from '../../shared/license';
import { parseOptions } from '../app/options';
import { createMockApi } from '../mock/MockApi';

function $<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`#${id} missing in license.html`);
  return el as T;
}

function resolveApi(): PrajealaApi {
  const bridge: unknown = (window as { prajeala?: unknown }).prajeala;
  if (typeof bridge === 'object' && bridge !== null && typeof (bridge as { getLicense?: unknown }).getLicense === 'function') {
    return window.prajeala;
  }
  return createMockApi(parseOptions(window.location.search));
}

function formatDate(iso: string | null): string {
  if (!iso) return '';
  return iso.length > 10 ? iso.slice(0, 10) : iso;
}

function boot(): void {
  const api = resolveApi();
  const tierEl = $<HTMLSpanElement>('tier');
  const statusEl = $<HTMLDivElement>('status');
  const metaEl = $<HTMLDivElement>('meta');
  const keyEl = $<HTMLTextAreaElement>('key');
  const activateBtn = $<HTMLButtonElement>('activate');
  const checkBtn = $<HTMLButtonElement>('check');
  const deactivateBtn = $<HTMLButtonElement>('deactivate');
  const buyBtn = $<HTMLButtonElement>('buy');
  const closeBtn = $<HTMLButtonElement>('close');

  let current: LicenseInfo | null = null;
  let transient: { text: string; tone: 'ok' | 'warn' | 'err' } | null = null;

  const render = (): void => {
    const info = current;
    if (!info) return;
    const pro = info.tier === 'pro';
    tierEl.textContent = pro ? 'Pro' : 'Free';
    tierEl.classList.toggle('pro', pro);
    const tone: 'ok' | 'warn' | 'err' | '' = transient
      ? transient.tone
      : pro
        ? 'ok'
        : info.status === 'none'
          ? ''
          : info.status === 'unverified' || info.status === 'unsupported'
            ? 'warn'
            : 'err';
    statusEl.className = tone;
    statusEl.textContent = transient ? transient.text : info.message;
    const bits: string[] = [];
    if (info.maskedKey) bits.push(`key ${info.maskedKey}`);
    if (info.name) bits.push(info.name);
    if (info.email) bits.push(info.email);
    if (info.activatedAt) bits.push(`activated ${formatDate(info.activatedAt)}`);
    if (info.lastOnlineCheckAt) bits.push(`last online check ${formatDate(info.lastOnlineCheckAt)} (${info.lastOnlineResult ?? 'n/a'})`);
    if (info.graceUntil && info.kind === 'lemonsqueezy') bits.push(`offline until ${formatDate(info.graceUntil)}`);
    if (!info.signedKeysSupported) bits.push('signed keys unsupported in this build');
    metaEl.textContent = bits.join(' · ');
    const hasKey = info.kind !== 'none';
    activateBtn.disabled = info.busy;
    activateBtn.textContent = info.busy ? 'Working…' : hasKey ? 'Replace key' : 'Activate';
    checkBtn.disabled = info.busy || !hasKey || !info.canCheckOnline;
    deactivateBtn.disabled = info.busy || !hasKey;
    buyBtn.hidden = pro;
  };

  const applyResult = (what: string, r: LicenseActionResult): void => {
    current = r.info;
    transient = r.ok ? { text: `${what}: ${r.info.message}`, tone: r.info.tier === 'pro' ? 'ok' : 'warn' } : { text: `${what} failed: ${r.error ?? 'unknown error'}`, tone: 'err' };
    render();
  };

  activateBtn.addEventListener('click', () => {
    const key = keyEl.value.trim();
    if (!key) {
      transient = { text: 'Paste your licence key first.', tone: 'warn' };
      render();
      keyEl.focus();
      return;
    }
    transient = { text: 'Checking the key…', tone: 'warn' };
    render();
    void api.activateLicense(key).then((r) => {
      applyResult('Activation', r);
      if (r.ok) keyEl.value = '';
    });
  });
  checkBtn.addEventListener('click', () => {
    transient = { text: 'Asking Lemon Squeezy…', tone: 'warn' };
    render();
    void api.checkLicenseOnline().then((r) => applyResult('Online check', r));
  });
  deactivateBtn.addEventListener('click', () => {
    void api.deactivateLicense().then((r) => applyResult('Removal', r));
  });
  buyBtn.addEventListener('click', () => void api.openBuyPage());
  closeBtn.addEventListener('click', () => void api.closeLicenseWindow());
  keyEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      activateBtn.click();
    }
  });
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') void api.closeLicenseWindow();
  });

  api.onLicense((info) => {
    current = info;
    if (!info.busy) transient = null;
    render();
  });
  void api.getLicense().then((info) => {
    current = info;
    render();
  });
}

try {
  boot();
} catch (err) {
  console.error('[prajeala:license] fatal', err);
}
