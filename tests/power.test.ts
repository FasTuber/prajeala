import { describe, expect, it } from 'vitest';

import { AWAKE, applyPowerProfile, coversDisplay, powerState, powerStatesEqual } from '../src/shared/power';
import { DEFAULT_SETTINGS, normalizeSettings } from '../src/shared/settings';

const input = (patch: Partial<Parameters<typeof powerState>[1]> = {}) => ({
  msSinceInput: 0,
  systemIdleSeconds: 0,
  onBattery: false,
  locked: false,
  ...patch,
});

describe('powerState', () => {
  it('is awake while the user is active', () => {
    expect(powerState(DEFAULT_SETTINGS, input())).toEqual(AWAKE);
  });

  it('sleeps only when both our input clock and the system idle time are past the threshold', () => {
    const s = normalizeSettings({ idleSleepSeconds: 60 });
    expect(powerState(s, input({ msSinceInput: 61_000, systemIdleSeconds: 61 }))).toMatchObject({ sleeping: true, paused: false, reason: 'idle' });
    // typing in another app (seen by the OS, not by us) keeps it awake
    expect(powerState(s, input({ msSinceInput: 300_000, systemIdleSeconds: 3 })).sleeping).toBe(false);
    expect(powerState(normalizeSettings({ idleSleep: false }), input({ msSinceInput: 1e9, systemIdleSeconds: 1e6 })).sleeping).toBe(false);
  });

  it('pauses when locked and follows the battery mode', () => {
    expect(powerState(DEFAULT_SETTINGS, input({ locked: true }))).toMatchObject({ paused: true, reason: 'locked' });
    expect(powerState(normalizeSettings({ batteryMode: 'pause' }), input({ onBattery: true }))).toMatchObject({ paused: true, reason: 'battery' });
    expect(powerState(normalizeSettings({ batteryMode: 'eco' }), input({ onBattery: true }))).toMatchObject({ paused: false, eco: true });
    expect(powerState(normalizeSettings({ batteryMode: 'normal' }), input({ onBattery: true }))).toEqual(AWAKE);
    expect(powerState(normalizeSettings({ batteryMode: 'pause' }), input({ onBattery: false }))).toEqual(AWAKE);
  });

  it('compares states', () => {
    expect(powerStatesEqual(AWAKE, { ...AWAKE })).toBe(true);
    expect(powerStatesEqual(AWAKE, { ...AWAKE, eco: true })).toBe(false);
  });
});

describe('applyPowerProfile', () => {
  it('leaves settings alone unless eco', () => {
    expect(applyPowerProfile(DEFAULT_SETTINGS, AWAKE)).toBe(DEFAULT_SETTINGS);
  });
  it('caps fps, resolution and pressure iterations in eco', () => {
    const s = normalizeSettings({ maxFps: 144, simScale: 0.4, pressureIterations: 20 });
    const e = applyPowerProfile(s, { ...AWAKE, eco: true });
    expect(e.maxFps).toBe(30);
    expect(e.simScale).toBeCloseTo(0.28, 6);
    expect(e.pressureIterations).toBe(8);
    expect(applyPowerProfile(normalizeSettings({ maxFps: 15, simScale: 0.1 }), { ...AWAKE, eco: true })).toMatchObject({ maxFps: 15, simScale: 0.1 });
  });
});

describe('coversDisplay', () => {
  const display = { x: 1920, y: 0, width: 2560, height: 1440 };
  it('detects borderless fullscreen windows (with a small tolerance)', () => {
    expect(coversDisplay({ x: 1920, y: 0, width: 2560, height: 1440 }, display)).toBe(true);
    expect(coversDisplay({ x: 1919, y: -1, width: 2562, height: 1442 }, display)).toBe(true);
  });
  it('ignores maximised windows that stop at the taskbar and windows on other displays', () => {
    expect(coversDisplay({ x: 1920, y: 0, width: 2560, height: 1392 }, display)).toBe(false);
    expect(coversDisplay({ x: 0, y: 0, width: 1920, height: 1080 }, display)).toBe(false);
  });
});
