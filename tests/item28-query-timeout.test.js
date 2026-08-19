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
