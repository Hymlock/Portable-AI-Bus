// Self-pruning queue (bus-prune-queue): store-level acceptance tests T1-T4, T6-T13, T17.
// Every test runs in its own temp root with an injected clock; nothing touches a live mailbox.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { test } = require('node:test');

require('./helpers/require-fresh-dist')();
const { MailboxStore, QueueFullError, BusHaltedError } = require('../dist/mailbox.js');

const execFileAsync = promisify(execFile);
const mailboxCli = path.resolve(__dirname, '..', 'dist', 'mailbox.js');
const HOUR = 3_600_000;

async function fixture(agents = ['codex', 'grok'], options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pab-queue-'));
  const clock = { now: Date.parse('2026-11-01T00:00:00Z') };
  const make = (extra = {}) => new MailboxStore(root, { now: () => clock.now, ...extra });
  const store = make();
  await store.ensureInitialized(agents, 20);
  if (options.retention) await store.configureRetention(options.retention);
  const cleanup = () => fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  return { root, clock, store, make, cleanup };
}

const send = (store, to, subject, from = 'codex') => store.send({ from, to, subject, body: `body of ${subject}` });
const inboxDir = (root) => path.join(root, '.ai-bus', 'runtime', 'mailbox', 'inbox');
const archiveDir = (root) => path.join(root, '.ai-bus', 'runtime', 'mailbox', 'archive');
const statePath = (root) => path.join(root, '.ai-bus', 'runtime', 'mailbox', 'state.json');
const hotSeqs = async (root) => (await fs.readdir(inboxDir(root))).filter((name) => name.endsWith('.json')).map((name) => Number.parseInt(name, 10)).sort((a, b) => a - b);
// The baton reason names the latest message ("#N from x"), which pins it. Tests that want a
// seat's mail free to archive end with an anchor message the other way and read it.
async function anchor(store) {
  const message = await store.send({ from: 'grok', to: 'codex', subject: 'baton anchor', body: 'pins itself via the baton' });
  await store.read('codex', true);
  return message;
}
const readState = async (root) => JSON.parse(await fs.readFile(statePath(root), 'utf8'));

test('T1 each eligibility rule blocks archiving on its own; unread is never archived', async (t) => {
  const f = await fixture(['codex', 'grok'], { retention: { keepRecent: 2, minAgeHours: 48 } });
  t.after(f.cleanup);
  const { store, clock } = f;
  const unread = await send(store, 'grok', 'unread');
  const parked = await send(store, 'grok', 'parked');
  const checkpoint = await send(store, 'grok', 'checkpoint');
  const pinned = await send(store, 'grok', 'pinned');
  const plain = await send(store, 'grok', 'plain old read');
  await store.acknowledge('grok', [checkpoint.seq, pinned.seq, plain.seq]);
  await store.park('grok', parked.seq, 'poison');
  await store.openRecovery('grok', checkpoint.seq, 'in flight');
  await store.setGoal({ statement: `finish the work in #${pinned.seq}`, doneWhen: 'tests pass' });
  clock.now += 49 * HOUR;
  const young = await send(store, 'grok', 'young');
  const recent = await send(store, 'grok', 'recent');
  const batonPinned = await send(store, 'grok', 'baton pinned');
  await store.acknowledge('grok', [young.seq, recent.seq, batonPinned.seq]);

  const dry = await store.archive({ dryRun: true });
  assert.equal(dry.eligible, 1);
  // pinned = goal reference + baton reference (the baton reason names the latest message)
  assert.deepEqual(dry.batches[0].blocked, { unread: 1, parked: 1, checkpoint: 1, pinned: 2, young: 1, recent: 1 });
  assert.deepEqual(await hotSeqs(f.root), [unread.seq, parked.seq, checkpoint.seq, pinned.seq, plain.seq, young.seq, recent.seq, batonPinned.seq], 'dry run changes nothing');

  const run = await store.archive();
  assert.equal(run.archived, 1);
  assert.deepEqual(await hotSeqs(f.root), [unread.seq, parked.seq, checkpoint.seq, pinned.seq, young.seq, recent.seq, batonPinned.seq]);

  // Pressure drops only the age rule.
  const pressure = await store.archive({ pressure: true });
  assert.equal(pressure.archived, 1);
  assert.deepEqual(await hotSeqs(f.root), [unread.seq, parked.seq, checkpoint.seq, pinned.seq, recent.seq, batonPinned.seq]);
  assert.equal((await store.inbox('grok')).some((message) => message.seq === unread.seq), true);
});

