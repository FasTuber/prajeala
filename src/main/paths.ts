/**
 * Path resolution for the ESM main bundle. There is no `__dirname` in ESM, so
 * everything next to the bundle (`dist/main/index.mjs`) is resolved from
 * `import.meta.url`, and repository-level assets from `app.getAppPath()`.
 */
import { app } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Directory containing the main bundle (`<app>/dist/main`). */
export const mainDir: string = path.dirname(fileURLToPath(import.meta.url));

/** Sandboxed CommonJS preload bundle. */
export const preloadPath: string = fileURLToPath(new URL('../preload/index.cjs', import.meta.url));

/** Overlay page copied by scripts/build.mjs. */
export const rendererHtmlPath: string = fileURLToPath(new URL('../renderer/index.html', import.meta.url));

/** Preload of the settings window (exposes `window.prajealaUi`). */
export const settingsPreloadPath: string = fileURLToPath(new URL('../preload/settings.cjs', import.meta.url));

/** Settings / Pro window page copied by scripts/build.mjs. */
export const settingsHtmlPath: string = fileURLToPath(new URL('../renderer/settings.html', import.meta.url));

/** Preload of the hidden media host window (exposes `window.prajealaMedia`). */
export const mediaPreloadPath: string = fileURLToPath(new URL('../preload/media.cjs', import.meta.url));

/** Media host page (audio capture + analysis) copied by scripts/build.mjs. */
export const mediaHtmlPath: string = fileURLToPath(new URL('../renderer/media.html', import.meta.url));

/** `<app>/assets` (works both unpacked and inside app.asar). */
export function assetsDir(): string {
  return path.join(app.getAppPath(), 'assets');
}

export function trayAssetPath(fileName: string): string {
  return path.join(assetsDir(), 'tray', fileName);
}

export function settingsFilePath(): string {
  return path.join(app.getPath('userData'), 'prajeala-settings.json');
}

export function licenseFilePath(): string {
  return path.join(app.getPath('userData'), 'prajeala-license.json');
}

/** Window icon for Windows/Linux (macOS uses the bundle icon). */
export function appIconPath(): string {
  return path.join(assetsDir(), 'icon-256.png');
}
