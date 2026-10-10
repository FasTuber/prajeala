/**
 * Tiny logger for the main process. Prints to stdout (debug/info) and stderr
 * (warn/error). Debug lines are only emitted after `setVerbose(true)`
 * (`--verbose` on the CLI).
 *
 * Format: `[+12345ms] [scope] message`.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const startedAt = Date.now();
let verbose = false;

export function setVerbose(value: boolean): void {
  verbose = value;
}

export function isVerbose(): boolean {
  return verbose;
}

function formatArg(arg: unknown): string {
  if (typeof arg === 'string') return arg;
  if (arg instanceof Error) return arg.stack ?? arg.message;
  try {
    return JSON.stringify(arg);
  } catch {
    return String(arg);
  }
}

function write(level: LogLevel, scope: string, args: unknown[]): void {
  if (level === 'debug' && !verbose) return;
  const elapsed = String(Date.now() - startedAt).padStart(6, ' ');
  const line = `[+${elapsed}ms] [${scope}]${level === 'warn' || level === 'error' ? ` ${level.toUpperCase()}:` : ''} ${args
    .map(formatArg)
    .join(' ')}\n`;
  if (level === 'warn' || level === 'error') process.stderr.write(line);
  else process.stdout.write(line);
}

export interface Logger {
  debug(...args: unknown[]): void;
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
  /** Log at an arbitrary level (used to relay renderer logs). */
  at(level: LogLevel, ...args: unknown[]): void;
}

export function createLogger(scope: string): Logger {
  return {
    debug: (...args) => write('debug', scope, args),
    info: (...args) => write('info', scope, args),
    warn: (...args) => write('warn', scope, args),
    error: (...args) => write('error', scope, args),
    at: (level, ...args) => write(level, scope, args),
  };
}

export const log = createLogger('prajeala');
