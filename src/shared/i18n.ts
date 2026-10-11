/**
 * UI strings for the tray and the settings window: Romanian when the OS locale
 * is Romanian, English otherwise. Pure module.
 */
import { PALETTE_DEFINITIONS } from './palettes';
import type { CursorMode, Intensity, Palette } from './settings';

export type Lang = 'ro' | 'en';

export function pickLang(locale: string | null | undefined): Lang {
  return /^ro\b/i.test(String(locale ?? '').trim()) ? 'ro' : 'en';
}

const en = {
  tagline: 'Fire on your screen, your apps and your cursor',
  tooltip: 'Prăjeală — fire on screen',
  paused: 'paused',
  pause: 'Pause',
  resume: 'Resume',
  fireOn: 'Fire on',
  intensity: 'Intensity',
  palette: 'Palette',
  cursorFire: 'Cursor fire',
  clickBursts: 'Click bursts',
  clickBurstsUnavailable: 'Click bursts (needs uiohook)',
  burnActiveWindow: 'Burn active window',
  burnActiveWindowUnavailable: 'Burn active window (needs get-windows)',
  screenBottomFire: 'Screen bottom fire',
  sparks: 'Sparks',
  debugHud: 'Debug HUD',
  fps: 'FPS',
  quality: 'Quality',
  pressureIterations: 'Pressure iterations',
  launchAtLogin: 'Launch at login',
  testBurst: 'Test burst',
  openSettingsWindow: 'Settings…',
  openSettingsFile: 'Open settings file',
  quit: 'Quit Prăjeală',
  sectionFire: 'Fire',
  sectionPerformance: 'Performance',
  sectionSystem: 'System',
  shortcuts: 'Shortcuts',
  lowerIsFaster: 'lower = faster',
  linuxNoLogin: 'Not available on Linux: add Prăjeală to your desktop autostart instead.',
  website: 'Website',
  sourceCode: 'Source code',
  supportProject: 'Support the project',
  // ── Pro ──
  pro: 'Pro',
  proLocked: '{label} — Pro',
  tierFree: 'Free',
  tierTrial: 'Pro trial · {days} d',
  tierPro: 'Pro',
  trayPro: 'Prăjeală Pro ✓',
  trayTrial: 'Pro trial — {days} days left',
  trayGetPro: 'Get Prăjeală Pro ({price})…',
  proTitle: 'Prăjeală Pro',
  proPrice: '{price} · one-time payment',
  proPitch: 'Unlock the whole fire.',
  proFeaturePalettes: '{count} palettes: Blue flame, Plasma, Aurora, Molten gold, Ghost fire…',
  proFeatureInferno: 'Inferno intensity',
  proFeatureMonitors: 'Fire on every monitor',
  proFeatureSupport: 'Every future Pro feature, and you keep an indie project alive',
  trialActive: 'You have every Pro feature for {days} more days — free.',
  trialOver: 'Your Pro trial has ended. Free features keep working forever.',
  buyPro: 'Buy Pro — {price}',
  haveKey: 'Already bought it? Paste your licence key:',
  keyPlaceholder: 'Licence key',
  activate: 'Activate',
  activating: 'Activating…',
  proActive: 'Prăjeală Pro is active — thank you!',
  licensedTo: 'Licensed to {name}',
  licenseKey: 'Key {key}',
  offlineKey: 'offline key',
  deactivate: 'Deactivate on this computer',
  deactivating: 'Deactivating…',
  manageOrder: 'Manage order',
  lockedHint: '{feature} is part of Prăjeală Pro.',
  lockedPalette: 'The {name} palette',
  lockedInferno: 'Inferno intensity',
  lockedMonitors: 'Fire on {count} monitors',
  usingFallback: 'Free version: showing {name} instead.',
  welcomeTitle: 'Welcome to Prăjeală!',
  welcomeBody:
    'The fire runs on top of every window and never gets in the way: clicks go straight through. Control it from the flame icon in the tray or with Ctrl+Shift+F.',
  welcomeTrial: 'Every Pro feature is unlocked for the next {days} days.',
  gotIt: 'Got it — let it burn',
  // licence result codes
  'code.activated': 'Prăjeală Pro is active. Thank you for supporting the project!',
  'code.deactivated': 'Licence removed from this computer.',
  'code.empty': 'Paste your licence key first.',
  'code.malformed': 'This does not look like a Prăjeală licence key.',
  'code.invalid': 'This licence key is not valid.',
  'code.wrong-product': 'This licence key belongs to a different product.',
  'code.limit': 'This key is already active on the maximum number of computers. Deactivate it on another one, or from “Manage order”.',
  'code.expired': 'This licence key has expired.',
  'code.disabled': 'This licence key has been disabled.',
  'code.network': 'Could not reach the licence server. Check your connection and try again.',
  'code.not-configured': 'This build cannot activate that kind of key yet.',
  'code.busy': 'Please wait, the previous request is still running.',
  'code.error': 'Something went wrong. Please try again.',
};

