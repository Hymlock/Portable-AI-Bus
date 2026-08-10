const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const SUPERVISOR = path.join(__dirname, '..', 'scripts', 'bus-supervise.js');

/**
 * The supervisor closes the one hole the architecture has admitted since day one: the runner
 * survives a brain that throws, but not its own process being killed, and a dead seat is
 * indistinguishable from a quiet one.
 *
 * These tests exercise the script's contract without spawning real model brains - the sweep
 * logic and its refusals are the parts that can be wrong in a way nobody notices.
 */

test('the supervisor script is syntactically valid and self-describing', () => {
  // A supervisor that fails to parse is worse than none: it exits instantly and the bus looks
  // supervised. `--check` parses without executing.
  execFileSync(process.execPath, ['--check', SUPERVISOR], { encoding: 'utf8' });

  const source = fs.readFileSync(SUPERVISOR, 'utf8');
  assert.match(source, /max-restarts/,
    'an unbounded restart loop turns a crashing brain into a token fire that looks healthy');
  assert.match(source, /assuming all seats live/,
    'an unreadable process list must fail CLOSED, or the supervisor becomes the outage');
});

test('it is registered as a shipped binary and included in the package', () => {
  // A bin entry pointing at a file the package omits fails only on someone else's machine.
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  assert.equal(pkg.bin['bus-supervise'], 'scripts/bus-supervise.js');
  assert.ok(pkg.files.includes('scripts/bus-supervise.js'),
    'the supervisor must ship, or `bus-supervise` resolves to nothing after install');
});

test('every bin entry points at a file that exists', () => {
  // The defect this whole entry fixes: the CLI did all the work and had no bin at all, so
  // `npm i -g` produced nothing runnable. Pointing at missing files would repeat it quietly.
  const repo = path.join(__dirname, '..');
  const pkg = JSON.parse(fs.readFileSync(path.join(repo, 'package.json'), 'utf8'));
  for (const [name, rel] of Object.entries(pkg.bin)) {
    assert.ok(fs.existsSync(path.join(repo, rel)), `bin "${name}" points at missing ${rel}`);
  }
});

test('it refuses to restart a seat past its limit, and says a human is needed', () => {
  const source = fs.readFileSync(SUPERVISOR, 'utf8');
  assert.match(source, /NOT restarting\. Needs a human\./,
    'giving up must be stated out loud - a supervisor that silently stops trying is a lie');
});

test('a dead seat is restarted with the SAME root and workdir it was given', () => {
  // Restarting a brain against the wrong workdir would hand it a different repository than the
  // one it was coordinating - a subtle wrong-answer failure rather than a visible crash.
  const source = fs.readFileSync(SUPERVISOR, 'utf8');
  assert.match(source, /'--root', root, '--seat', seat, '--brain', brainFile, '--workdir', workdir/,
    'the supervisor must reproduce the original launch arguments exactly');
});