test('T2 archive -> show/archived byte-equal -> unarchive bumps mailEpoch -> re-archive is correct', async (t) => {
  const f = await fixture(['codex', 'grok'], { retention: { keepRecent: 0, minAgeHours: 1 } });
  t.after(f.cleanup);
  const { store, clock, root } = f;
  const messages = [];
  for (let index = 0; index < 5; index += 1) messages.push(await send(store, 'grok', `m${index}`));
  await store.read('grok', true);
  const baton = await anchor(store);
  const before = new Map();
  for (const seq of (await hotSeqs(root)).filter((seq) => seq !== baton.seq)) {
    const name = (await fs.readdir(inboxDir(root))).find((item) => Number.parseInt(item, 10) === seq);
    before.set(seq, JSON.parse(await fs.readFile(path.join(inboxDir(root), name), 'utf8')));
  }
  clock.now += 2 * HOUR;
  const run = await store.archive();
  assert.equal(run.archived, 5);
  assert.deepEqual(await hotSeqs(root), [baton.seq]);
  for (const [seq, original] of before) {
    const shown = await store.show(seq);
    const { archivedIn, ...message } = shown;
    assert.match(archivedIn, /^seg-\d{6}-\d{6}\.ndjson$/);
    assert.deepEqual(message, original, `#${seq} round-trips byte-equal`);
  }
  assert.deepEqual((await store.archived({ to: 'grok' })).map((row) => row.seq), [...before.keys()]);

  const epochBefore = (await readState(root)).mailEpoch ?? 0;
  const [restored] = await store.unarchive([messages[2].seq]);
  assert.equal(typeof restored.restoredAt, 'string');
  assert.equal((await readState(root)).mailEpoch, epochBefore + 1);
  assert.deepEqual(await hotSeqs(root), [messages[2].seq, baton.seq]);
  assert.equal((await store.archived()).some((row) => row.seq === messages[2].seq), false, 'restored row is tombstoned');
  assert.equal((await store.doctor()).ok, true);

  // Restored mail is young again (age = max(createdAt, restoredAt)); after the window it re-archives.
  assert.equal((await store.archive()).archived, 0);
  clock.now += 2 * HOUR;
  const again = await store.archive();
  assert.equal(again.archived, 1);
  assert.match(again.batches[0].segment, new RegExp(`^seg-0*${messages[2].seq}-0*${messages[2].seq}`));
  const shown = await store.show(messages[2].seq);
  assert.equal(shown.archivedIn, again.batches[0].segment);
  assert.equal((await store.doctor()).ok, true);
});

const FAULTS = ['after-journal', 'after-tmp', 'after-sidecar-rename', 'after-segment-rename', 'after-commit', 'mid-delete', 'after-delete', 'before-state', 'before-journal-delete'];

for (const point of FAULTS) {
  test(`T3 crash at ${point}: next locked op recovers with no loss and no seq live twice`, async (t) => {
    const f = await fixture(['codex', 'grok'], { retention: { keepRecent: 0, minAgeHours: 0 } });
    t.after(f.cleanup);
    const sent = [];
    for (let index = 0; index < 6; index += 1) sent.push(await send(f.store, 'grok', `m${index}`));
    await f.store.read('grok', true);
    const unread = await send(f.store, 'grok', 'stays unread');
    const crashing = f.make({ archiveFault: (at) => { if (at === point) throw new Error(`injected crash at ${at}`); } });
    await assert.rejects(crashing.archive(), new RegExp(`injected crash at ${point}`));

    const recovered = f.make();
    await recovered.send({ from: 'codex', to: 'grok', subject: 'after crash', body: 'locked op triggers recovery' });
    await assert.rejects(fs.access(path.join(archiveDir(f.root), 'journal.json')));
    const report = await recovered.doctor();
    assert.deepEqual(report.problems, [], `doctor clean after ${point}`);
    for (const message of [...sent, unread]) {
      const shown = await recovered.show(message.seq);
      assert.equal(shown.subject, message.subject, `#${message.seq} survives ${point}`);
    }
    const hot = new Set(await hotSeqs(f.root));
    for (const row of await recovered.archived()) assert.equal(hot.has(row.seq), false, `#${row.seq} live twice after ${point}`);
    assert.equal(hot.has(unread.seq), true);
    const finish = await recovered.archive();
    assert.ok(finish.archived >= 0);
    assert.deepEqual((await recovered.doctor()).problems, []);
  });
}

test('T3 a hot file edited mid-run is kept (deep-equal delete rule, hot wins)', async (t) => {
  const f = await fixture(['codex', 'grok'], { retention: { keepRecent: 0, minAgeHours: 0 } });
  t.after(f.cleanup);
  const first = await send(f.store, 'grok', 'edited mid-run');
  const second = await send(f.store, 'grok', 'untouched');
  await f.store.read('grok', true);
  const baton = await anchor(f.store);
  const editing = f.make({
    archiveFault: async (at) => {
      if (at !== 'after-commit') return;
      const name = (await fs.readdir(inboxDir(f.root))).find((item) => Number.parseInt(item, 10) === first.seq);
      const file = path.join(inboxDir(f.root), name);
      const message = JSON.parse(await fs.readFile(file, 'utf8'));
      message.body = 'changed while the archive ran';
      await fs.writeFile(file, JSON.stringify(message), 'utf8');
    }
  });
  const run = await editing.archive({ maxBatches: 1 });
  assert.deepEqual(run.batches[0].kept, [first.seq]);
  assert.equal(run.batches[0].archived, 1);
  assert.deepEqual(await hotSeqs(f.root), [first.seq, baton.seq]);
  assert.equal((await f.store.show(first.seq)).body, 'changed while the archive ran', 'hot wins');
  assert.match((await f.store.show(second.seq)).archivedIn, /\.ndjson$/);
  const report = await f.store.doctor();
  assert.deepEqual(report.problems, []);
  assert.match(report.warnings.join('\n'), /hot wins|hot kept/);
  // The edited copy is ordinary read mail: the next run archives it and show returns the edit.
  await f.store.archive();
  assert.deepEqual(await hotSeqs(f.root), [baton.seq]);
  assert.equal((await f.store.show(first.seq)).body, 'changed while the archive ran');
  assert.deepEqual((await f.store.doctor()).problems, []);
});

