/**
 * Maps a uiohook keycode onto a coarse KeyKind. This is the ONLY thing the
 * main process derives from a keystroke: the code itself is never stored,
 * logged or sent to a renderer, so the overlay cannot tell what was typed —
 * only that a letter, a space, Enter, Backspace, a modifier or a navigation
 * key was pressed. Pure module (uiohook's constants are mirrored here so the
 * optional dependency is never needed for type-checking or tests).
 */
import type { KeyKind } from '../shared/ipc';

// Scan codes as reported by uiohook-napi (libuiohook): see UiohookKey in its typings.
const K = {
  Escape: 1,
  Backspace: 14,
  Tab: 15,
  Enter: 28,
  Ctrl: 29,
  Shift: 42,
  ShiftRight: 54,
  Space: 57,
  Alt: 56,
  CapsLock: 58,
  NumLock: 69,
  ScrollLock: 70,
  F1: 59,
  F10: 68,
  F11: 87,
  F12: 88,
  NumpadEnter: 0x0e00 | 0x001c,
  CtrlRight: 3613,
  PrintScreen: 3639,
  AltRight: 3640,
  Home: 3655,
  PageUp: 3657,
  End: 3663,
  PageDown: 3665,
  Insert: 3666,
  Delete: 3667,
  Meta: 3675,
  MetaRight: 3676,
  ArrowUp: 0xe048,
  ArrowLeft: 0xe04b,
  ArrowRight: 0xe04d,
  ArrowDown: 0xe050,
} as const;

const MODIFIERS = new Set<number>([K.Ctrl, K.CtrlRight, K.Shift, K.ShiftRight, K.Alt, K.AltRight, K.Meta, K.MetaRight, K.CapsLock, K.NumLock, K.ScrollLock]);
const NAVIGATION = new Set<number>([K.ArrowUp, K.ArrowDown, K.ArrowLeft, K.ArrowRight, K.Home, K.End, K.PageUp, K.PageDown, K.Insert, K.Tab, K.Escape]);
/** Numpad variants of the navigation keys share the low byte with a 0xEE00 prefix. */
const NUMPAD_NAV_PREFIX = 0xee00;
const NUMPAD_NAV_LOW = new Set<number>([0x47, 0x48, 0x49, 0x4b, 0x4d, 0x4f, 0x50, 0x51, 0x52]);

export function classifyKeycode(keycode: unknown): KeyKind {
  if (typeof keycode !== 'number' || !Number.isFinite(keycode)) return 'other';
  const code = keycode | 0;
  if (code === K.Space) return 'space';
  if (code === K.Enter || code === K.NumpadEnter) return 'enter';
  if (code === K.Backspace || code === K.Delete) return 'backspace';
  if (MODIFIERS.has(code)) return 'modifier';
  if (NAVIGATION.has(code)) return 'navigation';
  if ((code & 0xff00) === NUMPAD_NAV_PREFIX && NUMPAD_NAV_LOW.has(code & 0xff)) return 'navigation';
  if ((code >= K.F1 && code <= K.F10) || code === K.F11 || code === K.F12 || code === K.PrintScreen) return 'other';
  // Letters, digits, punctuation, numpad digits…: everything else is "a character".
  return 'char';
}

/** Browser `KeyboardEvent.key` → KeyKind (used by the in-page mock). */
export function classifyDomKey(key: string): KeyKind {
  switch (key) {
    case ' ':
    case 'Spacebar':
      return 'space';
    case 'Enter':
      return 'enter';
    case 'Backspace':
    case 'Delete':
      return 'backspace';
    case 'Shift':
    case 'Control':
    case 'Alt':
    case 'Meta':
    case 'CapsLock':
    case 'NumLock':
    case 'ScrollLock':
    case 'AltGraph':
    case 'Fn':
      return 'modifier';
    case 'ArrowUp':
    case 'ArrowDown':
    case 'ArrowLeft':
    case 'ArrowRight':
    case 'Home':
    case 'End':
    case 'PageUp':
    case 'PageDown':
    case 'Insert':
    case 'Tab':
    case 'Escape':
      return 'navigation';
    default:
      return key.length === 1 ? 'char' : 'other';
  }
}