export type StringKey = keyof typeof en;

const ro: Record<StringKey, string> = {
  tagline: 'Foc pe ecran, pe aplicații și pe cursor',
  tooltip: 'Prăjeală — foc pe ecran',
  paused: 'în pauză',
  pause: 'Pauză',
  resume: 'Reluare',
  fireOn: 'Foc pornit',
  intensity: 'Intensitate',
  palette: 'Paletă',
  cursorFire: 'Foc pe cursor',
  clickBursts: 'Explozii la click',
  clickBurstsUnavailable: 'Explozii la click (necesită uiohook)',
  burnActiveWindow: 'Foc pe fereastra activă',
  burnActiveWindowUnavailable: 'Foc pe fereastra activă (necesită get-windows)',
  screenBottomFire: 'Foc la baza ecranului',
  sparks: 'Scântei',
  debugHud: 'HUD de debug',
  fps: 'FPS',
  quality: 'Calitate',
  pressureIterations: 'Iterații presiune',
  launchAtLogin: 'Pornire la login',
  testBurst: 'Test explozie',
  openSettingsWindow: 'Setări…',
  openSettingsFile: 'Deschide fișierul de setări',
  quit: 'Ieșire din Prăjeală',
  sectionFire: 'Foc',
  sectionPerformance: 'Performanță',
  sectionSystem: 'Sistem',
  shortcuts: 'Scurtături',
  lowerIsFaster: 'mai mic = mai rapid',
  linuxNoLogin: 'Indisponibil pe Linux: adaugă Prăjeală în autostart-ul desktopului.',
  website: 'Site',
  sourceCode: 'Cod sursă',
  supportProject: 'Susține proiectul',
  pro: 'Pro',
  proLocked: '{label} — Pro',
  tierFree: 'Gratuit',
  tierTrial: 'Probă Pro · {days} z',
  tierPro: 'Pro',
  trayPro: 'Prăjeală Pro ✓',
  trayTrial: 'Probă Pro — mai ai {days} zile',
  trayGetPro: 'Ia Prăjeală Pro ({price})…',
  proTitle: 'Prăjeală Pro',
  proPrice: '{price} · plată unică',
  proPitch: 'Deblochează tot focul.',
  proFeaturePalettes: '{count} palete: Flacără albastră, Plasmă, Aurora, Aur topit, Foc fantomă…',
  proFeatureInferno: 'Intensitatea Inferno',
  proFeatureMonitors: 'Foc pe toate monitoarele',
  proFeatureSupport: 'Toate funcțiile Pro viitoare — și ții în viață un proiect independent',
  trialActive: 'Ai toate funcțiile Pro încă {days} zile, gratuit.',
  trialOver: 'Perioada de probă Pro s-a încheiat. Funcțiile gratuite merg în continuare, pentru totdeauna.',
  buyPro: 'Cumpără Pro — {price}',
  haveKey: 'L-ai cumpărat deja? Lipește cheia de licență:',
  keyPlaceholder: 'Cheie de licență',
  activate: 'Activează',
  activating: 'Se activează…',
  proActive: 'Prăjeală Pro e activ — mulțumim!',
  licensedTo: 'Licență pe numele {name}',
  licenseKey: 'Cheia {key}',
  offlineKey: 'cheie offline',
  deactivate: 'Dezactivează pe acest calculator',
  deactivating: 'Se dezactivează…',
  manageOrder: 'Gestionează comanda',
  lockedHint: '{feature} face parte din Prăjeală Pro.',
  lockedPalette: 'Paleta {name}',
  lockedInferno: 'Intensitatea Inferno',
  lockedMonitors: 'Focul pe {count} monitoare',
  usingFallback: 'Versiunea gratuită: se folosește {name}.',
  welcomeTitle: 'Bine ai venit în Prăjeală!',
  welcomeBody:
    'Focul rulează peste toate ferestrele și nu te încurcă: click-urile trec prin el. Îl controlezi din iconița cu flacără din tray sau cu Ctrl+Shift+F.',
  welcomeTrial: 'Toate funcțiile Pro sunt deblocate în următoarele {days} zile.',
  gotIt: 'Am înțeles — să ardă!',
  'code.activated': 'Prăjeală Pro e activ. Mulțumim că susții proiectul!',
  'code.deactivated': 'Licența a fost scoasă de pe acest calculator.',
  'code.empty': 'Lipește întâi cheia de licență.',
  'code.malformed': 'Asta nu pare o cheie de licență Prăjeală.',
  'code.invalid': 'Cheia de licență nu e validă.',
  'code.wrong-product': 'Cheia aparține altui produs.',
  'code.limit': 'Cheia e deja activă pe numărul maxim de calculatoare. Dezactiveaz-o pe unul dintre ele sau din „Gestionează comanda”.',
  'code.expired': 'Cheia de licență a expirat.',
  'code.disabled': 'Cheia de licență a fost dezactivată.',
  'code.network': 'Serverul de licențe nu răspunde. Verifică conexiunea și încearcă din nou.',
  'code.not-configured': 'Această versiune nu poate încă activa acest tip de cheie.',
  'code.busy': 'Așteaptă puțin, cererea anterioară încă rulează.',
  'code.error': 'Ceva n-a mers. Încearcă din nou.',
};