test('T4 archive everything, lose counters and hot: send still gets high-water+1; gaps pass doctor', async (t) => {
  const f = await fixture(['codex', 'grok'], { retention: { keepRecent: 0, minAgeHours: 0 } });
  t.after(f.cleanup);
  for (let index = 0; index < 4; index += 1) await send(f.store, 'grok', `m${index}`);
  await f.store.read('grok', true);
  await anchor(f.store);
  assert.equal((await f.store.archive()).archived, 4);
  // lose the hot inbox entirely (the anchor #5 too) and the counters
  for (const name of await fs.readdir(inboxDir(f.root))) await fs.rm(path.join(inboxDir(f.root), name));
  const state = await readState(f.root);
  state.seq = 0;
  state.round = 0;
  delete state.queue;
  await fs.writeFile(statePath(f.root), JSON.stringify(state), 'utf8');
  const next = await send(f.store, 'grok', 'after loss');
  assert.equal(next.seq, 5);
  // A gap (as at Parchmap 1529/1530) is not a problem.
  const gapState = await readState(f.root);
  gapState.seq = 9;
  gapState.round = 9;
  await fs.writeFile(statePath(f.root), JSON.stringify(gapState), 'utf8');
  assert.equal((await send(f.store, 'grok', 'after gap')).seq, 10);
  const report = await f.store.doctor();
  assert.deepEqual(report.problems, []);
});

test('T6 a waiter wakes on a new send, on a crash-orphaned file, and on requeue/unarchive', async (t) => {
  const f = await fixture(['codex', 'grok'], { retention: { keepRecent: 0, minAgeHours: 0 } });
  t.after(f.cleanup);
  const waiter = new MailboxStore(f.root);
  // new send
  let waiting = waiter.waitFor('grok', 3_000, 25);
  await new Promise((resolve) => setTimeout(resolve, 80));
  await send(f.store, 'grok', 'wake 1');
  assert.equal(await waiting, 'message');
  await f.store.read('grok', true);
  // crash-orphaned file: message on disk, state never updated
  waiting = waiter.waitFor('grok', 3_000, 25);
  await new Promise((resolve) => setTimeout(resolve, 80));
  const template = (await f.store.show(1));
  const orphan = { ...template, seq: 99, subject: 'orphan', read: false, readAt: undefined, createdAt: new Date().toISOString() };
  const orphanName = (await fs.readdir(inboxDir(f.root)))[0].replace(/^\d+/, '000099');
  await fs.writeFile(path.join(inboxDir(f.root), orphanName), JSON.stringify(orphan), 'utf8');
  assert.equal(await waiting, 'message');
  await fs.rm(path.join(inboxDir(f.root), orphanName));
  // requeue of a parked message (no new seq): epoch bump forces the rescan
  const parked = await send(f.store, 'grok', 'to park');
  await f.store.park('grok', parked.seq, 'poison');
  waiting = waiter.waitFor('grok', 3_000, 25, parked.seq - 1);
  await new Promise((resolve) => setTimeout(resolve, 80));
  await f.store.requeue('grok', parked.seq);
  assert.equal(await waiting, 'message');
  // unarchive of an unread-at-archive-time message is impossible (unread never archives), so
  // expire -> archive -> unarchive -> requeue: the waiter must see the restored unread mail.
  await anchor(f.store);
  assert.deepEqual((await f.store.expire({ seat: 'grok', reason: 'test', throughSeq: parked.seq })).expired, [parked.seq]);
  await f.store.archive({ pressure: true });
  assert.equal((await f.store.archived({ expired: true })).some((row) => row.seq === parked.seq), true);
  waiting = waiter.waitFor('grok', 3_000, 25, parked.seq - 1);
  await new Promise((resolve) => setTimeout(resolve, 80));
  await f.store.unarchive([parked.seq]);
  await f.store.requeue('grok', parked.seq);
  assert.equal(await waiting, 'message');
});

test('T6b a torn (unreadable) fresh file is retried: the waiter wakes within 2 intervals and the mark holds', async (t) => {
  const f = await fixture();
  t.after(f.cleanup);
  const first = await send(f.store, 'grok', 'baseline');
  await f.store.read('grok', true);
  const waiter = new MailboxStore(f.root);
  const waiting = waiter.waitFor('grok', 5_000, 50);
  await new Promise((resolve) => setTimeout(resolve, 120));
  const name = (await fs.readdir(inboxDir(f.root)))[0].replace(/^\d+/, String(first.seq + 1).padStart(6, '0'));
  const file = path.join(inboxDir(f.root), name);
  await fs.writeFile(file, '{"seq":', 'utf8'); // torn write -> SyntaxError -> treated as transient
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(waiter.metrics.lastScannedSeq < first.seq + 1, true, 'skipped file holds the mark below itself');
  const message = { ...(await f.store.show(first.seq)), seq: first.seq + 1, subject: 'now whole', read: false };
  delete message.readAt;
  const started = Date.now();
  await fs.writeFile(file, JSON.stringify(message), 'utf8');
  assert.equal(await waiting, 'message');
  assert.ok(Date.now() - started < 2 * 50 + 200, 'woke within two intervals (+IO slack)');
});

