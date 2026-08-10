#!/usr/bin/env node
/**
 * Run every brain as a child of ONE console window.
 *
 *   node scripts/bus-console.js --root "<bus root>" [--workdir "<repo>"] --brains codex,worker
 *
 * Why this exists, after a long evening of the alternative:
 *
 * A child console application INHERITS its parent's console and creates no window of its own.
 * A detached brain has no console to lend, so each model call could allocate one, and under
 * Windows 11 an allocated console is a window. Every structural attempt to suppress that from
 * the outside failed or half-failed — `windowsHide` is unreliable once detached,
 * `Start-Process -WindowStyle Hidden` still gets a console and hands it to Windows Terminal,
 * and switching the default host to conhost helped but did not end it.
 *
 * Hymlock: *"I'm fine with one open console if necessary."* That single sentence is worth more
 * than the whole suppression effort, because inheritance is a guarantee rather than a flag:
 * with a real console at the top, there is nothing left that CAN open a second window.
 *
 * The trade, stated plainly: closing this window kills the brains under it. That is the cost of
 * the guarantee, and it is visible rather than silent — which, on this project, is the better
 * failure. It also means you can watch the bus work instead of tailing a log.
 */

const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const REPO = path.resolve(__dirname, '..');
const DIST = fs.existsSync(path.join(REPO, 'dist', 'brain', 'cli.js'))
  ? path.join(REPO, 'dist')
  : path.join(REPO, 'bin');

function option(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 && index + 1 < process.argv.length ? process.argv[index + 1] : fallback;
}

const defaultRoot = path.basename(REPO) === '.ai-bus' ? path.dirname(REPO) : process.cwd();
const root = path.resolve(option('--root', defaultRoot));
const workdir = path.resolve(option('--workdir', root));
const seats = option('--brains', 'claude,codex,grok').split(',').map((s) => s.trim()).filter(Boolean);
const brainFile = path.resolve(option('--brain', path.join(REPO, 'brains', 'agent-seat.js')));

if (seats.length === 0) {
  console.error('usage: bus-console --root <bus root> --brains <seat,seat>');
  process.exit(2);
}

/** Same check as bus-up: never start a second brain for a seat that already has one. */
function alreadyRunning(seat) {
  if (process.platform !== 'win32') return false;
  const out = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command',
    `(Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -match 'brain[\\\\/]cli\\.js' -and $_.CommandLine -match '--seat ${seat}(\\s|$)' } | Measure-Object).Count`
  ], { encoding: 'utf8', windowsHide: true });
  if (out.status !== 0) return true;
  return Number((out.stdout || '0').trim()) > 0;
}

const children = [];

for (const seat of seats) {
  if (alreadyRunning(seat)) {
    console.log(`brain:${seat} already running elsewhere - not starting a second one`);
    continue;
  }
  // `stdio: 'inherit'` with NO windowsHide is the whole mechanism, and both halves matter.
  //
  // The first attempt set `windowsHide: true` here as well, which looked harmless and quietly
  // destroyed the point: Node maps it to CREATE_NO_WINDOW, meaning "this process gets no
  // console", and that beats the inherited handles. The brain ended up console-less anyway, so
  // the model process it spawned was console-less, so the `git` calls THAT made each allocated
  // one - and a shared-console run flashed exactly like a detached one.
  //
  // PORTABLE_AI_BUS_INHERIT_CONSOLE tells the providers the same thing, so the chain of
  // inheritance is unbroken from this window down to git.
  const child = spawn(process.execPath, [
    path.join(DIST, 'brain', 'cli.js'),
    '--root', root, '--workdir', workdir, '--seat', seat, '--brain', brainFile
  ], { stdio: 'inherit', env: { ...process.env, PORTABLE_AI_BUS_INHERIT_CONSOLE: '1' } });

  children.push({ seat, child });
  console.log(`brain:${seat} started pid ${child.pid} (child of this window)`);

  child.on('exit', (code, signal) => {
    console.log(`brain:${seat} EXITED code=${code} signal=${signal ?? 'none'}`);
  });
}

if (children.length === 0) {
  console.log('nothing to run - every requested seat already has a brain');
  process.exit(0);
}

console.log('');
console.log(`bus console: ${children.length} brain(s) attached to this window.`);
console.log('Closing this window stops them. Ctrl+C stops them cleanly.');
console.log('Brains continue after each wake; a clarification request leaves the goal open.');
console.log('');

function shutdown() {
  console.log('\nstopping brains...');
  for (const { seat, child } of children) {
    try { child.kill(); console.log(`  stopped ${seat}`); } catch { /* already gone */ }
  }
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
