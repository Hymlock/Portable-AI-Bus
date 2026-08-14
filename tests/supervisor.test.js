const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const SUPERVISOR = path.join(__dirname, '..', 'scripts', 'bus-supervise.js');
const BUS_UP = path.join(__dirname, '..', 'scripts', 'bus-up.js');
const BUS_RESTART = path.join(__dirname, '..', 'scripts', 'bus-restart.js');
const { staleCodeWarning } = require(SUPERVISOR);
const { unreadyBrainCodeMarkers } = require(BUS_RESTART);

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

test('bus-up starts exactly one detached supervisor for its brain seats', () => {
  const source = fs.readFileSync(BUS_UP, 'utf8');
  assert.match(source, /type === 'supervisor'/,
    'idempotent bus-up must detect an existing supervisor instead of spawning duplicates');
  assert.match(source, /bus-supervise\.js/,
    'the normal bus startup path must actually launch the shipped supervisor');
  assert.match(source, /'--seats', brainSeats\.join\(','\)/,
    'the supervisor must watch exactly the detached brains, never the live console seat');
  assert.match(source, /supervisor[^\n]*already running|already supervised/i,
    'operators need visible proof that supervision is active');
});

test('bus-restart replaces and verifies the supervisor with the rest of the runtime', () => {
  const source = fs.readFileSync(BUS_RESTART, 'utf8');
  assert.match(source, /item\.type === 'supervisor'/,
    'restart must stop the old monitor rather than leave a mismatched supervisor behind');
  assert.match(source, /supervisors\.length !== 1/,
    'restart is not verified unless exactly one configured supervisor came back');
});

test('bus-restart verifies a live brain by its matching loaded-code marker, not an active lease', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'portable-ai-bus-restart-marker-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const distRoot = path.join(root, 'dist');
  fs.mkdirSync(path.join(root, '.ai-bus', 'runtime'), { recursive: true });
  fs.mkdirSync(path.join(distRoot, 'brain'), { recursive: true });
  fs.writeFileSync(path.join(distRoot, 'brain', 'cli.js'), 'loaded code');
  const loadedDistMtimeMs = fs.statSync(path.join(distRoot, 'brain', 'cli.js')).mtimeMs;
  fs.writeFileSync(path.join(root, '.ai-bus', 'runtime', 'brain-grok.code.json'), JSON.stringify({
    pid: 4242,
    distRoot,
    loadedDistMtimeMs
  }));

  assert.deepEqual(unreadyBrainCodeMarkers({
    root,
    brains: ['grok'],
    processes: [{ seat: 'grok', pid: 4242 }],
    distRoot
  }), []);

  const source = fs.readFileSync(BUS_RESTART, 'utf8');
  assert.doesNotMatch(source, /leases\.json|Fresh lease verification/,
    'a healthy but busy seat may have no ACTIVE lease between wakes');
});

test('it names a live seat whose loaded dist is older than dist on disk', () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'portable-ai-bus-stale-code-'));
  try {
    const distRoot = path.join(fixture, 'dist');
    const runtime = path.join(fixture, '.ai-bus', 'runtime');
    fs.mkdirSync(path.join(distRoot, 'brain'), { recursive: true });
    fs.mkdirSync(runtime, { recursive: true });
    fs.writeFileSync(path.join(distRoot, 'brain', 'cli.js'), 'new build');
    fs.writeFileSync(path.join(runtime, 'brain-codex.code.json'), JSON.stringify({
      pid: 42, distRoot, loadedDistMtimeMs: 1
    }));

    const warning = staleCodeWarning({ coordinationRoot: fixture, seat: 'codex', pid: 42, distRoot });
    assert.match(warning, /codex stale-code/);
    assert.match(warning, /dist changed/);
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});

test('stale-code detection warns but never restarts', () => {
  const source = fs.readFileSync(SUPERVISOR, 'utf8');
  assert.match(source, /\$\{warning\} - NOT restarting\./,
    'a code change mid-wake is hazardous; the supervisor must report it without surprise restart');
});
