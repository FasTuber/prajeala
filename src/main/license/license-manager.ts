/**
 * Licence state of this install: `<userData>/prajeala-license.json`.
 *
 *   - First launch starts the Pro trial (PRODUCT.trialDays).
 *   - `activate(key)` accepts Lemon Squeezy keys (online, once) and offline
 *     `PRJ1-…` keys (verified locally).
 *   - Store keys are re-validated in the background every few days. Only a
 *     definite “no” from the store (refund, revoked, expired) removes Pro;
 *     being offline never does.
 *   - Emits `change` with the new LicenseStatus whenever the tier can have changed.
 *
 * No Electron imports (fetch is injected), so the whole flow is unit-tested.
 */
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  FREE_STATUS,
  classifyKey,
  cleanKey,
  maskKey,
  trialState,
  type LicenseActionResult,
  type LicenseResultCode,
  type LicenseSource,
  type LicenseStatus,
} from '../../shared/license';
import { isStoreConfigured, type ProductConfig } from '../../shared/product';
import { createLogger } from '../log';
import { activateStoreKey, deactivateStoreKey, validateStoreKey, type FetchLike } from './lemonsqueezy';
import { verifyOfflineKey } from './offline';

const log = createLogger('license');

const DAY_MS = 86_400_000;
const DEFAULT_REVALIDATE_MS = 7 * DAY_MS;
const FIRST_CHECK_DELAY_MS = 20_000;
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
/** setTimeout cannot wait longer than ~24.8 days. */
const MAX_TIMER_MS = 2_147_000_000;

export interface StoredLicense {
  source: LicenseSource;
  key: string;
  /** Lemon Squeezy activation (“instance”) id; null for offline keys. */
  instanceId: string | null;
  licensee: string;
  activatedAt: number;
  lastValidatedAt: number | null;
}

export interface LicenseFile {
  v: 1;
  /** Random id of this install (part of the activation name shown to the seller). */
  installId: string;
  firstRunAt: number;
  license: StoredLicense | null;
}

export interface LicenseManagerOptions {
  filePath: string;
  /** When false nothing is read from or written to disk (smoke mode, tests). */
  persist: boolean;
  product: ProductConfig;
  fetch: FetchLike;
  platform: string;
  now?: () => number;
  /** Development override (`--force-tier`, unpackaged builds only). */
  forceTier?: 'free' | 'pro' | null;
  revalidateEveryMs?: number;
}

export class LicenseManager extends EventEmitter {
  private readonly now: () => number;
  private readonly revalidateEveryMs: number;
  private data: LicenseFile;
  private firstRun = false;
  private busy = false;
  private notice = '';
  private lastCheckAttemptAt = 0;
  private checkTimer: NodeJS.Timeout | null = null;
  private trialTimer: NodeJS.Timeout | null = null;
  private lastPro: boolean | null = null;

  constructor(private readonly options: LicenseManagerOptions) {
    super();
    this.now = options.now ?? Date.now;
    this.revalidateEveryMs = options.revalidateEveryMs ?? DEFAULT_REVALIDATE_MS;
    this.data = this.fresh();
  }

  /** Reads the licence file; a missing (or unreadable) file means a first run. */
  load(): LicenseStatus {
    if (this.options.persist) {
      try {
        this.data = parseLicenseFile(JSON.parse(readFileSync(this.options.filePath, 'utf8'))) ?? this.recover();
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') log.warn('licence file unreadable, starting over:', err);
        this.data = this.fresh();
        this.firstRun = true;
        this.save();
      }
    } else {
      this.firstRun = true;
    }
    this.recheckOfflineKey();
    const status = this.status();
    this.lastPro = status.pro;
    log.info(`tier ${status.tier}${status.tier === 'trial' ? ` (${status.trialDaysLeft} days left)` : ''}${status.source ? ` via ${status.source} key` : ''}`);
    return status;
  }

  /** True when this launch created the licence file (welcome window, trial start). */
  get isFirstRun(): boolean {
    return this.firstRun;
  }

  get pro(): boolean {
    return this.status().pro;
  }

  status(): LicenseStatus {
    const product = this.options.product;
    const base: LicenseStatus = {
      ...FREE_STATUS,
      storeConfigured: isStoreConfigured(product),
      offlineConfigured: product.offlinePublicKey.length > 0,
      notice: this.notice,
    };
    const lic = this.data.license;
    if (lic) {
      base.tier = 'pro';
      base.pro = true;
      base.source = lic.source;
      base.licensee = lic.licensee;
      base.keyHint = maskKey(lic.key);
      base.lastValidatedAt = lic.lastValidatedAt;
    } else {
      const trial = trialState(this.data.firstRunAt, this.now(), product.trialDays);
      if (trial.active) {
        base.tier = 'trial';
        base.pro = true;
        base.trialDaysLeft = trial.daysLeft;
        base.trialEndsAt = trial.endsAt;
      } else if (product.trialDays > 0) {
        base.trialEndsAt = trial.endsAt;
      }
    }
    if (this.options.forceTier === 'pro' && !base.pro) Object.assign(base, { tier: 'pro', pro: true });
    if (this.options.forceTier === 'free') Object.assign(base, { tier: 'free', pro: false, trialDaysLeft: 0 });
    return base;
  }

