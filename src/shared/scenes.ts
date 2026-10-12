/**
 * Scenes: one click sets a whole mood (which fires burn, how hard, which
 * colours). A scene only touches the keys it lists; everything else (power,
 * performance, system options) stays as the user left it.
 *
 * Seasonal events suggest a scene around the dates they belong to.
 */
import { stripLockedChoices } from './pro';
import type { Settings } from './settings';

export const SCENES = ['classic', 'hearth', 'subtle', 'party', 'inferno', 'haunted'] as const;
export type Scene = (typeof SCENES)[number];

type ScenePatch = Partial<
  Pick<
    Settings,
    | 'intensity'
    | 'palette'
    | 'cursorMode'
    | 'clickBursts'
    | 'burnActiveWindow'
    | 'screenBottomFire'
    | 'sparks'
    | 'audioSource'
    | 'audioStyle'
    | 'audioDrops'
    | 'torch'
  >
>;

export const SCENE_PATCHES: Readonly<Record<Scene, Readonly<ScenePatch>>> = Object.freeze({
  /** The defaults: cursor comet, click bursts, the active window burns. */
  classic: {
    intensity: 'medium',
    palette: 'classic',
    cursorMode: 'comet',
    clickBursts: true,
    burnActiveWindow: true,
    screenBottomFire: false,
    sparks: true,
    audioSource: 'off',
    torch: false,
  },
  /** A calm fireplace along the bottom of the screen, nothing else. */
  hearth: {
    intensity: 'low',
    palette: 'ember',
    cursorMode: 'off',
    clickBursts: false,
    burnActiveWindow: false,
    screenBottomFire: true,
    sparks: true,
    audioSource: 'off',
    torch: false,
  },
  /** Just a thin trail behind the cursor, for working. */
  subtle: {
    intensity: 'low',
    palette: 'classic',
    cursorMode: 'trail',
    clickBursts: true,
    burnActiveWindow: false,
    screenBottomFire: false,
    sparks: false,
    audioSource: 'off',
    torch: false,
  },
  /** The fire dances to the music on the computer. */
  party: {
    intensity: 'high',
    palette: 'aurora',
    cursorMode: 'comet',
    clickBursts: true,
    burnActiveWindow: false,
    screenBottomFire: false,
    sparks: true,
    audioSource: 'system',
    audioStyle: 'eq',
    audioDrops: true,
    torch: false,
  },
  /** Everything burns, as hard as it can. */
  inferno: {
    intensity: 'inferno',
    palette: 'classic',
    cursorMode: 'comet',
    clickBursts: true,
    burnActiveWindow: true,
    screenBottomFire: true,
    sparks: true,
    torch: false,
  },
  /** Halloween: the screen goes dark and you find your way with a torch. */
  haunted: {
    intensity: 'medium',
    palette: 'ghost',
    cursorMode: 'halo',
    clickBursts: true,
    burnActiveWindow: false,
    screenBottomFire: false,
    sparks: true,
    audioSource: 'off',
    torch: true,
  },
});

export const SCENE_EMOJI: Readonly<Record<Scene, string>> = Object.freeze({
  classic: '🔥',
  hearth: '🪵',
  subtle: '✨',
  party: '🎵',
  inferno: '🌋',
  haunted: '🎃',
});

/** The patch a scene applies, reduced to what the current tier may use. */
export function scenePatch(scene: Scene, pro: boolean): Partial<Settings> {
  return stripLockedChoices({ ...SCENE_PATCHES[scene] }, pro) as Partial<Settings>;
}

/** True when the scene relies on something only Pro unlocks. */
export function sceneNeedsPro(scene: Scene): boolean {
  const full = SCENE_PATCHES[scene];
  return Object.keys(scenePatch(scene, false)).length !== Object.keys(full).length;
}

/** The scene the settings match exactly, if any. */
export function activeScene(settings: Settings): Scene | null {
  for (const scene of SCENES) {
    const patch = SCENE_PATCHES[scene] as Record<string, unknown>;
    if (Object.keys(patch).every((k) => (settings as unknown as Record<string, unknown>)[k] === patch[k])) return scene;
  }
  return null;
}

// ───────────────────────────── seasons ─────────────────────────────

export type SeasonalEvent = 'sumedru' | 'halloween' | 'winter';

export interface Season {
  event: SeasonalEvent;
  scene: Scene;
}

/**
 * The event around `date` (local time), if any:
 *   Focul lui Sumedru — 24–26 October (the bonfires of Saint Demetrius' eve);
 *   Halloween — 27 October – 1 November;
 *   winter fires — 20 December – 6 January.
 */
export function seasonAt(date: Date): Season | null {
  const m = date.getMonth() + 1;
  const d = date.getDate();
  if (m === 10 && d >= 24 && d <= 26) return { event: 'sumedru', scene: 'hearth' };
  if ((m === 10 && d >= 27) || (m === 11 && d === 1)) return { event: 'halloween', scene: 'haunted' };
  if ((m === 12 && d >= 20) || (m === 1 && d <= 6)) return { event: 'winter', scene: 'hearth' };
  return null;
}