export const STRINGS: Readonly<Record<Lang, Readonly<Record<StringKey, string>>>> = Object.freeze({ en, ro });

export type Translate = (key: StringKey, vars?: Record<string, string | number>) => string;

export function translator(lang: Lang): Translate {
  const table = STRINGS[lang];
  return (key, vars) => {
    const text = table[key] ?? STRINGS.en[key] ?? key;
    return vars ? text.replace(/\{(\w+)\}/g, (m, name: string) => (name in vars ? String(vars[name]) : m)) : text;
  };
}

export const INTENSITY_LABELS: Readonly<Record<Lang, Record<Intensity, string>>> = Object.freeze({
  en: { low: 'Low', medium: 'Medium', high: 'High', inferno: 'Inferno' },
  ro: { low: 'Mică', medium: 'Medie', high: 'Mare', inferno: 'Inferno' },
});

export const CURSOR_LABELS: Readonly<Record<Lang, Record<CursorMode, string>>> = Object.freeze({
  en: { off: 'Off', halo: 'Halo', trail: 'Trail', comet: 'Comet' },
  ro: { off: 'Oprit', halo: 'Aură', trail: 'Dâră', comet: 'Cometă' },
});

export const PALETTE_LABELS_RO: Readonly<Record<Palette, string>> = Object.freeze({
  classic: 'Foc clasic',
  ember: 'Jar',
  blue: 'Flacără albastră',
  green: 'Foc verde',
  plasma: 'Plasmă',
  aurora: 'Aurora',
  gold: 'Aur topit',
  ghost: 'Foc fantomă',
});

export function paletteLabel(lang: Lang, palette: Palette): string {
  return lang === 'ro' ? PALETTE_LABELS_RO[palette] : PALETTE_DEFINITIONS[palette].label;
}

export const QUALITY_PRESETS: ReadonlyArray<{ key: 'low' | 'medium' | 'high' | 'ultra'; simScale: number }> = Object.freeze([
  { key: 'low', simScale: 0.15 },
  { key: 'medium', simScale: 0.25 },
  { key: 'high', simScale: 0.4 },
  { key: 'ultra', simScale: 0.6 },
]);

export const QUALITY_LABELS: Readonly<Record<Lang, Record<(typeof QUALITY_PRESETS)[number]['key'], string>>> = Object.freeze({
  en: { low: 'Low', medium: 'Medium', high: 'High', ultra: 'Ultra' },
  ro: { low: 'Scăzută', medium: 'Medie', high: 'Ridicată', ultra: 'Ultra' },
});