  async activate(input: string): Promise<LicenseActionResult> {
    const key = cleanKey(input);
    if (!key) return this.result(false, 'empty', 'Paste your licence key first.');
    if (this.busy) return this.result(false, 'busy', 'Please wait, the previous request is still running.');
    this.busy = true;
    try {
      switch (classifyKey(key)) {
        case 'offline':
          return this.activateOffline(key);
        case 'store':
          return await this.activateStore(key);
        default:
          return this.result(false, 'malformed', 'This does not look like a Prăjeală licence key.');
      }
    } finally {
      this.busy = false;
    }
  }

  /** Removes the licence from this computer (and frees the store activation slot). */
  async deactivate(): Promise<LicenseActionResult> {
    const lic = this.data.license;
    if (!lic) return this.result(true, 'deactivated', 'No licence is active on this computer.');
    if (this.busy) return this.result(false, 'busy', 'Please wait, the previous request is still running.');
    this.busy = true;
    try {
      if (lic.source === 'store' && lic.instanceId) {
        const res = await deactivateStoreKey(lic.key, lic.instanceId, this.options.fetch);
        // A definite “unknown key/instance” means there is nothing left to free on the server.
        if (!res.ok && !res.definitive) return this.result(false, res.code, res.message);
      }
      this.data.license = null;
      this.notice = '';
      this.save();
      log.info('licence removed from this computer');
      this.emitIfChanged(true);
      return this.result(true, 'deactivated', 'Licence removed from this computer.');
    } finally {
      this.busy = false;
    }
  }

  /** Re-checks a store key when it is due (or when `force`). Never throws. */
  async revalidate(force = false): Promise<void> {
    const lic = this.data.license;
    if (!lic || lic.source !== 'store' || this.busy) return;
    if (!isStoreConfigured(this.options.product)) return;
    const now = this.now();
    const last = lic.lastValidatedAt ?? lic.activatedAt;
    if (!force && now - last < this.revalidateEveryMs) return;
    if (!force && now - this.lastCheckAttemptAt < CHECK_INTERVAL_MS / 2) return;
    this.lastCheckAttemptAt = now;
    this.busy = true;
    try {
      const res = await validateStoreKey(lic.key, lic.instanceId, this.options.product.lemonSqueezy, this.options.fetch);
      if (this.data.license !== lic) return; // replaced meanwhile
      if (res.ok) {
        lic.lastValidatedAt = now;
        if (res.licensee) lic.licensee = res.licensee;
        this.save();
        log.info('licence re-validated');
        this.emitIfChanged(true);
      } else if (res.definitive) {
        log.warn(`licence no longer valid (${res.code}): ${res.message}`);
        this.data.license = null;
        this.notice = res.message;
        this.save();
        this.emitIfChanged(true);
      } else {
        log.info(`licence check postponed: ${res.message}`);
      }
    } catch (err) {
      log.warn('licence check failed:', err);
    } finally {
      this.busy = false;
    }
  }

  /** Background work: periodic re-validation and the end-of-trial switch. */
  start(): void {
    this.stop();
    this.checkTimer = setTimeout(() => {
      void this.revalidate();
      this.checkTimer = setInterval(() => void this.revalidate(), CHECK_INTERVAL_MS);
      this.checkTimer.unref?.();
    }, FIRST_CHECK_DELAY_MS);
    this.checkTimer.unref?.();
    this.scheduleTrialEnd();
  }

  stop(): void {
    if (this.checkTimer) {
      clearTimeout(this.checkTimer);
      clearInterval(this.checkTimer);
      this.checkTimer = null;
    }
    if (this.trialTimer) {
      clearTimeout(this.trialTimer);
      this.trialTimer = null;
    }
  }

  onChange(listener: (status: LicenseStatus) => void): () => void {
    this.on('change', listener);
    return () => {
      this.off('change', listener);
    };
  }

  /** Name of this computer's activation in the Lemon Squeezy dashboard (no hostname: privacy). */
  instanceName(): string {
    const os = this.options.platform === 'darwin' ? 'macOS' : this.options.platform === 'win32' ? 'Windows' : 'Linux';
    return `Prăjeală · ${os} · ${this.data.installId.slice(0, 8)}`;
  }

  // ── internals ──────────────────────────────────────────────────────────

  /** Offline keys are verified on every launch (edited file, revoked key, rotated public key). */
  private recheckOfflineKey(): void {
    const lic = this.data.license;
    if (lic?.source !== 'offline') return;
    const product = this.options.product;
    const res = verifyOfflineKey(lic.key, product.offlinePublicKey, product.revokedOfflineKeyIds);
    if (res.ok) return;
    log.warn(`stored offline key rejected (${res.code})`);
    this.data.license = null;
    this.notice = res.message;
    this.save();
  }

