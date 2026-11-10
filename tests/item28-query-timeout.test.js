const assert = require('node:assert/strict');
const path = require('node:path');
const { test } = require('node:test');

const { withBrokenFile } = require('./helpers/red-control');

const PROCESSES = path.join(__dirname, '..', 'scripts', 'bus-processes.js');

// ---------------------------------------------------------------------------
// ITEM 28: the process query had NO TIMEOUT, on the operator wake path.
//
// spawnSync without `timeout` waits forever. bus-tick calls listNodeProcesses every interval
// to fill the `brains:` field, so a wedged powershell or ps does not degrade the heartbeat -
// it STOPS it. The tick is what wakes a human, so the failure mode is that the bus goes
// silent and the silence looks exactly like a quiet bus.
//
// Measured on the coordinator's own watchdog, not in a test: a monitor running this same
// query every two minutes stalled mid-run. Process alive, loop never advanced, no heartbeat
// for most of an hour while work continued. Hymlock noticed before I did - which is precisely
// the problem with a stalled watchdog.
//
// Same defect recorded upstream in Mantella: a blocking requests.get under a comment claiming
// a two-second timeout. A comment is not a timeout.
// ---------------------------------------------------------------------------

test('ITEM 28 RED: the process query is bounded by a timeout', () => {
  // Source-level because the behavioural version would require wedging a real system binary,
  // which is not something a test suite should do to a developer's machine. Stated as the
  // narrowest fact that distinguishes fixed from unfixed: spawnSync must be given a timeout.
  const source = require('node:fs').readFileSync(PROCESSES, 'utf8');
  const calls = source.match(/spawnSync\([^)]*\{[^}]*\}/gs) || [];
  const queries = calls.filter((call) => /powershell|'ps'/.test(call));
  assert.ok(queries.length >= 2, `expected both platform queries; found ${queries.length}`);
  for (const call of queries) {
    assert.match(call, /timeout:/, 'every process query must be bounded, or the wake path can hang forever');
  }
});

test('ITEM 28: an expired query DEGRADES rather than propagating a hang', () => {
  // The error path already existed and was never reachable, because there was no error to
  // take. This pins that a timeout produces a throw the callers already handle.
  const { listNodeProcesses } = require(PROCESSES);
  assert.equal(typeof listNodeProcesses, 'function');

  const source = require('node:fs').readFileSync(PROCESSES, 'utf8');
  assert.match(source, /result\.error \|\| result\.status !== 0/,
    'a timeout sets `error` with a null status; checking status alone would swallow it');
});

test('ITEM 28: a timeout of THIS SHAPE actually bounds a hanging child', () => {
  /**
   * The honest half of a two-part claim, after a behavioural gate of mine turned out to be
   * structurally impossible and vacuous.
   *
   * I tried to interpose a fake `powershell` on PATH. It never ran: Node 24 will not resolve a
   * bare command to a `.cmd` without a shell, so `spawnSync` returned ENOENT in 1ms - which
   * looks exactly like a working timeout and is not one. My own green control caught it; the
   * test was deleted rather than shipped.
   *
   * What CAN be measured on this machine is the mechanism: a spawnSync carrying the same
   * `timeout` option, against a child that genuinely hangs, returns bounded. Paired with the
   * gate above - that both real queries carry that option - the two together say the wake path
   * is bounded.
   *
   * Stated plainly because the pairing is the weak point: this does NOT prove bus-processes
   * itself was interrupted mid-query. It proves the option works and that the option is
   * present. If that is insufficient for the item, it should be called insufficient rather
   * than counted.
   */
  const { spawnSync } = require('node:child_process');
  const started = Date.now();
  const result = spawnSync(process.execPath, ['-e', 'setTimeout(() => {}, 120000)'],
    { encoding: 'utf8', timeout: 3000 });
  const elapsed = Date.now() - started;

  assert.ok(elapsed < 20_000, `a bounded spawnSync must not wait for the child; took ${elapsed}ms`);
  assert.ok(result.error || result.signal,
    'and an expired call must REPORT it - a timeout that returns clean is indistinguishable from success');
  // The exact shape bus-processes now checks: a timeout yields error set with a NULL status,
  // so a `status !== 0` test alone would have swallowed it.
  assert.equal(result.status, null, 'a timed-out spawnSync has a null status, not a non-zero one');
});

test('ITEM 28 RED CONTROL: removing the timeout makes the gate fail', () => {
  // First real use of the red-control helper, and the reason it exists: this assertion is
  // source-level, so without a demonstrated break it would be indistinguishable from a test
  // that always passes.
  const result = withBrokenFile(
    PROCESSES,
    (source) => source.replace(/, timeout: PROCESS_QUERY_TIMEOUT_MS/g, ''),
    () => {
      const source = require('node:fs').readFileSync(PROCESSES, 'utf8');
      const calls = source.match(/spawnSync\([^)]*\{[^}]*\}/gs) || [];
      return calls.filter((call) => /powershell|'ps'/.test(call)).every((call) => /timeout:/.test(call));
    }
  );
  assert.equal(result, false, 'with the timeouts stripped, the gate must NOT report bounded');
});
