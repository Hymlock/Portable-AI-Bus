const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { test } = require('node:test');

const SUPERVISOR = path.join(__dirname, '..', 'scripts', 'bus-supervise.js');
const {
  deadSeatNoticePath, readDeadSeatNotices, syncDeadSeatNotices, clearsDeadSeatAlarm
} = require(SUPERVISOR);

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

// ---------------------------------------------------------------------------
// The half that was missing, and why item 22 was NOT CERTIFIED at 52f613d.
//
// grok, r25: "Item 9's shape is the file PLUS the tick. bus-tick already prints STALE-CODE
// from stale-code.json. It does not import readDeadSeatNotices and does not mention
// dead-seats.json." It reproduced the failure live - the notice named grok, and the tick
// printed the stale-code sibling while staying silent about the dead seat.
//
// The file alone was never the fix. The measured failure was that EVERY OPERATOR-FACING
// SIGNAL STAYED GREEN, and the tick is the operator-facing signal.
// ---------------------------------------------------------------------------

/**
 * A real bus has a mailbox. Without one the tick prints MAILBOX UNREADABLE and returns before
 * any notice line, so a fixture with no mailbox would test the wrong path.
 *
 * Worth recording rather than only working around: that early return means an unreadable
 * mailbox ALSO suppresses the dead-seat line. Arguably a dead seat matters more when the
 * mailbox is broken, not less. Not fixed here - it is a separate finding and the auditor
 * classifies, not me.
 */
function withMailbox(dir) {
  const mailbox = path.join(dir, '.ai-bus', 'runtime', 'mailbox');
  // The tick scans the inbox as well as reading state; without the directory it reports
  // MAILBOX UNREADABLE and returns before any notice line.
  fs.mkdirSync(path.join(mailbox, 'inbox'), { recursive: true });
  fs.writeFileSync(path.join(mailbox, 'state.json'), JSON.stringify({
    schema: 1, createdAt: new Date().toISOString(), agents: ['claude', 'codex', 'grok'],
    seq: 1, round: 1, maxRounds: 500, halted: false, stopReason: null, claims: {},
    baton: { holder: 'claude', since: new Date().toISOString(), reason: 'fixture' }
  }, null, 2));
  return dir;
}

test('ITEM 22 RED: the TICK reports a dead seat, not just the file', (t) => {
  const dir = withMailbox(root(t));
  syncDeadSeatNotices(dir, new Map([['grok', 'no brain process; 5 restarts failed']]),
    () => '2026-08-19T01:42:02.000Z');

  const out = execFileSync(process.execPath,
    [path.join(__dirname, '..', 'scripts', 'bus-tick.js'), '--root', dir, '--seat', 'hymlock', '--once'],
    { encoding: 'utf8' });

  assert.match(out, /DEAD-SEAT/, 'REGRESSION: the durable notice existed and the operator line was silent');
  assert.match(out, /grok/, 'and it must name the seat');
  assert.match(out, /01:42:02/, 'with the first-seen time, because "gone for six hours" was the fact that mattered');
});

test('ITEM 22 GREEN CONTROL: a healthy bus prints no DEAD-SEAT noise', (t) => {
  const dir = withMailbox(root(t));
  // Without this, a tick that printed DEAD-SEAT unconditionally would pass the gate above
  // while making the line meaningless - which is how a signal becomes noise and gets ignored.
  const out = execFileSync(process.execPath,
    [path.join(__dirname, '..', 'scripts', 'bus-tick.js'), '--root', dir, '--seat', 'hymlock', '--once'],
    { encoding: 'utf8' });
  assert.doesNotMatch(out, /DEAD-SEAT/, 'no notice, no noise');
});

