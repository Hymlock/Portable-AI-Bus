const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

const SUPERVISOR = path.join(__dirname, '..', 'scripts', 'bus-supervise.js');
const { deadSeatNoticePath, readDeadSeatNotices, syncDeadSeatNotices } = require(SUPERVISOR);

// ---------------------------------------------------------------------------
// ITEM 22: AN ABSENT SEAT IS NOT NOTICED.
//
// Measured 2026-08-19. grok's brain died on every wake for hours. The supervisor was running
// and behaved exactly as designed - restart, hit the budget, cool down, retry - and its only
// sink for "this seat is gone" was console.log. Nobody reads the console.
//
// Everything an operator normally looks at stayed green, because a seat with no brain still
// has a mailbox and can still hold the baton. The coordinator diagnosed it as "out of
// credits", then as "working", before running bus-restart by hand and being told
// `missing brains=grok` in one line.
//
// Item 9 was the same defect - a detector whose only sink is a log - in a path this one never
// covered. So the repair is item 9's shape, not a new mechanism.
//
// grok's framing, and why this is a separate item from 21: the repair here is a LIVENESS SINK,
// not a change to how refusals propagate.
// ---------------------------------------------------------------------------

function root(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pab-i22-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 8 }));
  return dir;
}

test('ITEM 22 RED: an exhausted-restart seat leaves a DURABLE notice, not just a log line', (t) => {
  const dir = root(t);
  assert.deepEqual(readDeadSeatNotices(dir).seats, [], 'nothing is wrong before anything goes wrong');

  syncDeadSeatNotices(dir, new Map([['grok', 'no brain process; 5 restarts failed, cooling down and retrying']]));

  // The whole point: it survives the process that noticed it. A console line does not.
  const onDisk = JSON.parse(fs.readFileSync(deadSeatNoticePath(dir), 'utf8'));
  assert.equal(onDisk.version, 1);
  assert.equal(onDisk.seats.length, 1);
  assert.equal(onDisk.seats[0].seat, 'grok');
  assert.match(onDisk.seats[0].reason, /no brain process/,
    'and it must say WHAT is wrong - "grok is dead" sends someone hunting, "no brain process" does not');
  assert.ok(onDisk.seats[0].at, 'with a time, so a stale notice is recognisable as stale');
});

test('ITEM 22 RED: the notice CLEARS when the seat comes back', (t) => {
  const dir = root(t);
  syncDeadSeatNotices(dir, new Map([['grok', 'no brain process']]));
  assert.equal(readDeadSeatNotices(dir).seats.length, 1);

  syncDeadSeatNotices(dir, new Map([['grok', undefined]]));

  // A stale alarm about a recovered seat is worse than no alarm: it is exactly how a signal
  // becomes noise and then gets ignored, which is the failure this item exists to fix.
  assert.deepEqual(readDeadSeatNotices(dir).seats, [], 'a recovered seat must not stay flagged');
  assert.equal(fs.existsSync(deadSeatNoticePath(dir)), false, 'and the file goes away entirely');
});

test('ITEM 22: a seat nobody looked at keeps its recorded state', (t) => {
  const dir = root(t);
  syncDeadSeatNotices(dir, new Map([['grok', 'no brain process'], ['codex', 'no brain process']]));

  // Only grok was inspected this sweep. Inventing a clear for codex would hide a real dead
  // seat - the same rule syncStaleCodeNotices already follows for the same reason.
  syncDeadSeatNotices(dir, new Map([['grok', undefined]]));

  const seats = readDeadSeatNotices(dir).seats.map((item) => item.seat);
  assert.deepEqual(seats, ['codex'], 'an uninspected seat keeps its notice');
});

test('ITEM 22: the first-seen time is preserved across ticks, so age is real', (t) => {
  const dir = root(t);
  syncDeadSeatNotices(dir, new Map([['grok', 'no brain process']]), () => '2026-08-19T00:00:00.000Z');
  syncDeadSeatNotices(dir, new Map([['grok', 'no brain process']]), () => '2026-08-19T06:00:00.000Z');

  // Without this the notice always looks one tick old, and "grok has been dead for six hours"
  // - the fact that actually mattered - can never be read off it.
  assert.equal(readDeadSeatNotices(dir).seats[0].at, '2026-08-19T00:00:00.000Z',
    'the notice must age; refreshing `at` every tick hides how long a seat has been gone');
});

test('ITEM 22 GREEN CONTROL: a corrupt or absent notice file reads as "nothing wrong"', (t) => {
  const dir = root(t);
  assert.deepEqual(readDeadSeatNotices(dir).seats, [], 'absent');

  fs.mkdirSync(path.dirname(deadSeatNoticePath(dir)), { recursive: true });
  fs.writeFileSync(deadSeatNoticePath(dir), '{ not json');
  assert.deepEqual(readDeadSeatNotices(dir).seats, [], 'corrupt must not throw into the supervisor sweep');

  fs.writeFileSync(deadSeatNoticePath(dir), JSON.stringify({ version: 99, seats: [{ seat: 'grok' }] }));
  assert.deepEqual(readDeadSeatNotices(dir).seats, [], 'a future schema is not silently misread');
});
