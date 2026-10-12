import { describe, expect, it } from 'vitest';

import { SCENES, SCENE_PATCHES, activeScene, sceneNeedsPro, scenePatch, seasonAt } from '../src/shared/scenes';
import { DEFAULT_SETTINGS, mergeSettings, normalizeSettings } from '../src/shared/settings';

describe('scenes', () => {
  it('every scene patch survives settings validation unchanged', () => {
    for (const scene of SCENES) {
      const merged = mergeSettings(DEFAULT_SETTINGS, SCENE_PATCHES[scene]);
      for (const [k, v] of Object.entries(SCENE_PATCHES[scene])) {
        expect(merged[k as keyof typeof merged], `${scene}.${k}`).toEqual(v);
      }
    }
  });

  it('the defaults are the classic scene', () => {
    expect(activeScene(DEFAULT_SETTINGS)).toBe('classic');
  });

  it('recognises an applied scene and loses it after a change', () => {
    const s = mergeSettings(DEFAULT_SETTINGS, SCENE_PATCHES.hearth);
    expect(activeScene(s)).toBe('hearth');
    expect(activeScene(mergeSettings(s, { sparks: false }))).toBeNull();
  });

  it('knows which scenes need Pro and strips their locked parts', () => {
    expect(sceneNeedsPro('classic')).toBe(false);
    expect(sceneNeedsPro('hearth')).toBe(false);
    expect(sceneNeedsPro('subtle')).toBe(false);
    expect(sceneNeedsPro('inferno')).toBe(true);
    expect(sceneNeedsPro('haunted')).toBe(true);
    expect(sceneNeedsPro('party')).toBe(true);
    const freeHaunted = scenePatch('haunted', false);
    expect(freeHaunted.torch).toBeUndefined();
    expect(freeHaunted.palette).toBeUndefined();
    expect(scenePatch('haunted', true).torch).toBe(true);
  });

  it('only touches mood keys, never power or performance', () => {
    for (const scene of SCENES) {
      for (const k of Object.keys(SCENE_PATCHES[scene])) {
        expect(['simScale', 'maxFps', 'pressureIterations', 'idleSleep', 'batteryMode', 'enabled', 'launchAtLogin']).not.toContain(k);
      }
    }
    expect(normalizeSettings(SCENE_PATCHES.party).audioSource).toBe('system');
  });
});

describe('seasons', () => {
  const at = (m: number, d: number) => seasonAt(new Date(2026, m - 1, d, 12));
  it('finds the events around their dates', () => {
    expect(at(10, 11)).toBeNull();
    expect(at(10, 24)?.event).toBe('sumedru');
    expect(at(10, 26)?.event).toBe('sumedru');
    expect(at(10, 27)?.event).toBe('halloween');
    expect(at(10, 31)?.scene).toBe('haunted');
    expect(at(11, 1)?.event).toBe('halloween');
    expect(at(11, 2)).toBeNull();
    expect(at(12, 19)).toBeNull();
    expect(at(12, 24)?.event).toBe('winter');
    expect(at(1, 6)?.event).toBe('winter');
    expect(at(1, 7)).toBeNull();
  });
});