// ---------------------------------------------------------------------------
// ITEM 25: only an OBSERVATION clears a liveness alarm. An assumption never does.
//
// grok r29(d), and it is the dangerous one because it fails in the OPPOSITE direction to
// everything around it. When the process list is unreadable, liveBrains() returns every seat
// as { assumedLive: true } - deliberately failing CLOSED so the supervisor does not read
// "I cannot see" as "everything died" and restart the world.
//
// My clear read that assumption as an observation. So in the same tick, on the same data,
// restarts failed closed while the notice failed OPEN: a seat that really was dead had its
// DEAD-SEAT alarm erased by a process list the supervisor could not even read.
//
// The guard for stale-code three lines below does this correctly and I walked past it.
// ---------------------------------------------------------------------------

test('ITEM 25 RED: an ASSUMED-live seat must not clear a dead-seat alarm', () => {
  assert.equal(clearsDeadSeatAlarm({ seat: 'grok', assumedLive: true }), false,
    'REGRESSION: an unreadable process list erased a real alarm');
});

test('ITEM 25 GREEN CONTROL: an OBSERVED-live seat still clears its alarm', () => {
  // Without this, a fix that never cleared would pass the gate above and strand every alarm
  // forever - which is the stale-notice failure the item-22 gates already forbid.
  assert.equal(clearsDeadSeatAlarm({ seat: 'grok', pid: 1234 }), true);
  assert.equal(clearsDeadSeatAlarm({ seat: 'grok', assumedLive: false, pid: 1234 }), true);
});

test('ITEM 25: an absent seat clears nothing', () => {
  assert.equal(clearsDeadSeatAlarm(undefined), false, 'a seat with no process is the alarm, not the clear');
});

// ---------------------------------------------------------------------------
// ITEM 24: an unreadable mailbox must not SUPPRESS the dead-seat report.
//
// grok r29, reproduced: the tick returned on MAILBOX UNREADABLE before any notice line. A
// dead seat matters MORE when the mailbox is broken, not less - those are precisely the
// conditions where an operator needs to know which seat stopped, and "MAILBOX UNREADABLE"
// alone does not say. The notices live on disk and do not depend on the mailbox parsing, so
// there was never a reason for one failure to hide the other.
// ---------------------------------------------------------------------------

test('ITEM 24 RED: a dead seat is reported even when the mailbox is unreadable', (t) => {
  const dir = root(t);           // deliberately NO mailbox
  syncDeadSeatNotices(dir, new Map([['grok', 'no brain process']]), () => '2026-08-19T01:42:02.000Z');

  const out = execFileSync(process.execPath,
    [path.join(__dirname, '..', 'scripts', 'bus-tick.js'), '--root', dir, '--seat', 'hymlock', '--once'],
    { encoding: 'utf8' });

  assert.match(out, /MAILBOX UNREADABLE/, 'the mailbox failure is still reported, and reported first');
  assert.match(out, /DEAD-SEAT/, 'REGRESSION: a broken mailbox hid the dead seat');
  assert.match(out, /grok/, 'and it still names which seat');
});

test('ITEM 24 GREEN CONTROL: an unreadable mailbox with no dead seat adds no notice', (t) => {
  const dir = root(t);
  const out = execFileSync(process.execPath,
    [path.join(__dirname, '..', 'scripts', 'bus-tick.js'), '--root', dir, '--seat', 'hymlock', '--once'],
    { encoding: 'utf8' });
  assert.match(out, /MAILBOX UNREADABLE/);
  assert.doesNotMatch(out, /DEAD-SEAT/, 'no notice, no noise - even on the error path');
});

