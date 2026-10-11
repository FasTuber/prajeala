/**
 * Imported themes live as JSON files in `<userData>/themes/<id>.json`. The
 * store lists them (validated, broken files skipped with a warning), imports
 * a file chosen by the user, exports any theme, and resolves the theme the
 * overlays should render with from the settings.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { THEME_ID_RE, type Settings } from '../shared/settings';
import { BUILTIN_THEMES, parseThemeJson, slugify, themeToJson, type ThemeDefinition } from '../shared/theme';
import { createLogger } from './log';

const log = createLogger('themes');

export interface ThemeImportResult {
  ok: boolean;
  theme?: ThemeDefinition;
  error?: string;
}

export class ThemeStore {
  constructor(
    readonly dir: string,
    private readonly persist = true,
  ) {}

  /** All importable themes on disk, sorted by name. Never throws. */
  list(): ThemeDefinition[] {
    if (!this.persist || !existsSync(this.dir)) return [];
    let files: string[];
    try {
      files = readdirSync(this.dir).filter((f) => f.toLowerCase().endsWith('.json'));
    } catch (err) {
      log.warn(`could not list ${this.dir}:`, err);
      return [];
    }
    const out: ThemeDefinition[] = [];
    for (const file of files) {
      const id = file.slice(0, -5);
      if (!THEME_ID_RE.test(id)) continue;
      const theme = this.read(id);
      if (theme) out.push(theme);
    }
    return out.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  }

  /** Reads one theme by id (the file name without .json); null when missing or invalid. */
  read(id: string): ThemeDefinition | null {
    if (!this.persist || !THEME_ID_RE.test(id)) return null;
    const file = path.join(this.dir, `${id}.json`);
    let text: string;
    try {
      text = readFileSync(file, 'utf8');
    } catch {
      return null;
    }
    const v = parseThemeJson(text, id);
    if (!v.ok) {
      log.warn(`${file}: ${v.error}`);
      return null;
    }
    // The file name is the id, whatever the JSON says.
    return { ...v.theme, id };
  }

  /** The theme the overlays should use for these settings. */
  resolve(settings: Settings): ThemeDefinition {
    if (settings.themeId) {
      const custom = this.read(settings.themeId);
      if (custom) return custom;
      log.debug(`theme "${settings.themeId}" not found; falling back to the ${settings.palette} palette`);
    }
    return BUILTIN_THEMES[settings.palette];
  }

  /** Copies a theme file into the themes folder (validated, id derived from name / file). */
  importFile(sourcePath: string): ThemeImportResult {
    let text: string;
    try {
      text = readFileSync(sourcePath, 'utf8');
    } catch (err) {
      return { ok: false, error: `could not read the file: ${(err as Error).message}` };
    }
    const fallbackId = slugify(path.basename(sourcePath, path.extname(sourcePath)));
    const v = parseThemeJson(text, fallbackId);
    if (!v.ok) return { ok: false, error: v.error };
    return this.save(v.theme);
  }

  /** Writes a theme into the folder under a unique id. */
  save(theme: ThemeDefinition): ThemeImportResult {
    if (!this.persist) return { ok: false, error: 'themes are not persisted in this mode' };
    try {
      mkdirSync(this.dir, { recursive: true });
      const baseId = THEME_ID_RE.test(theme.id) ? theme.id : slugify(theme.name) || 'theme';
      let id = baseId;
      // Built-in names are reserved; a clash with an existing custom file gets a suffix.
      for (let n = 2; id in BUILTIN_THEMES || existsSync(path.join(this.dir, `${id}.json`)); n++) {
        id = `${baseId.slice(0, 60)}-${n}`;
      }
      const saved: ThemeDefinition = { ...theme, id };
      writeFileSync(path.join(this.dir, `${id}.json`), themeToJson(saved), 'utf8');
      log.info(`imported theme "${saved.name}" as ${id}`);
      return { ok: true, theme: saved };
    } catch (err) {
      return { ok: false, error: `could not save the theme: ${(err as Error).message}` };
    }
  }

  /** Writes a theme to an arbitrary path (export). */
  exportTo(theme: ThemeDefinition, targetPath: string): ThemeImportResult {
    try {
      writeFileSync(targetPath, themeToJson(theme), 'utf8');
      log.info(`exported theme "${theme.name}" to ${targetPath}`);
      return { ok: true, theme };
    } catch (err) {
      return { ok: false, error: `could not write ${targetPath}: ${(err as Error).message}` };
    }
  }
}
