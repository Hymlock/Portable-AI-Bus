#!/usr/bin/env node
/**
 * Check what you are about to commit against your claims.
 *
 *   node scripts/claim-guard-cli.js --root "<bus root>" --seat claude
 *   node scripts/claim-guard-cli.js --root "<bus root>" --seat claude --install-hook
 *
 * `--install-hook` writes a pre-commit hook so the check runs whether or not anyone remembers
 * it. A guard that depends on being invoked is a guard that fails on the day it matters — and
 * this project has proved that repeatedly.
 *
 * Exit 0 clean, 1 refused, 2 misuse.
 */

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const { guardStagedPaths, formatGuardResult } = require(path.join(__dirname, '..', 'dist', 'claim-guard.js'));

function option(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : fallback;
}

const seat = option('--seat', process.env.BUS_SEAT);
const root = option('--root', process.env.BUS_ROOT);
const repo = option('--repo', process.cwd());

if (!seat || !root) {
  console.error('usage: claim-guard-cli --root <bus root> --seat <seat> [--repo <git repo>] [--install-hook]');
  console.error('  or set BUS_SEAT and BUS_ROOT');
  process.exit(2);
}

if (process.argv.includes('--install-hook')) {
  const hooksDir = path.join(repo, '.git', 'hooks');
  fs.mkdirSync(hooksDir, { recursive: true });
  const hook = path.join(hooksDir, 'pre-commit');
  const body = [
    '#!/bin/sh',
    '# Installed by Portable AI Bus. Refuses a commit containing another seat\'s files.',
    '# BUS_SEAT names the assignment used for this commit. It must be supplied by the caller.',
    `BUS_ROOT="${root}" node "${path.join(__dirname, 'claim-guard-cli.js').replace(/\\/g, '/')}" --repo "$(pwd)" || exit 1`,
    ''
  ].join('\n');
  fs.writeFileSync(hook, body, { mode: 0o755 });
  console.log('claim-guard: pre-commit hook installed (set BUS_SEAT to the active assignment)');
  console.log(`             ${hook}`);
  process.exit(0);
}

let staged = [];
try {
  staged = execFileSync('git', ['diff', '--cached', '--name-only'], { cwd: repo, encoding: 'utf8' })
    .split('\n').map((s) => s.trim()).filter(Boolean);
} catch (error) {
  console.error(`claim-guard: could not read the index: ${error.message}`);
  process.exit(2);
}

if (staged.length === 0) {
  console.log('claim-guard: nothing staged');
  process.exit(0);
}

let claims = {};
try {
  const statePath = path.join(root, '.ai-bus', 'runtime', 'mailbox', 'state.json');
  claims = JSON.parse(fs.readFileSync(statePath, 'utf8')).claims ?? {};
} catch {
  // No mailbox means no claims to check against. Passing is the honest outcome: this guard
  // exists for a SHARED worktree, and a missing bus is evidence there is not one.
  console.log('claim-guard: no mailbox state found; skipping (not a shared worktree)');
  process.exit(0);
}

const result = guardStagedPaths(seat, staged, claims);
console.log(formatGuardResult(seat, result));
if (!result.ok) process.exit(1);

/**
 * Item 15: the guard verified CLAIMS and not BUILDS.
 *
 * Measured 2026-08-15: c772aa5 changed acknowledge()'s signature in runner.ts without updating
 * bus-client.ts, and landed with this hook ACTIVE and reporting success. `npm test` then exited
 * 2 before running a single test, and HEAD stayed broken for twenty-five minutes while another
 * seat worked on top of it, with every unrelated failure hidden behind the compile error.
 *
 * The hook answered "is this yours to commit?" and nothing answered "does this work?".
 *
 * Deliberately compile-only, not the full suite. Item 6 spent a whole session proving that a
 * guard which cannot be SATISFIED gets bypassed exactly as surely as one that cannot go RED, so
 * the green case - an honest commit stays fast - is load-bearing. tsc is seconds; the suite is
 * forty and would push seats toward --no-verify, which is the failure this is meant to prevent.
 *
 * The escape hatch is explicit and LOGGED rather than achieved by disabling the hook.
 */
if (process.env.BUS_ALLOW_BROKEN_BUILD === '1') {
  console.log('claim-guard: BUS_ALLOW_BROKEN_BUILD=1 - compile check SKIPPED for this commit');
  console.log('             deliberate WIP. Say so in the commit message.');
  process.exit(0);
}

const tsconfig = path.join(repo, 'tsconfig.json');
if (!fs.existsSync(tsconfig)) process.exit(0);

const tscCandidates = [
  path.join(repo, 'node_modules', '.bin', process.platform === 'win32' ? 'tsc.cmd' : 'tsc'),
  path.join(repo, 'node_modules', 'typescript', 'bin', 'tsc')
];
const tsc = tscCandidates.find((candidate) => fs.existsSync(candidate));
if (!tsc) {
  // No compiler is not a broken build. Refusing here would be the unsatisfiable-guard trap:
  // on 2026-08-15 an npm install wiped node_modules/.bin and tsc vanished for two hours.
  console.log('claim-guard: no local tsc found; compile check skipped');
  process.exit(0);
}

try {
  const isCmd = tsc.endsWith('.cmd');
  execFileSync(isCmd ? process.env.ComSpec || 'cmd.exe' : process.execPath,
    isCmd ? ['/c', tsc, '-p', repo, '--noEmit'] : [tsc, '-p', repo, '--noEmit'],
    { cwd: repo, encoding: 'utf8', stdio: 'pipe' });
  console.log('claim-guard: compile OK');
  process.exit(0);
} catch (error) {
  const detail = `${error.stdout || ''}${error.stderr || ''}`.trim().split('\n').slice(0, 6).join('\n');
  console.error('claim-guard: REFUSING - this commit does not compile.\n');
  console.error(detail || error.message);
  console.error('\nA commit that does not build blocks every other seat and hides every other');
  console.error('failure behind it. Fix it, or commit deliberately with BUS_ALLOW_BROKEN_BUILD=1');
  console.error('and say so in the message.');
  process.exit(1);
}