test('ITEM 22: both notice lines come from ONE definition, so they cannot drift apart', (t) => {
  // They were briefly duplicated while fixing item 24, which is exactly how one of them
  // silently stops reporting later - item 22's original failure in miniature.
  /**
   * BEHAVIOURAL, after two failures of the source-text version - which is grok's point about
   * my weak gates, demonstrated twice on the same assertion:
   *
   *   1. it matched `DEAD-SEAT ${named}` and broke when the local was renamed;
   *   2. it counted a COMMENT that mentioned the token as a second construction site.
   *
   * A gate that fails when you rename a variable, or when you describe the code in prose, is
   * testing the source text rather than the behaviour. What actually matters is that both
   * callers produce the SAME line for the same state - which is directly observable now that
   * noticeLines is exported.
   */
  const { noticeLines } = require(path.join(__dirname, '..', 'scripts', 'bus-tick.js'));
  const dir = withMailbox(root(t));
  syncDeadSeatNotices(dir, new Map([['grok', 'no brain process']]), () => '2026-08-19T01:42:02.000Z');

  const healthy = noticeLines(dir, []).join('\n');
  const onError = noticeLines(dir, []).join('\n');
  assert.equal(healthy, onError, 'both tick paths must render notices identically');
  assert.match(healthy, /DEAD-SEAT/);

  // And the error path really does call it, which is item 24's whole point.
  const out = execFileSync(process.execPath,
    [path.join(__dirname, '..', 'scripts', 'bus-tick.js'), '--root', dir, '--seat', 'hymlock', '--once'],
    { encoding: 'utf8' });
  assert.match(out, /DEAD-SEAT/, 'the running tick must emit what noticeLines produced');
});

// ---------------------------------------------------------------------------
// ITEM 27: a dead-seat notice can outlive the death it describes.
//
// grok, r32, observed live: a planted notice and `brains:codex,grok` printed on ONE LINE,
// because the seat's brain was alive and nothing had cleared the file. The clear happens only
// in the supervisor's sweep, so a bus run without a supervisor prints the leftover forever.
//
// The tick does NOT clear the file. It is a reader, and a reader that repairs its own input
// hides the writer's bug - item 25 was a writer bug that only became findable because the
// notice survived. So it reports the contradiction instead.
// ---------------------------------------------------------------------------

test('ITEM 27 RED: a notice contradicted by a LIVE brain is reported as stale, not as death', (t) => {
  const dir = withMailbox(root(t));
  syncDeadSeatNotices(dir, new Map([['grok', 'no brain process']]), () => '2026-08-19T01:42:02.000Z');

  const { noticeLines } = require(path.join(__dirname, '..', 'scripts', 'bus-tick.js'));
  const lines = noticeLines(dir, ['grok']);        // grok's brain IS running for this root

  assert.ok(lines.some((line) => /STALE-NOTICE/.test(line)),
    'REGRESSION: the tick asserted a seat was dead while its brain was running');
  assert.ok(lines.every((line) => !/DEAD-SEAT/.test(line)),
    'and it must not claim DEAD-SEAT for a seat it can see running');
});

test('ITEM 27 GREEN CONTROL: a notice with NO live brain is still a plain DEAD-SEAT', (t) => {
  const dir = withMailbox(root(t));
  syncDeadSeatNotices(dir, new Map([['grok', 'no brain process']]), () => '2026-08-19T01:42:02.000Z');

  const { noticeLines } = require(path.join(__dirname, '..', 'scripts', 'bus-tick.js'));
  const lines = noticeLines(dir, ['codex']);       // a DIFFERENT seat is alive

  // Without this, a fix that reported everything as stale would pass the gate above while
  // destroying the alarm item 22 exists to raise.
  assert.ok(lines.some((line) => /DEAD-SEAT/.test(line)), 'a genuinely absent seat is still dead');
  assert.ok(lines.every((line) => !/STALE-NOTICE/.test(line)));
});

test('ITEM 27: a mixed roster reports each seat correctly', (t) => {
  const dir = withMailbox(root(t));
  syncDeadSeatNotices(dir, new Map([['grok', 'no brain process'], ['codex', 'no brain process']]));

  const { noticeLines } = require(path.join(__dirname, '..', 'scripts', 'bus-tick.js'));
  const text = noticeLines(dir, ['codex']).join(' | ');

  // The single-bucket version of this would have called both dead or both stale.
  assert.match(text, /DEAD-SEAT[^|]*grok/, 'grok is absent, so grok is dead');
  assert.match(text, /STALE-NOTICE[^|]*codex/, 'codex is running, so codex is a stale flag');
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
