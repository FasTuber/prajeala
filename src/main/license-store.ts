/**
 * Licence persistence and state: `<userData>/prajeala-license.json`.
 *
 * - Signed keys are verified offline (Ed25519, public key from LicenseConfig).
 * - Raw Lemon Squeezy keys are activated online once, then re-validated every
 *   ONLINE_RECHECK_DAYS while `settings.licenseOnlineCheck` is on; without a
 *   successful check for LS_OFFLINE_GRACE_DAYS they fall back to Free.
 * - `change` events carry the new LicenseInfo; `tier` is what the rest of the
 *   app gates on.
 */
import { EventEmitter } from 'node:events';
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import path from 'node:path';
import {
  buildLicenseInfo,
  evaluateLicense,
  lemonSqueezyKeyOf,
  matchesProduct,
  needsOnlineRecheck,
  normalizeLicenseRecord,
  parseLicenseKey,
  type LicenseActionResult,
  type LicenseEvaluation,
  type LicenseInfo,
  type LicenseRecord,
  type SignatureVerifier,
  type Tier,
} from '../shared/license';
import type { LemonSqueezyCallResult, LemonSqueezyClient } from './lemon-squeezy';
import type { LicenseConfig } from './license-config';
import { makeVerifier } from './license-crypto';
import { createLogger } from './log';

const log = createLogger('license');

export interface LicenseStoreOptions {
  filePath: string;
  config: LicenseConfig;
  client: LemonSqueezyClient;
  /** When false the store never touches the disk (smoke mode). */
  persist?: boolean;
  /** Mirrors settings.licenseOnlineCheck. */
  onlineCheckEnabled(): boolean;
  now?: () => Date;
  verifier?: SignatureVerifier;
  instanceName?: string;
}

export type LicenseChangeListener = (info: LicenseInfo, previous: LicenseInfo) => void;

const RECHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
const STARTUP_CHECK_DELAY_MS = 15_000;

export class LicenseStore extends EventEmitter {
  readonly filePath: string;
  private readonly persist: boolean;
  private readonly config: LicenseConfig;
  private readonly client: LemonSqueezyClient;
  private readonly verifier: SignatureVerifier;
  private readonly signedKeysSupported: boolean;
  private readonly now: () => Date;
  private readonly instanceName: string;
  private readonly onlineCheckEnabled: () => boolean;
  private record: LicenseRecord | null = null;
  private evaluation: LicenseEvaluation;
  private info: LicenseInfo;
  private busy = false;
  private recheckTimer: NodeJS.Timeout | null = null;
  private startupTimer: NodeJS.Timeout | null = null;

  constructor(options: LicenseStoreOptions) {
    super();
    this.filePath = options.filePath;
    this.persist = options.persist ?? true;
    this.config = options.config;
    this.client = options.client;
    this.verifier = options.verifier ?? makeVerifier(options.config.publicKeyHex);
    this.signedKeysSupported = this.verifier(new Uint8Array(1), new Uint8Array(64)) !== null;
    this.now = options.now ?? (() => new Date());
    this.onlineCheckEnabled = options.onlineCheckEnabled;
    this.instanceName = options.instanceName ?? defaultInstanceName();
    this.evaluation = this.evaluate(null);
    this.info = this.snapshot();
  }

