#!/usr/bin/env node
// Smoke test runner: launches the built app in `--smoke` mode and turns the
// `PRAJEALA_SMOKE_RESULT {json}` line printed by the main process into
// smoke-report.json plus a short human summary.
//
//   node scripts/smoke.mjs                      90 frames, 120 s timeout
//   node scripts/smoke.mjs --frames=30 --timeout=60
//   node scripts/smoke.mjs --keep --debug-hud   launch normally (no --smoke, no timeout) and leave it running
//   node scripts/smoke.mjs -- --display=1       anything we do not understand is passed through to the app
//
// Environment:
//   ELECTRON_BIN   path to an Electron executable (default: the one from node_modules)
//   DISPLAY        when unset and xvfb-run is available, the app runs inside Xvfb with --software-gl
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const RESULT_PREFIX = 'PRAJEALA_SMOKE_RESULT ';
const REPORT_FILE = resolve(root, 'smoke-report.json');

// ───────────────────────────── arguments ─────────────────────────────
let frames = 90;
let timeoutSec = 120;
let keep = false;
const passthrough = [];
for (const arg of process.argv.slice(2)) {
  let m;
  if ((m = /^--(?:smoke-)?frames=(\d+)$/.exec(arg))) frames = Number(m[1]);
  else if ((m = /^--timeout=(\d+(?:\.\d+)?)$/.exec(arg))) timeoutSec = Number(m[1]);
  else if (arg === '--keep') keep = true;
  else if (arg === '--') continue;
  else passthrough.push(arg);
}

// ───────────────────────────── command line ─────────────────────────────
function resolveElectron() {
  if (process.env.ELECTRON_BIN) return process.env.ELECTRON_BIN;
  try {
    // The `electron` package exports the path of the executable it downloaded.
    return createRequire(import.meta.url)('electron');
  } catch {
    return resolve(root, 'node_modules', '.bin', process.platform === 'win32' ? 'electron.cmd' : 'electron');
  }
}

function hasXvfbRun() {
  if (process.platform === 'win32') return false;
  const probe = spawnSync('xvfb-run', ['--help'], { stdio: 'ignore' });
  return !probe.error;
}

if (!existsSync(resolve(root, 'dist/main/index.mjs'))) {
  console.error('[smoke] dist/main/index.mjs is missing — run `npm run build` first (or `npm run smoke`).');
  process.exit(1);
}

const electronBin = resolveElectron();
const headless = !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY && hasXvfbRun();
const appArgs = ['.'];
if (!keep) appArgs.push('--smoke', `--smoke-frames=${frames}`);
appArgs.push('--no-sandbox');
if (headless && !passthrough.includes('--software-gl')) appArgs.push('--software-gl');
appArgs.push(...passthrough);

let command = electronBin;
let args = appArgs;
if (headless) {
  command = 'xvfb-run';
  args = ['-a', '-s', '-screen 0 1280x800x24', electronBin, ...appArgs];
}

console.log(`[smoke] ${headless ? 'headless (Xvfb) ' : ''}${keep ? 'keep-alive ' : ''}launch: ${[command, ...args].join(' ')}`);
if (!keep) console.log(`[smoke] waiting for "${RESULT_PREFIX.trim()}" (frames=${frames}, timeout=${timeoutSec}s)`);

// ───────────────────────────── process ─────────────────────────────
const child = spawn(command, args, {
  cwd: root,
  env: { ...process.env, ELECTRON_ENABLE_LOGGING: process.env.ELECTRON_ENABLE_LOGGING ?? '1' },
  stdio: ['ignore', 'pipe', 'inherit'],
  // Own process group on POSIX so a timeout can take down xvfb-run + Xvfb + Electron together.
  detached: process.platform !== 'win32',
  shell: process.platform === 'win32' && command.endsWith('.cmd'),
});

let result = null;
let resultLine = null;
let timedOut = false;
let interrupted = false;
let killTimer = null;
let stdoutBuffer = '';

function killTree(signal = 'SIGTERM') {
  if (child.exitCode !== null || child.signalCode !== null) return;
  try {
    if (process.platform !== 'win32') process.kill(-child.pid, signal);
    else child.kill();
  } catch {
    try {
      child.kill(signal);
    } catch {
      /* already gone */
    }
  }
}