test('T7 send works at any round; backstop refuses without latching; archive frees room; everyRounds still halts', async (t) => {
  const f = await fixture(['codex', 'grok'], { retention: { keepRecent: 2, minAgeHours: 0, pinnedAllowance: 0, maxUnreadPerSeat: 50 } });
  t.after(f.cleanup);
  const state = await readState(f.root);
  state.round = 6000;
  state.seq = 6000;
  await fs.writeFile(statePath(f.root), JSON.stringify(state), 'utf8');
  const big = await send(f.store, 'grok', 'round 6001');
  assert.equal(big.round, 6001);
  // maxHot = keepRecent + pinnedAllowance + agents*cap + 100 = 2 + 0 + 100 + 100 = 202
  assert.equal(f.store.maxHotOf(await f.store.snapshot()), 202);
  // "A pressure prune just ran and found nothing": the in-send pressure batch is not due
  // for 60 min. (A normal-mode run that found nothing only defers pressure by 5 min.)
  const forced = await readState(f.root);
  forced.queue.lastPruneAt = new Date(f.clock.now).toISOString();
  forced.queue.lastPruneEligible = 0;
  forced.queue.lastPruneMode = 'pressure';
  await fs.writeFile(statePath(f.root), JSON.stringify(forced), 'utf8');
  const filler = f.make();
  for (let index = 0; index < 201; index += 1) {
    await filler.send({ from: 'grok', to: 'codex', subject: `fill ${index}`, body: 'x' });
    if (index % 40 === 39) await filler.read('codex', true);
  }
  await filler.read('codex', true);
  assert.ok((await hotSeqs(f.root)).length >= 202);
  const refusal = await f.store.send({ from: 'codex', to: 'grok', subject: 'over', body: 'x' }).catch((error) => error);
  assert.ok(refusal instanceof QueueFullError, String(refusal));
  assert.equal(refusal.scope, 'backstop');
  assert.equal(refusal.exitCode, 4);
  assert.doesNotMatch(refusal.message, /halted/i);
  assert.equal(refusal.retryAfterMs, 60 * 60_000, 'lastPruneEligible==0 backs off 60 min');
  assert.equal((await f.store.snapshot()).halted, false, 'no latch');
  assert.ok((await f.store.archive({ pressure: true })).archived > 0);
  const ok = await f.store.send({ from: 'codex', to: 'grok', subject: 'room again', body: 'x' });
  assert.ok(ok.seq > big.seq);
  // everyRounds still halts
  await f.store.configureHalting({ everyRounds: 2 });
  let halted = false;
  for (let index = 0; index < 3 && !halted; index += 1) {
    await f.store.send({ from: 'codex', to: 'grok', subject: `every ${index}`, body: 'x' }).catch(() => undefined);
    halted = (await f.store.snapshot()).halted;
  }
  assert.equal(halted, true, 'haltPolicy.everyRounds still halts');
  await assert.rejects(send(f.store, 'grok', 'while halted'), BusHaltedError);
  await f.store.resume();
  assert.equal((await f.store.snapshot()).halted, false);
  await send(f.store, 'grok', 'after resume');
});

test('T7b a failed in-send pressure batch never fails the send; the journal is finished; nothing is lost', async (t) => {
  const f = await fixture(['codex', 'grok'], { retention: { keepRecent: 0, minAgeHours: 0, pinnedAllowance: 0, maxUnreadPerSeat: 5 } });
  t.after(f.cleanup);
  // maxHot = 0 + 0 + 2*5 + 100 = 110; pressure starts at 88 hot.
  assert.equal(f.store.maxHotOf(await f.store.snapshot()), 110);
  const sent = [];
  for (let index = 0; index < 88; index += 1) {
    sent.push(await f.store.send({ from: 'codex', to: 'grok', subject: `fill ${index}`, body: 'x' }));
    if (index % 4 === 3) await f.store.read('grok', true);
  }
  await f.store.read('grok', true);
  assert.equal((await hotSeqs(f.root)).length, 88);
  let fired = 0;
  const flaky = f.make({ archiveFault: (at) => {
    if (at === 'before-state' && fired === 0) { fired += 1; throw new Error('EPERM: injected state.json publish failure'); }
  } });
  const ok = await flaky.send({ from: 'codex', to: 'grok', subject: 'after failed batch', body: 'x' });
  assert.equal(fired, 1, 'the in-send batch ran and failed');
  assert.ok(ok.seq > sent.at(-1).seq);
  await assert.rejects(fs.access(path.join(archiveDir(f.root), 'journal.json')));
  const state = await readState(f.root);
  assert.match(state.queue.archiveWarnings.join('\n'), /in-send pressure batch failed: EPERM/);
  assert.deepEqual((await f.store.doctor()).problems, []);
  const hot = new Set(await hotSeqs(f.root));
  for (const row of await f.store.archived({ limit: 1000 })) assert.equal(hot.has(row.seq), false, `#${row.seq} live twice`);
  for (const message of sent) assert.equal((await f.store.show(message.seq)).subject, message.subject);
});

