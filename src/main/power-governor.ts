/**
 * Power governor ("Ralanti"): turns OS signals into a PowerState.
 *
 * - input activity: cursor moves, clicks and key presses reported by the
 *   trackers (counts only — never which key), plus powerMonitor's system idle
 *   time for input we cannot see;
 * - lock-screen / suspend → paused; unlock / resume → awake again;
 * - on-battery / on-ac → the battery mode from the settings.
 *
 * Emits `change` with the new state; main applies it (hide overlays, eco
 * profile, IPC.power to the renderers).
 */
import { EventEmitter } from 'node:events';
import { powerMonitor } from 'electron';
import { AWAKE, powerState, powerStatesEqual, type PowerState } from '../shared/power';
import type { Settings } from '../shared/settings';
import { createLogger } from './log';

const log = createLogger('power');

const TICK_MS = 1000;

export class PowerGovernor extends EventEmitter {
  private state: PowerState = AWAKE;
  private lastInputAt = Date.now();
  private locked = false;
  private onBattery = false;
  private timer: NodeJS.Timeout | null = null;
  private readonly subscriptions: Array<[string, () => void]> = [];

  constructor(private readonly getSettings: () => Settings) {
    super();
  }

  start(): void {
    try {
      this.onBattery = powerMonitor.isOnBatteryPower();
    } catch {
      this.onBattery = false;
    }
    const on = (event: string, fn: () => void): void => {
      try {
        powerMonitor.on(event as 'lock-screen', fn);
        this.subscriptions.push([event, fn]);
      } catch (err) {
        log.debug(`powerMonitor.${event} unavailable:`, err);
      }
    };
    on('lock-screen', () => this.setLocked(true, 'screen locked'));
    on('unlock-screen', () => this.setLocked(false, 'screen unlocked'));
    on('suspend', () => this.setLocked(true, 'suspend'));
    on('resume', () => this.setLocked(false, 'resume'));
    on('on-battery', () => this.setBattery(true));
    on('on-ac', () => this.setBattery(false));
    this.timer = setInterval(() => this.evaluate(), TICK_MS);
    this.timer.unref?.();
    this.evaluate();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const [event, fn] of this.subscriptions) {
      try {
        powerMonitor.off(event as 'lock-screen', fn);
      } catch {
        /* ignore */
      }
    }
    this.subscriptions.length = 0;
  }

  get current(): PowerState {
    return this.state;
  }

  /** Any user input seen by this app. Wakes a sleeping fire immediately. */
  noteInput(): void {
    this.lastInputAt = Date.now();
    if (this.state.sleeping && !this.state.paused) this.evaluate();
  }

  /** Re-evaluates now (settings changed). */
  evaluate(): void {
    const next = powerState(this.getSettings(), {
      msSinceInput: Date.now() - this.lastInputAt,
      systemIdleSeconds: systemIdleSeconds(),
      onBattery: this.onBattery,
      locked: this.locked,
    });
    if (powerStatesEqual(next, this.state)) return;
    this.state = next;
    log.info(`power: ${next.paused ? 'paused' : next.sleeping ? 'sleeping' : 'awake'}${next.eco ? ' (eco)' : ''} — ${next.reason}`);
    this.emit('change', next);
  }

  onChange(listener: (state: PowerState) => void): () => void {
    this.on('change', listener);
    return () => {
      this.off('change', listener);
    };
  }

  private setLocked(locked: boolean, why: string): void {
    log.debug(why);
    this.locked = locked;
    if (!locked) this.lastInputAt = Date.now();
    this.evaluate();
  }

  private setBattery(onBattery: boolean): void {
    this.onBattery = onBattery;
    this.evaluate();
  }
}

/** Seconds since the last OS-level input; unknown → Infinity (our own input clock decides). */
function systemIdleSeconds(): number {
  try {
    return powerMonitor.getSystemIdleTime();
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}