function handleLine(line) {
  process.stdout.write(line + '\n');
  if (!line.startsWith(RESULT_PREFIX)) return;
  resultLine = line.slice(RESULT_PREFIX.length).trim();
  try {
    result = JSON.parse(resultLine);
  } catch (err) {
    console.error(`[smoke] result line is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
    result = { ok: false, error: 'unparseable result line', raw: resultLine };
  }
}

child.stdout.setEncoding('utf8');
child.stdout.on('data', (chunk) => {
  stdoutBuffer += chunk;
  let nl;
  while ((nl = stdoutBuffer.indexOf('\n')) >= 0) {
    handleLine(stdoutBuffer.slice(0, nl).replace(/\r$/, ''));
    stdoutBuffer = stdoutBuffer.slice(nl + 1);
  }
});

const timer = keep
  ? null
  : setTimeout(() => {
      timedOut = true;
      console.error(`\n[smoke] TIMEOUT: no "${RESULT_PREFIX.trim()}" line within ${timeoutSec}s — killing the app.`);
      killTree('SIGTERM');
      killTimer = setTimeout(() => killTree('SIGKILL'), 3000);
    }, timeoutSec * 1000);

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    interrupted = true;
    console.error(`\n[smoke] received ${sig}, stopping the app.`);
    killTree('SIGTERM');
    setTimeout(() => process.exit(130), 2000).unref();
  });
}

child.on('error', (err) => {
  console.error(`[smoke] failed to launch ${command}: ${err.message}`);
  process.exit(1);
});

// ───────────────────────────── report ─────────────────────────────
const fmt = (v) => (v === undefined || v === null ? 'n/a' : typeof v === 'object' ? JSON.stringify(v) : String(v));

/** Pulls the headline numbers out of whatever shape the main process reports. */
function summarize(r) {
  const displays = Array.isArray(r.displays) ? r.displays : [];
  const first = displays[0] ?? {};
  const ready = r.ready ?? first.ready ?? first;
  const stats = r.stats ?? first.stats ?? first;
  const pick = (...candidates) => candidates.find((v) => v !== undefined && v !== null);
  return {
    ok: r.ok,
    displays: pick(typeof r.displays === 'number' ? r.displays : undefined, displays.length || undefined, r.displayCount),
    webgl2: pick(r.webgl2, ready.webgl2),
    floatTextures: pick(r.floatTextures, ready.floatTextures),
    renderer: pick(r.renderer, ready.renderer),
    frames: pick(r.frames, stats.frames),
    fps: pick(r.fps, stats.fps),
    sim: pick(
      r.simWidth !== undefined ? `${r.simWidth}×${r.simHeight}` : undefined,
      ready.simWidth !== undefined ? `${ready.simWidth}×${ready.simHeight}` : undefined,
    ),
    error: pick(r.error, ready.error, first.error),
  };
}

child.on('exit', (code, signal) => {
  if (timer) clearTimeout(timer);
  if (killTimer) clearTimeout(killTimer);
  if (stdoutBuffer.length) handleLine(stdoutBuffer);

  if (result) {
    writeFileSync(REPORT_FILE, JSON.stringify(result, null, 2) + '\n');
    const s = summarize(result);
    console.log('\n[smoke] ───────────── summary ─────────────');
    console.log(`  ok             ${fmt(s.ok)}`);
    console.log(`  displays       ${fmt(s.displays)}`);
    console.log(`  webgl2         ${fmt(s.webgl2)}`);
    console.log(`  floatTextures  ${fmt(s.floatTextures)}`);
    console.log(`  renderer       ${fmt(s.renderer)}`);
    console.log(`  sim            ${fmt(s.sim)}`);
    console.log(`  frames         ${fmt(s.frames)}`);
    console.log(`  fps            ${fmt(typeof s.fps === 'number' ? s.fps.toFixed(1) : s.fps)}`);
    if (s.error) console.log(`  error          ${fmt(s.error)}`);
    console.log(`  report         ${REPORT_FILE}`);
  }

  if (timedOut) {
    console.error(`[smoke] FAILED: timed out after ${timeoutSec}s without a result line.`);
    process.exit(1);
  }
  if (interrupted) {
    console.error('[smoke] stopped by user.');
    process.exit(130);
  }
  if (signal) {
    console.error(`[smoke] FAILED: the app was terminated by ${signal}.`);
    process.exit(1);
  }
  if (!keep && !result) {
    console.error(`[smoke] FAILED: the app exited with code ${code} without printing a "${RESULT_PREFIX.trim()}" line.`);
    process.exit(1);
  }
  if (result && result.ok === false) {
    console.error(`[smoke] FAILED: the app reported ok=false${result.error ? ` (${result.error})` : ''}.`);
    process.exit(1);
  }
  if (code !== 0) {
    console.error(`[smoke] FAILED: the app exited with code ${code}.`);
    process.exit(code ?? 1);
  }
  console.log(`[smoke] ${result ? 'PASSED' : 'app exited cleanly'}.`);
  process.exit(0);
});