test('T8 doctor detects duplicate live seqs, sidecar mismatch, orphan tmp, seq below high-water, missing archive', async (t) => {
  const f = await fixture(['codex', 'grok'], { retention: { keepRecent: 0, minAgeHours: 0 } });
  t.after(f.cleanup);
  for (let index = 0; index < 3; index += 1) await send(f.store, 'grok', `m${index}`);
  await f.store.read('grok', true);
  await f.store.archive();
  const names = await fs.readdir(archiveDir(f.root));
  const segment = names.find((name) => name.endsWith('.ndjson'));
  const sidecar = names.find((name) => name.endsWith('.index.json'));
  assert.deepEqual((await f.store.doctor()).problems, []);

  // duplicate live seq: a second segment covering the same seqs
  const dupBase = segment.replace('.ndjson', '-1');
  await fs.copyFile(path.join(archiveDir(f.root), segment), path.join(archiveDir(f.root), `${dupBase}.ndjson`));
  const side = JSON.parse(await fs.readFile(path.join(archiveDir(f.root), sidecar), 'utf8'));
  await fs.writeFile(path.join(archiveDir(f.root), `${dupBase}.index.json`), JSON.stringify({ ...side, segment: `${dupBase}.ndjson` }), 'utf8');
  assert.match((await f.store.doctor()).problems.join('\n'), /duplicate message sequence/);
  await fs.rm(path.join(archiveDir(f.root), `${dupBase}.ndjson`));
  await fs.rm(path.join(archiveDir(f.root), `${dupBase}.index.json`));

  // sidecar mismatch
  const bad = { ...side, rows: side.rows.slice(1) };
  await fs.writeFile(path.join(archiveDir(f.root), sidecar), JSON.stringify(bad), 'utf8');
  assert.match((await f.store.doctor()).problems.join('\n'), /does not match its segment/);
  await fs.writeFile(path.join(archiveDir(f.root), sidecar), JSON.stringify(side), 'utf8');

  // orphan tmp
  await fs.writeFile(path.join(archiveDir(f.root), 'seg-x.ndjson.tmp'), 'partial', 'utf8');
  assert.match((await f.store.doctor()).warnings.concat((await f.store.doctor()).problems).join('\n'), /orphan temporary file/);
  await fs.rm(path.join(archiveDir(f.root), 'seg-x.ndjson.tmp'));

  // state.seq below the high-water (archive-only high-water)
  const state = await readState(f.root);
  state.seq = 1;
  await fs.writeFile(statePath(f.root), JSON.stringify(state), 'utf8');
  assert.match((await f.store.doctor()).problems.join('\n'), /state seq is 1; inbox maximum is 3/);
  state.seq = 3;
  await fs.writeFile(statePath(f.root), JSON.stringify(state), 'utf8');

  // missing archive with nonzero counters
  await fs.rm(archiveDir(f.root), { recursive: true });
  assert.match((await f.store.doctor()).problems.join('\n'), /archive/i);
});

test('T9 an old-format (schema 1) runtime loads; doctor warns and does not write; first locked write upgrades', async (t) => {
  const f = await fixture();
  t.after(f.cleanup);
  await send(f.store, 'grok', 'm');
  const state = await readState(f.root);
  state.schema = 1;
  state.maxRounds = 99999;
  state.stopReason = null;
  delete state.retention;
  delete state.queue;
  delete state.mailEpoch;
  const raw = `${JSON.stringify(state, null, 2)}\n`;
  await fs.writeFile(statePath(f.root), raw, 'utf8');
  const status = await f.store.status();
  assert.equal(status.halted, false);
  const report = await f.store.doctor();
  assert.match(report.warnings.join('\n'), /upgrade-state/);
  assert.equal(await fs.readFile(statePath(f.root), 'utf8'), raw, 'doctor does not write a schema-1 state');
  await send(f.store, 'grok', 'upgrade by write');
  const upgraded = await readState(f.root);
  assert.equal(upgraded.schema, 2);
  assert.equal(upgraded.maxRounds, upgraded.round);
  assert.match(upgraded.stopReason, /upgrade required/);
});

test('T10 halted replay copy via the real CLI: maintenance is never refused for being halted', async (t) => {
  const f = await fixture(['codex', 'grok']);
  t.after(f.cleanup);
  for (let index = 0; index < 5; index += 1) await send(f.store, 'grok', `m${index}`);
  await f.store.read('grok', true);
  for (let index = 0; index < 3; index += 1) await send(f.store, 'codex', `u${index}`, 'grok');
  await f.store.halt('round guard reached (old)', { force: true });
  const cli = (...args) => execFileAsync(process.execPath, [mailboxCli, ...args, '--root', f.root]);
  assert.match((await cli('doctor')).stdout, /.+/);
  assert.match((await cli('upgrade-state')).stdout, /schema \d -> 2; per-seat unread cap 200/);
  const dry = (await cli('archive', '--dry-run')).stdout;
  assert.match(dry, /dry run: would archive/);
  assert.match(dry, /codex .*3 unread.*cap 200|codex/);
  await cli('archive');
  assert.match((await cli('expire', '--for', 'codex', '--dry-run')).stdout, /.+/);
  const beforeAdd = await fs.readFile(statePath(f.root), 'utf8');
  const addRounds = (await cli('resume', '--add-rounds', '5')).stdout;
  assert.match(addRounds, /ignored: rounds are no longer a limit/);
  assert.match(addRounds, /still halted; run plain `resume`/, 'M1: the notice says the bus is still halted');
  assert.equal(await fs.readFile(statePath(f.root), 'utf8'), beforeAdd, '--add-rounds changes nothing');
  assert.equal((await readState(f.root)).halted, true);
  await cli('resume');
  assert.equal((await readState(f.root)).halted, false);
  const sent = await cli('send', '--from', 'codex', '--to', 'grok', '--subject', 'after resume', '--body', 'works');
  assert.match(sent.stdout, /.+/);
});