  private activateOffline(key: string): LicenseActionResult {
    const product = this.options.product;
    const res = verifyOfflineKey(key, product.offlinePublicKey, product.revokedOfflineKeyIds);
    if (!res.ok) return this.result(false, res.code, res.message);
    void this.releaseStoreActivation();
    this.data.license = {
      source: 'offline',
      key,
      instanceId: null,
      licensee: res.payload.to,
      activatedAt: this.now(),
      lastValidatedAt: null,
    };
    return this.activated();
  }

  private async activateStore(key: string): Promise<LicenseActionResult> {
    const product = this.options.product;
    if (!isStoreConfigured(product)) {
      return this.result(false, 'not-configured', 'Online activation is not set up in this build yet.');
    }
    const current = this.data.license;
    if (current?.source === 'store' && current.key === key && current.instanceId) {
      return this.result(true, 'activated', 'This licence key is already active on this computer.');
    }
    const res = await activateStoreKey(key, this.instanceName(), product.lemonSqueezy, this.options.fetch);
    if (!res.ok || !res.instanceId) return this.result(false, res.code, res.message);
    await this.releaseStoreActivation();
    const now = this.now();
    this.data.license = {
      source: 'store',
      key,
      instanceId: res.instanceId,
      licensee: res.licensee ?? '',
      activatedAt: now,
      lastValidatedAt: now,
    };
    return this.activated();
  }

  private activated(): LicenseActionResult {
    this.notice = '';
    this.save();
    log.info(`licence activated (${this.data.license?.source})`);
    this.emitIfChanged(true);
    return this.result(true, 'activated', 'Prăjeală Pro is active. Thank you for supporting the project!');
  }

  /** Best effort: frees the activation slot of the store key being replaced. */
  private async releaseStoreActivation(): Promise<void> {
    const lic = this.data.license;
    if (lic?.source !== 'store' || !lic.instanceId) return;
    try {
      await deactivateStoreKey(lic.key, lic.instanceId, this.options.fetch);
    } catch {
      /* the buyer can still free it from the store's customer portal */
    }
  }

  private result(ok: boolean, code: LicenseResultCode, message: string): LicenseActionResult {
    return { ok, code, message, status: this.status() };
  }

  private emitIfChanged(always = false): void {
    const status = this.status();
    if (always || status.pro !== this.lastPro) this.emit('change', status);
    this.lastPro = status.pro;
    this.scheduleTrialEnd();
  }

  private scheduleTrialEnd(): void {
    if (this.trialTimer) {
      clearTimeout(this.trialTimer);
      this.trialTimer = null;
    }
    const status = this.status();
    if (status.tier !== 'trial' || status.trialEndsAt === null) return;
    const wait = Math.min(MAX_TIMER_MS, Math.max(1000, status.trialEndsAt - this.now() + 1000));
    this.trialTimer = setTimeout(() => {
      this.trialTimer = null;
      if (!this.status().pro) log.info('Pro trial ended');
      this.emitIfChanged();
    }, wait);
    this.trialTimer.unref?.();
  }

  private fresh(): LicenseFile {
    return { v: 1, installId: randomUUID(), firstRunAt: this.now(), license: null };
  }

  /** Readable JSON with an unexpected shape: keep a fresh state but do not grant a new trial. */
  private recover(): LicenseFile {
    log.warn('licence file has an unexpected format; resetting it');
    const data = this.fresh();
    data.firstRunAt = 0;
    this.data = data;
    this.save();
    return data;
  }

  private save(): void {
    if (!this.options.persist) return;
    const file = this.options.filePath;
    const tmp = `${file}.${process.pid}.tmp`;
    try {
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(tmp, JSON.stringify(this.data, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
      renameSync(tmp, file);
    } catch (err) {
      log.warn('could not save licence file:', err);
    }
  }
}

/** Strict reader for the licence file; returns null for anything malformed. */
export function parseLicenseFile(input: unknown): LicenseFile | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const o = input as Record<string, unknown>;
  if (o.v !== 1 || typeof o.installId !== 'string' || o.installId.length < 8) return null;
  if (typeof o.firstRunAt !== 'number' || !Number.isFinite(o.firstRunAt)) return null;
  let license: StoredLicense | null = null;
  if (o.license !== null && o.license !== undefined) {
    const l = o.license as Record<string, unknown>;
    if (!l || typeof l !== 'object') return null;
    const source = l.source === 'store' || l.source === 'offline' ? l.source : null;
    if (!source || typeof l.key !== 'string' || classifyKey(l.key) !== source) return null;
    license = {
      source,
      key: l.key,
      instanceId: typeof l.instanceId === 'string' && l.instanceId ? l.instanceId : null,
      licensee: typeof l.licensee === 'string' ? l.licensee : '',
      activatedAt: typeof l.activatedAt === 'number' ? l.activatedAt : 0,
      lastValidatedAt: typeof l.lastValidatedAt === 'number' ? l.lastValidatedAt : null,
    };
    if (source === 'store' && !license.instanceId) return null;
  }
  return { v: 1, installId: o.installId, firstRunAt: o.firstRunAt, license };
}
