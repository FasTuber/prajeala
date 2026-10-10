/**
 * Persistent user settings: `<userData>/prajeala-settings.json`.
 *
 * - Reads are validated through `normalizeSettings` (never throws on garbage).
 * - Writes are atomic (temp file + rename) and debounced.
 * - `change` events are emitted with `(next, previous)` whenever a field changed.
 * - `launchAtLogin` is mirrored into the OS login items (macOS/Windows only;
 *   Electron's `setLoginItemSettings` is a no-op on Linux, so we skip it there).
 */
import { EventEmitter } from 'node:events';
import { promises as fsp, readFileSync, renameSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { app } from 'electron';
import { DEFAULT_SETTINGS, mergeSettings, normalizeSettings, type Settings } from '../shared/settings';
import { createLogger } from './log';

const log = createLogger('settings');

export interface SettingsStoreOptions {
  filePath: string;
  /** When false the store never touches the disk (smoke mode). */
  persist?: boolean;
  /** Debounce for saves, in ms. */
  saveDelayMs?: number;
}

export type SettingsChangeListener = (next: Settings, previous: Settings) => void;

export class SettingsStore extends EventEmitter {
  readonly filePath: string;
  private readonly persist: boolean;
  private readonly saveDelayMs: number;
  private settings: Settings = { ...DEFAULT_SETTINGS };
  private saveTimer: NodeJS.Timeout | null = null;
  private dirty = false;
  private saving: Promise<void> | null = null;

  constructor(options: SettingsStoreOptions) {
    super();
    this.filePath = options.filePath;
    this.persist = options.persist ?? true;
    this.saveDelayMs = options.saveDelayMs ?? 300;
  }

  /** Synchronously loads the file (if any). Safe to call once at startup. */
  load(): Settings {
    if (!this.persist) {
      this.settings = { ...DEFAULT_SETTINGS };
      return this.settings;
    }
    try {
      const text = readFileSync(this.filePath, 'utf8');
      this.settings = normalizeSettings(JSON.parse(text));
      log.debug(`loaded ${this.filePath}`);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') log.warn(`could not read ${this.filePath}, using defaults:`, err);
      this.settings = { ...DEFAULT_SETTINGS };
    }
    return this.settings;
  }

  get(): Settings {
    return this.settings;
  }

  /** Merges a (possibly untrusted) patch, validates, persists and notifies. Returns the new settings. */
  update(patch: Partial<Settings> | unknown): Settings {
    const previous = this.settings;
    const next = mergeSettings(previous, patch);
    if (settingsEqual(previous, next)) return previous;
    this.settings = next;
    this.applyLoginItem(next, previous);
    this.scheduleSave();
    this.emit('change', next, previous);
    return next;
  }

  onChange(listener: SettingsChangeListener): () => void {
    this.on('change', listener);
    return () => {
      this.off('change', listener);
    };
  }

  /** Writes pending changes now (async, atomic). */
  async flush(): Promise<void> {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    if (!this.dirty || !this.persist) return;
    if (this.saving) await this.saving;
    this.saving = this.writeAtomic();
    try {
      await this.saving;
    } finally {
      this.saving = null;
    }
  }

  /** Synchronous variant for `before-quit` (Electron may not wait for promises there). */
  flushSync(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    if (!this.dirty || !this.persist) return;
    try {
      mkdirSync(path.dirname(this.filePath), { recursive: true });
      const tmp = this.tmpPath();
      writeFileSync(tmp, JSON.stringify(this.settings, null, 2) + '\n', 'utf8');
      renameSync(tmp, this.filePath);
      this.dirty = false;
    } catch (err) {
      log.warn('could not save settings:', err);
    }
  }

  /** Makes sure the file exists (so "Open settings file" has something to open). */
  async ensureFile(): Promise<void> {
    if (!this.persist) return;
    try {
      await fsp.access(this.filePath);
    } catch {
      this.dirty = true;
      await this.flush();
    }
  }

  private scheduleSave(): void {
    this.dirty = true;
    if (!this.persist) return;
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      void this.flush();
    }, this.saveDelayMs);
  }

  private tmpPath(): string {
    return `${this.filePath}.${process.pid}.${Date.now().toString(36)}.tmp`;
  }

  private async writeAtomic(): Promise<void> {
    const snapshot = JSON.stringify(this.settings, null, 2) + '\n';
    this.dirty = false;
    const tmp = this.tmpPath();
    try {
      await fsp.mkdir(path.dirname(this.filePath), { recursive: true });
      await fsp.writeFile(tmp, snapshot, 'utf8');
      await fsp.rename(tmp, this.filePath);
      log.debug(`saved ${this.filePath}`);
    } catch (err) {
      this.dirty = true;
      log.warn('could not save settings:', err);
      try {
        await fsp.unlink(tmp);
      } catch {
        /* ignore */
      }
    }
  }

  private applyLoginItem(next: Settings, previous: Settings): void {
    if (next.launchAtLogin === previous.launchAtLogin) return;
    // Electron only implements login items on macOS and Windows.
    if (process.platform === 'linux') {
      log.debug('launchAtLogin ignored on Linux (no login-item API)');
      return;
    }
    try {
      app.setLoginItemSettings({ openAtLogin: next.launchAtLogin });
      log.info(`launch at login ${next.launchAtLogin ? 'enabled' : 'disabled'}`);
    } catch (err) {
      log.warn('could not update login item:', err);
    }
  }
}

export function settingsEqual(a: Settings, b: Settings): boolean {
  for (const key of Object.keys(a) as (keyof Settings)[]) {
    if (a[key] !== b[key]) return false;
  }
  return true;
}