test('T11 lock-free readers race an archive deleting 2,000 files: zero errors, no unread missed', async (t) => {
  const f = await fixture(['codex', 'grok'], { retention: { keepRecent: 0, minAgeHours: 0, batch: 500, maxUnreadPerSeat: 3000 } });
  t.after(f.cleanup);
  for (let index = 0; index < 2000; index += 1) await f.store.send({ from: 'codex', to: 'grok', subject: `r${index}`, body: 'x' });
  await f.store.read('grok', true);
  const unread = [];
  for (let index = 0; index < 5; index += 1) unread.push((await send(f.store, 'grok', `keep ${index}`)).seq);
  const reader = new MailboxStore(f.root);
  let stop = false;
  let loops = 0;
  const errors = [];
  const race = (async () => {
    while (!stop) {
      try {
        const [inbox] = await Promise.all([reader.inbox('grok'), reader.status()]);
        assert.deepEqual(inbox.map((message) => message.seq), unread);
        loops += 1;
      } catch (error) {
        errors.push(error);
      }
      // Real seats poll; they do not hold state.json open in a zero-gap loop. Yield briefly so
      // the writer's atomic publish can land on Windows (where an open reader blocks rename).
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
  })();
  let run;
  try {
    run = await f.store.archive();
  } finally {
    stop = true;
    await race;
  }
  assert.equal(run.archived, 2000);
  assert.ok(loops > 0);
  assert.deepEqual(errors.map(String), []);
});

test('T12 referenced mail is never archived; evidence on an archived seq gives the archived hint', async (t) => {
  const f = await fixture(['codex', 'grok'], { retention: { keepRecent: 0, minAgeHours: 0 } });
  t.after(f.cleanup);
  await fs.mkdir(path.join(f.root, 'src'), { recursive: true });
  await fs.writeFile(path.join(f.root, 'src', 'a.ts'), 'x', 'utf8');
  const evidenced = await send(f.store, 'grok', 'evidence target');
  const claimed = await send(f.store, 'grok', 'claim target');
  const baton = await send(f.store, 'grok', 'baton target');
  const plain = await send(f.store, 'grok', 'plain');
  await f.store.read('grok', true);
  await f.store.recordEvidence({ agent: 'grok', subject: 'proof', statement: 'tests pass', workId: evidenced.seq });
  await f.store.claim({ agent: 'grok', paths: ['src/a.ts'], why: `implementing #${claimed.seq}` });
  await f.store.reassignBaton({ to: 'grok', reason: `continue #${baton.seq}`, by: 'operator' }).catch(() => undefined);
  const state = await readState(f.root);
  if (!state.baton || !String(state.baton.reason).includes(`#${baton.seq}`)) {
    state.baton = { holder: 'grok', since: new Date(f.clock.now).toISOString(), reason: `continue #${baton.seq}` };
    await fs.writeFile(statePath(f.root), JSON.stringify(state), 'utf8');
  }
  const run = await f.store.archive({ pressure: true });
  const hot = await hotSeqs(f.root);
  assert.ok(hot.includes(evidenced.seq) && hot.includes(claimed.seq) && hot.includes(baton.seq));
  assert.equal(hot.includes(plain.seq), false);
  assert.equal(run.batches[0].blocked.pinned, 3);
  await assert.rejects(
    f.store.recordEvidence({ agent: 'grok', subject: 'late', statement: 'x', workId: plain.seq }),
    /archived/
  );
});

test('T13 expire: dry-run is inert; expire -> archived --expired -> unarchive + requeue restores; parked and pinned skipped', async (t) => {
  const f = await fixture(['codex', 'grok'], { retention: { keepRecent: 0, minAgeHours: 0 } });
  t.after(f.cleanup);
  const a = await send(f.store, 'grok', 'a');
  const b = await send(f.store, 'grok', 'b');
  const parked = await send(f.store, 'grok', 'parked');
  const pinned = await send(f.store, 'grok', 'pinned');
  await f.store.park('grok', parked.seq, 'poison');
  await f.store.setGoal({ statement: `see #${pinned.seq}`, doneWhen: 'done' });
  const before = await fs.readFile(statePath(f.root), 'utf8');
  const hotBefore = await hotSeqs(f.root);
  const dry = await f.store.expire({ seat: 'grok', dryRun: true });
  assert.deepEqual(dry.expired, [a.seq, b.seq]);
  assert.deepEqual(dry.skipped.parked, [parked.seq]);
  assert.deepEqual(dry.skipped.pinned, [pinned.seq]);
  assert.equal(await fs.readFile(statePath(f.root), 'utf8'), before);
  assert.deepEqual(await hotSeqs(f.root), hotBefore);
  await assert.rejects(f.store.expire({ seat: 'grok' }), /--reason/);

  const done = await f.store.expire({ seat: 'grok', reason: 'synthetic test unread' });
  assert.deepEqual(done.expired, [a.seq, b.seq]);
  assert.deepEqual((await f.store.inbox('grok')).map((message) => message.seq), [pinned.seq]);
  assert.equal((await f.store.snapshot()).queue.unread.grok, 1);
  await f.store.archive();
  assert.deepEqual((await f.store.archived({ expired: true })).map((row) => row.seq), [a.seq, b.seq]);
  const epoch = (await readState(f.root)).mailEpoch ?? 0;
  await f.store.unarchive([a.seq]);
  const requeued = await f.store.requeue('grok', a.seq);
  assert.equal(requeued.read, false);
  assert.equal(requeued.expiredAt, undefined);
  assert.ok((await readState(f.root)).mailEpoch >= epoch + 2);
  assert.deepEqual((await f.store.inbox('grok')).map((message) => message.seq), [a.seq, pinned.seq]);
});

test('T17 unread counter drift is corrected by recount; refusals need a trusted recount', async (t) => {
  const f = await fixture(['codex', 'grok'], { retention: { maxUnreadPerSeat: 5 } });
  t.after(f.cleanup);
  // (a) counter forced high while real unread is low: send recounts and is not refused
  await send(f.store, 'grok', 'one');
  const state = await readState(f.root);
  state.queue.unread.grok = 999;
  state.queue.unreadVerifiedAt = {};
  await fs.writeFile(statePath(f.root), JSON.stringify(state), 'utf8');
  const recountsBefore = f.store.metrics.recounts;
  await send(f.store, 'grok', 'two');
  assert.equal(f.store.metrics.recounts, recountsBefore + 1);
  assert.equal((await readState(f.root)).queue.unread.grok, 2);
  // (b) really full: 10 sends inside 60 s => exactly one recount, all refused (retry 300 s)
  for (let index = 0; index < 3; index += 1) await send(f.store, 'grok', `fill ${index}`);
  const recountsFull = f.store.metrics.recounts;
  for (let index = 0; index < 10; index += 1) {
    const error = await send(f.store, 'grok', `refused ${index}`).catch((caught) => caught);
    assert.ok(error instanceof QueueFullError);
    assert.equal(error.seat, 'grok');
    assert.equal(error.retryAfterMs, 300_000);
    f.clock.now += 1_000;
  }
  assert.ok(f.store.metrics.recounts - recountsFull <= 1, 'at most one recount for ten refusals in 60 s');
  // other seats are unaffected
  await send(f.store, 'codex', 'codex still reachable', 'grok');
  // (c) an out-of-band read (old binary or another process) then the timer: counter matches inbox
  const other = new MailboxStore(f.root);
  await other.read('grok', true);
  f.clock.now += 2 * HOUR;
  await f.store.maintenanceTick();
  assert.equal((await readState(f.root)).queue.unread.grok, (await f.store.inbox('grok')).length);
  // (d) crash between message write and state write: counter low until the next recount
  const name = (await fs.readdir(inboxDir(f.root))).sort().at(-1);
  const template = JSON.parse(await fs.readFile(path.join(inboxDir(f.root), name), 'utf8'));
  const orphanSeq = (await readState(f.root)).seq + 1;
  const orphan = { ...template, seq: orphanSeq, to: 'grok', read: false };
  delete orphan.readAt;
  await fs.writeFile(path.join(inboxDir(f.root), name.replace(/^\d+/, String(orphanSeq).padStart(6, '0'))), JSON.stringify(orphan), 'utf8');
  assert.equal((await readState(f.root)).queue.unread.grok, 0, 'counter is low after the simulated crash');
  await f.store.archive({ dryRun: false });
  assert.equal((await readState(f.root)).queue.unread.grok, 1, 'archive recount fixes it');
  const next = await send(f.store, 'grok', 'after orphan');
  assert.equal(next.seq, orphanSeq + 1, 'seq comes from the filename high-water');
});

// ---------------------------------------------------------------- CODE-REVIEW-4.4 M1-M4

test('M1 upgrade-state rewrites a legacy round-guard halt; neither state nor brief mentions maxRounds', async (t) => {
  const f = await fixture(['codex', 'grok']);
  t.after(f.cleanup);
  await send(f.store, 'grok', 'm');
  await f.store.halt('maxRounds (6000) reached; run resume --add-rounds N', { force: true });
  const state = await readState(f.root);
  state.schema = 1;
  delete state.retention;
  await fs.writeFile(statePath(f.root), JSON.stringify(state), 'utf8');
  // Before any write, the brief already shows the rewritten text (display rewrite).
  assert.doesNotMatch((await f.store.statusBrief('grok')).stopReason, /maxRounds|add-rounds/);
  const cli = (...args) => execFileAsync(process.execPath, [mailboxCli, ...args, '--root', f.root]);
  await cli('upgrade-state');
  const upgraded = await readState(f.root);
  assert.equal(upgraded.halted, true, 'upgrade does not clear the halt');
  assert.doesNotMatch(upgraded.stopReason, /maxRounds|add-rounds/);
  assert.match(upgraded.stopReason, /plain `resume`/);
  const brief = await f.store.statusBrief('grok');
  assert.doesNotMatch(brief.stopReason, /maxRounds|add-rounds/);
  assert.match(brief.stopReason, /plain `resume`/);
  const notice = (await cli('resume', '--add-rounds', '5')).stdout;
  assert.match(notice, /still halted; run plain `resume`/);
  assert.equal((await readState(f.root)).halted, true);
  await cli('resume');
  assert.equal((await readState(f.root)).halted, false);
  // A non-legacy halt reason is left alone.
  await f.store.halt('owner pause for review', { force: true });
  await cli('upgrade-state');
  assert.equal((await readState(f.root)).stopReason, 'owner pause for review');
});

test('M2 the implicit 1 -> 2 migration sizes the cap to the backlog (250 unread -> cap 400), no refusal', async (t) => {
  const f = await fixture(['codex', 'grok'], { retention: { maxUnreadPerSeat: 3000 } });
  t.after(f.cleanup);
  for (let index = 0; index < 250; index += 1) await send(f.store, 'grok', `backlog ${index}`);
  const state = await readState(f.root);
  state.schema = 1;
  state.retention = {};
  delete state.queue;
  await fs.writeFile(statePath(f.root), JSON.stringify(state), 'utf8');
  const fresh = f.make();
  const ok = await fresh.send({ from: 'codex', to: 'grok', subject: 'ordinary send after migration', body: 'x' });
  assert.ok(ok.seq > 250, 'not refused at the default cap of 200');
  const upgraded = await readState(f.root);
  assert.equal(upgraded.schema, 2);
  assert.equal(upgraded.retention.maxUnreadPerSeat, 400);
  // A schema-1 state that already has a cap keeps it.
  upgraded.schema = 1;
  upgraded.retention = { maxUnreadPerSeat: 500 };
  await fs.writeFile(statePath(f.root), JSON.stringify(upgraded), 'utf8');
  await f.make().send({ from: 'codex', to: 'grok', subject: 'keeps cap', body: 'x' });
  assert.equal((await readState(f.root)).retention.maxUnreadPerSeat, 500);
});

test('M3 a failing in-send prune waits the pressure interval; backstop retryAfterMs is never 0', async (t) => {
  const f = await fixture(['codex', 'grok'], { retention: { keepRecent: 0, pinnedAllowance: 0, maxUnreadPerSeat: 1, minAgeHours: 0 } });
  t.after(f.cleanup);
  // maxHot = 0 + 0 + 2*1 + 100 = 102; pressure starts at 82 hot.
  let batches = 0;
  const failing = f.make({ archiveFault: (at) => {
    if (at === 'after-tmp') { batches += 1; throw new Error('injected persistent archive failure'); }
  } });
  const refusals = [];
  for (let index = 0; index < 130; index += 1) {
    const outcome = await failing.send({ from: 'codex', to: 'grok', subject: `s${index}`, body: 'x' }).catch((error) => error);
    if (outcome instanceof QueueFullError) refusals.push(outcome);
    else if (outcome instanceof Error) throw outcome;
    await failing.read('grok', true);
  }
  assert.equal(batches, 1, 'one failed batch, then the guard waits the pressure interval (no re-prune per send)');
  assert.ok(refusals.length > 0, 'the backstop refuses once full');
  for (const refusal of refusals) {
    assert.equal(refusal.scope, 'backstop');
    assert.ok(refusal.retryAfterMs >= 60_000, `retryAfterMs ${refusal.retryAfterMs} must be >= 60s`);
    assert.ok(refusal.retryAfterMs <= 5 * 60_000, `retryAfterMs ${refusal.retryAfterMs} is at most the pressure interval`);
  }
  const state = await readState(f.root);
  assert.ok(state.queue.lastPruneAttemptAt, 'the failed attempt is recorded');
  // After the pressure interval the guard tries again (still failing here) exactly once more.
  f.clock.now += 5 * 60_000 + 1;
  await failing.send({ from: 'codex', to: 'grok', subject: 'after interval', body: 'x' }).catch(() => undefined);
  assert.equal(batches, 2);
  // With the fault gone, the next due prune succeeds and clears the attempt marker.
  f.clock.now += 5 * 60_000 + 1;
  await failing.read('grok', true);
  const healthy = f.make();
  await healthy.send({ from: 'codex', to: 'grok', subject: 'healthy', body: 'x' });
  const after = await readState(f.root);
  assert.ok(after.queue.lastPruneAt, 'a successful prune ran');
  assert.equal(after.queue.lastPruneAttemptAt, undefined);
  assert.deepEqual((await f.store.doctor()).problems, []);
});

test('M4 a post-commit state publish failure in an archive run is recovered, not thrown', async (t) => {
  const f = await fixture(['codex', 'grok'], { retention: { keepRecent: 0, minAgeHours: 0, batch: 300, maxUnreadPerSeat: 3000 } });
  t.after(f.cleanup);
  for (let index = 0; index < 600; index += 1) await f.store.send({ from: 'codex', to: 'grok', subject: `r${index}`, body: 'x' });
  await f.store.read('grok', true);
  await anchor(f.store);
  let blockedUntil = 0;
  let blockedRenames = 0;
  let armed = true;
  const store = f.make({
    archiveFault: (at) => { if (at === 'before-state' && armed) { armed = false; blockedUntil = Date.now() + 2_300; } },
    renameFile: async (source, destination) => {
      if (path.basename(destination) === 'state.json' && Date.now() < blockedUntil) {
        blockedRenames += 1;
        const error = new Error('EPERM: simulated reader holding state.json');
        error.code = 'EPERM';
        throw error;
      }
      await fs.rename(source, destination);
    }
  });
  const run = await store.archive();
  assert.ok(blockedRenames > 0, 'the publish was blocked');
  assert.equal(run.archived, 600, 'both batches count; the run did not abort');
  assert.match(run.batches[0].warning ?? '', /publish failed/);
  await store.archive();
  await assert.rejects(fs.access(path.join(archiveDir(f.root), 'journal.json')));
  assert.deepEqual((await f.store.doctor()).problems, []);
  const state = await readState(f.root);
  assert.equal(state.queue.archived, 600);
});