  /** Synchronously loads the file (if any). */
  load(): LicenseInfo {
    if (this.persist) {
      try {
        const text = readFileSync(this.filePath, 'utf8');
        this.record = normalizeLicenseRecord(JSON.parse(text));
        if (!this.record) log.warn(`${this.filePath} does not contain a licence record; ignoring it`);
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code !== 'ENOENT') log.warn(`could not read ${this.filePath}:`, err);
        this.record = null;
      }
    }
    this.refresh(false);
    log.info(`licence: ${this.info.tier} (${this.info.status})${this.info.maskedKey ? ` ${this.info.maskedKey}` : ''}${this.info.signedKeysSupported ? '' : ' — signed keys unsupported (no public key)'}`);
    return this.info;
  }

  get tier(): Tier {
    return this.info.tier;
  }

  get(): LicenseInfo {
    return this.info;
  }

  onChange(listener: LicenseChangeListener): () => void {
    this.on('change', listener);
    return () => {
      this.off('change', listener);
    };
  }

  /** Re-evaluates (e.g. after the online-check setting flipped) and notifies when something changed. */
  refresh(notify = true): void {
    this.evaluation = this.evaluate(this.record);
    const previous = this.info;
    this.info = this.snapshot();
    if (notify && !infoEqual(previous, this.info)) this.emit('change', this.info, previous);
  }

  /** Starts the periodic automatic online re-validation. */
  startScheduler(): void {
    this.stopScheduler();
    this.startupTimer = setTimeout(() => void this.autoRecheck(), STARTUP_CHECK_DELAY_MS);
    this.startupTimer.unref?.();
    this.recheckTimer = setInterval(() => void this.autoRecheck(), RECHECK_INTERVAL_MS);
    this.recheckTimer.unref?.();
  }

  stopScheduler(): void {
    if (this.startupTimer) clearTimeout(this.startupTimer);
    if (this.recheckTimer) clearInterval(this.recheckTimer);
    this.startupTimer = null;
    this.recheckTimer = null;
  }

  /**
   * Stores a pasted key. Signed keys are verified offline; raw Lemon Squeezy
   * keys are activated online (network required the first time).
   */
  async activate(input: unknown): Promise<LicenseActionResult> {
    if (this.busy) return this.fail('another licence operation is still running');
    const parsed = parseLicenseKey(input);
    if (!parsed) return this.fail('That does not look like a Prăjeală licence key (PRAJ1.… or a Lemon Squeezy key).');

    if (parsed.kind === 'signed') {
      const candidate: LicenseRecord = { key: parsed.raw, activatedAt: this.now().toISOString() };
      const evaluation = this.evaluate(candidate);
      if (evaluation.tier !== 'pro') return this.fail(evaluation.message);
      this.setRecord(candidate);
      log.info(`signed licence accepted (${this.info.maskedKey})`);
      if (parsed.payload.key && this.onlineCheckEnabled()) void this.checkOnline(); // best effort, non-blocking
      return { ok: true, info: this.info };
    }

    // Raw Lemon Squeezy key → online activation.
    this.setBusy(true);
    try {
      // Same key already activated on this machine: validate instead of burning another instance.
      const existing = this.record && parseLicenseKey(this.record.key);
      const reuseInstance = existing?.kind === 'lemonsqueezy' && existing.key === parsed.key ? this.record?.instanceId ?? null : null;
      const result = reuseInstance
        ? await this.client.validate(parsed.key, reuseInstance)
        : await this.client.activate(parsed.key, this.instanceName);
      if (result.network) return this.fail(`${result.error ?? 'network error'} — a Lemon Squeezy key needs internet for its first activation.`);
      if (!result.ok) return this.fail(result.error ?? 'Lemon Squeezy rejected the key.');
      if (!matchesProduct(result, this.config.storeId, this.config.productId)) {
        return this.fail('This Lemon Squeezy key belongs to a different product.');
      }
      if (result.status === 'disabled' || result.status === 'expired') return this.fail(`Lemon Squeezy reports this key as ${result.status}.`);
      const nowIso = this.now().toISOString();
      this.setRecord({
        key: parsed.raw,
        activatedAt: nowIso,
        instanceId: result.instanceId ?? reuseInstance,
        lastOnlineCheckAt: nowIso,
        lastOnlineResult: 'valid',
        lastOnlineError: null,
        lsStatus: result.status,
        lsExpiresAt: result.expiresAt,
        customerName: result.customerName,
        customerEmail: result.customerEmail,
      });
      log.info(`Lemon Squeezy licence activated (${this.info.maskedKey}, instance ${this.record?.instanceId ?? 'n/a'})`);
      return { ok: true, info: this.info };
    } finally {
      this.setBusy(false);
    }
  }

  /** Forgets the key. Releases the Lemon Squeezy instance when possible (best effort). */
  async deactivate(): Promise<LicenseActionResult> {
    if (this.busy) return this.fail('another licence operation is still running');
    const record = this.record;
    if (!record) return { ok: true, info: this.info };
    const parsed = parseLicenseKey(record.key);
    this.setBusy(true);
    try {
      if (parsed?.kind === 'lemonsqueezy' && record.instanceId) {
        const r = await this.client.deactivate(parsed.key, record.instanceId);
        if (!r.ok) log.warn(`Lemon Squeezy deactivate failed: ${r.error ?? 'unknown'} (forgetting the key locally anyway)`);
      }
    } finally {
      this.setBusy(false);
    }
    this.setRecord(null);
    log.info('licence removed');
    return { ok: true, info: this.info };
  }

  /** Explicit online re-validation. Network errors keep the current state. */
  async checkOnline(): Promise<LicenseActionResult> {
    if (this.busy) return this.fail('another licence operation is still running');
    const record = this.record;
    const parsed = record ? parseLicenseKey(record.key) : null;
    if (!record || !parsed) return this.fail('No licence key to check.');
    const lsKey = lemonSqueezyKeyOf(parsed);
    if (!lsKey) return this.fail('This signed licence has no Lemon Squeezy key to check online.');
    this.setBusy(true);
    try {
      const result = await this.client.validate(lsKey, record.instanceId ?? null);
      this.applyOnlineResult(record, result);
      if (result.network) return this.fail(result.error ?? 'network error');
      return { ok: result.ok, error: result.ok ? undefined : (result.error ?? 'invalid'), info: this.info };
    } finally {
      this.setBusy(false);
    }
  }

  // ── internals ──────────────────────────────────────────────────────────

  private async autoRecheck(): Promise<void> {
    if (this.busy || !needsOnlineRecheck(this.record, this.now(), this.onlineCheckEnabled())) return;
    log.debug('automatic online licence check');
    const r = await this.checkOnline();
    if (!r.ok) log.debug(`automatic check: ${r.error ?? 'not ok'}`);
  }

  private applyOnlineResult(record: LicenseRecord, result: LemonSqueezyCallResult): void {
    const nowIso = this.now().toISOString();
    const next: LicenseRecord = { ...record, lastOnlineCheckAt: nowIso, lastOnlineError: result.error };
    if (result.network) {
      next.lastOnlineResult = 'error';
      // Keep the previous anchor: a dead network must not extend the grace period.
      next.lastOnlineCheckAt = record.lastOnlineCheckAt ?? record.activatedAt;
    } else if (result.ok && matchesProduct(result, this.config.storeId, this.config.productId)) {
      next.lastOnlineResult = 'valid';
      next.lsStatus = result.status;
      next.lsExpiresAt = result.expiresAt;
      next.customerName = result.customerName ?? record.customerName ?? null;
      next.customerEmail = result.customerEmail ?? record.customerEmail ?? null;
      if (result.instanceId) next.instanceId = result.instanceId;
    } else {
      next.lastOnlineResult = 'invalid';
      next.lsStatus = result.status;
      if (!result.error) next.lastOnlineError = 'Lemon Squeezy reports the key as invalid';
    }
    this.setRecord(next);
    log.info(`online check: ${next.lastOnlineResult}${next.lastOnlineError ? ` (${next.lastOnlineError})` : ''} → ${this.info.tier}`);
  }

  private evaluate(record: LicenseRecord | null): LicenseEvaluation {
    return evaluateLicense(record, {
      now: this.now(),
      verify: this.verifier,
      storeId: this.config.storeId,
      productId: this.config.productId,
    });
  }

  private snapshot(): LicenseInfo {
    return buildLicenseInfo(this.record, this.evaluation, {
      onlineCheckEnabled: this.onlineCheckEnabled(),
      signedKeysSupported: this.signedKeysSupported,
      buyUrl: this.config.buyUrl,
      busy: this.busy,
    });
  }

  private setBusy(busy: boolean): void {
    if (this.busy === busy) return;
    this.busy = busy;
    this.refresh();
  }

  private setRecord(record: LicenseRecord | null): void {
    this.record = record;
    this.save();
    this.refresh();
  }

  private fail(error: string): LicenseActionResult {
    return { ok: false, error, info: this.info };
  }

  private save(): void {
    if (!this.persist) return;
    try {
      if (!this.record) {
        try {
          unlinkSync(this.filePath);
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
        }
        return;
      }
      mkdirSync(path.dirname(this.filePath), { recursive: true });
      const tmp = `${this.filePath}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify(this.record, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
      renameSync(tmp, this.filePath);
    } catch (err) {
      log.warn('could not save the licence file:', err);
    }
  }
}

function defaultInstanceName(): string {
  let host = 'unknown-host';
  try {
    host = hostname() || host;
  } catch {
    /* ignore */
  }
  return `${host} (${process.platform})`.slice(0, 120);
}

function infoEqual(a: LicenseInfo, b: LicenseInfo): boolean {
  for (const key of Object.keys(a) as (keyof LicenseInfo)[]) {
    if (a[key] !== b[key]) return false;
  }
  return true;
}
