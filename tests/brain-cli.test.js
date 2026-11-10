const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

require('./helpers/require-fresh-dist')();
const { loadBrain, latestTreeMtimeMs, recordLoadedCode } = require('../dist/brain/cli.js');

test('brain factory receives coordination root and repository workdir separately', async (t) => {
  const fixture = await fs.mkdtemp(path.join(os.tmpdir(), 'portable-ai-bus-brain-cli-'));
  t.after(() => fs.rm(fixture, { recursive: true, force: true }));
  const modulePath = path.join(fixture, 'brain.cjs');
  await fs.writeFile(modulePath, [
    'module.exports = ({ root, workdir }) => ({',
    '  name: JSON.stringify({ root, workdir }),',
    '  async takeTurn() { return { done: true }; }',
    '});'
  ].join('\n'));
  const coordinationRoot = path.join(fixture, 'mailbox-root');
  const workdir = path.join(fixture, 'target-repo');
  const brain = await loadBrain(modulePath, 'codex', coordinationRoot, workdir);
  assert.deepEqual(JSON.parse(brain.name), { root: coordinationRoot, workdir });
});

test('a brain records the dist timestamp it loaded for stale-code detection', async (t) => {
  const fixture = await fs.mkdtemp(path.join(os.tmpdir(), 'portable-ai-bus-code-version-'));
  t.after(() => fs.rm(fixture, { recursive: true, force: true }));
  const distRoot = path.join(fixture, 'dist');
  await fs.mkdir(path.join(distRoot, 'brain'), { recursive: true });
  await fs.writeFile(path.join(distRoot, 'brain', 'cli.js'), 'old code');

  const expected = await latestTreeMtimeMs(distRoot);
  const marker = await recordLoadedCode(fixture, 'codex', distRoot);
  const recorded = JSON.parse(await fs.readFile(
    path.join(fixture, '.ai-bus', 'runtime', 'brain-codex.code.json'), 'utf8'));

  assert.equal(marker.loadedDistMtimeMs, expected);
  assert.equal(recorded.pid, process.pid);
  assert.equal(recorded.distRoot, distRoot);
});

// ---------------------------------------------------------------------------
// Exhaustion must be SHARED state, not a private log line.
//
// createExhaustionHandler only announced a spent chain when the seat held the baton, and only
// into its own log. On 2026-08-20 one seat spent an afternoon sending audit requests to a seat
// that had been out of providers for hours - acking them, actioning none. Nobody was told: not
// the sender, not the human. The bus looked busy and no work moved.
// ---------------------------------------------------------------------------
test('a spent chain is recorded where other seats can see it, even when not holding the baton', async (t) => {
  const os = require('node:os');
  const fs = require('node:fs');
  const path = require('node:path');
  const { createExhaustionHandler, readSpentSeatNotices, recordSpentSeat } =
    require('../dist/brain/cli.js');
  const { MailboxStore } = require('../dist/mailbox.js');

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pab-spent-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = new MailboxStore(root);
  await store.ensureInitialized(['claude', 'codex']);
  // Baton deliberately with the OTHER seat: this is the case the old code could not see.
  await store.reassignBaton({ to: 'claude', reason: 'test setup', force: true });

  const handler = createExhaustionHandler({ seat: 'codex', root });
  await handler({ seat: 'codex', detail: 'quota exhausted on every link' });

  const notices = readSpentSeatNotices(root);
  const codex = notices.seats.find((s) => s.seat === 'codex');
  assert.ok(codex,
    'a seat that cannot act must say so in shared state; the old handler returned silently ' +
    'whenever it did not hold the baton, which is most of the time for a seat that cannot think');
  assert.match(codex.detail, /quota exhausted/);
  assert.ok(codex.since, 'the notice must carry when it started, so staleness is visible');

  // And it must clear, or the notice becomes noise a reader learns to skip.
  recordSpentSeat(root, 'codex', null);
  assert.equal(readSpentSeatNotices(root).seats.find((s) => s.seat === 'codex'), undefined,
    'topping a seat up must clear its notice');
});

test('an exhausted seat hands off to a seat that can work, not just the next one in the list', async (t) => {
  // Round-robin succession assumed the next seat could think. With two of three spent it hands
  // the baton to another seat that cannot act, and the five-minute cooldown then suppresses the
  // correction. The baton keeps moving and nothing keeps working - a stall wearing motion.
  const os = require('node:os');
  const fs = require('node:fs');
  const path = require('node:path');
  const { createExhaustionHandler, recordSpentSeat } = require('../dist/brain/cli.js');
  const { MailboxStore } = require('../dist/mailbox.js');

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pab-succ-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = new MailboxStore(root);
  await store.ensureInitialized(['claude', 'codex', 'grok']);
  await store.reassignBaton({ to: 'claude', reason: 'setup', force: true });

  // claude is spent and holds the baton; codex is ALSO spent; grok is fine.
  // Round-robin from claude picks codex. Only grok can actually take the work.
  recordSpentSeat(root, 'codex', 'quota exhausted');
  const handler = createExhaustionHandler({ seat: 'claude', root });
  await handler({ seat: 'claude', detail: 'all links spent' });

  const after = await store.status();
  assert.equal(after.baton?.holder, 'grok',
    `baton went to ${after.baton?.holder}; codex is recorded spent and cannot act on it`);
});

test('a solo seat with nobody to hand to KEEPS the baton rather than passing it to itself', async (t) => {
  const os = require('node:os');
  const fs = require('node:fs');
  const path = require('node:path');
  const { createExhaustionHandler } = require('../dist/brain/cli.js');
  const { MailboxStore } = require('../dist/mailbox.js');

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pab-solo-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = new MailboxStore(root);
  await store.ensureInitialized(['claude']);
  await store.reassignBaton({ to: 'claude', reason: 'setup', force: true });

  const events = [];
  const handler = createExhaustionHandler({
    seat: 'claude', root, log: (event, data) => events.push([event, data])
  });
  await handler({ seat: 'claude', detail: 'all links spent' });

  const after = await store.status();
  assert.equal(after.baton?.holder, 'claude', 'a solo seat must not hand the baton to itself');
  const reported = events.find(([event]) => event === 'exhausted-no-usable-successor');
  assert.ok(reported, 'a solo exhausted seat must SAY it is stuck; silence looks like idleness');
  assert.equal(reported[1].otherSeats, 0);
});
