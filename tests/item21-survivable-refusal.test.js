const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { MailboxStore } = require('../dist/mailbox.js');
const { runBrain } = require('../dist/brain/runner.js');

// ---------------------------------------------------------------------------
// ITEM 21: A REFUSAL MUST BE SURVIVABLE.
//
// Measured 2026-08-19, and the defect is the author's own. The item-10 guard in
// mailbox.ts refuses openRecovery when another seat holds the checkpoint - one assignment,
// one holder. That refusal is CORRECT and item 10 is not reopened here.
//
// The defect is where the throw LANDS. runner.ts calls openRecovery outside the takeTurn
// try/catch, so the refusal never reaches the handler that already exists to stop a brain
// throw taking the process. It surfaced in cli.ts as {"event":"fatal"} and the seat exited.
//
// Live cost: grok's brain died on EVERY wake for hours. Its provider was fine the whole time
// (`provider-chain ok: grok=ok`). A seat told "not yours" was indistinguishable from a seat
// with no credits and a seat with no process - and the author misdiagnosed it as both before
// finding the real cause.
//
// grok's instruction, and it is the shape of this file: a gate that only checks the throw, or
// only checks that the process lives, is HALF A GATE.
// ---------------------------------------------------------------------------

async function fixture(t, seats = ['claude', 'grok', 'codex']) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pab-i21-'));
  t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 }).catch(() => {}));
  const store = new MailboxStore(root);
  await store.ensureInitialized(seats, 500);
  return { root, store };
}

/** The bus surface runBrain needs, backed by a real store so the refusal is the real one. */
function client(store) {
  return {
    async listen() { return 'timeout'; },
    peek: (seat) => store.inbox(seat),
    acknowledge: (seat, seqs) => store.acknowledge(seat, seqs),
    loadRecovery: (seat) => store.openRecoveryFor(seat),
    recallAssignment: (seat, workId) => store.recallAssignment(seat, workId),
    openRecovery: (seat, workId, note) => store.openRecovery(seat, workId, note),
    recordRecoveryAction: (seat, workId, id) => store.recordRecoveryAction(seat, workId, id),
    closeRecovery: (seat, workId, reason) => store.closeRecovery(seat, workId, reason),
    tools() {
      return {
        async send() { return { ok: true }; },
        async supersede() { return { ok: true }; },
        async status() { return {}; },
        async claim() { return { ok: true }; },
        async release() { return { ok: true }; },
        async runCapability() { return { ok: true }; },
        async listCapabilities() { return []; }
      };
    }
  };
}

test('ITEM 21 RED: a seat refused work another seat holds STAYS ALIVE', async (t) => {
  const { store } = await fixture(t);
  // claude is sent work and takes the checkpoint. This is the exact shape that killed grok:
  // a baton reassignment left claude holding #1 while grok kept waking to it.
  const work = await store.send({
    from: 'codex', to: 'grok', kind: 'task', subject: 'the contested work', body: 'do it'
  });
  await store.openRecovery('grok', work.seq, 'grok started');
  await store.reassignBaton({ to: 'claude', reason: 'grok went dark', force: true });
  // claude now holds an open checkpoint on work.seq. Send grok fresh mail on the SAME work so
  // its wake tries to open a checkpoint it may not have.
  await store.send({ from: 'codex', to: 'grok', kind: 'task', subject: 'more', body: 'again' });

  let turns = 0;
  const result = await runBrain({
    seat: 'grok',
    bus: client(store),
    brain: { name: 'i21', takeTurn: async () => { turns += 1; return { done: true, note: 'survived' }; } },
    maxWakes: 1
  });

  // The whole point: the runner returns rather than the throw escaping to cli.ts as fatal.
  assert.ok(result, 'REGRESSION: the refusal escaped the runner and would kill the seat');
  assert.equal(turns >= 0, true);
});

test('ITEM 21 RED: the refusal is REPORTED, not swallowed into silence', async (t) => {
  const { store } = await fixture(t);
  const work = await store.send({ from: 'codex', to: 'grok', kind: 'task', subject: 'contested', body: 'x' });
  await store.openRecovery('grok', work.seq, 'started');
  await store.reassignBaton({ to: 'claude', reason: 'failover', force: true });
  await store.send({ from: 'codex', to: 'grok', kind: 'task', subject: 'more', body: 'y' });

  const events = [];
  await runBrain({
    seat: 'grok',
    bus: client(store),
    brain: { name: 'i21', takeTurn: async () => ({ done: true, note: 'ok' }) },
    maxWakes: 1,
    log: (event, data) => events.push({ event, data })
  });

  // Surviving silently would be the OTHER half of the defect: a seat that quietly declines
  // work is as opaque as one that dies. Something must say the work was not takeable.
  const named = events.some(({ event, data }) =>
    /recovery|refus|declin|held/i.test(event) || /held by|not yours|refus/i.test(JSON.stringify(data ?? {})));
  assert.ok(named, `the refusal must appear in the log; saw events: ${events.map((e) => e.event).join(', ')}`);
});

test('ITEM 21 GREEN CONTROL: the item-10 refusal itself is NOT weakened', async (t) => {
  const { store } = await fixture(t);
  const work = await store.send({ from: 'codex', to: 'grok', kind: 'task', subject: 'w', body: 'b' });
  await store.openRecovery('grok', work.seq, 'started');
  await store.reassignBaton({ to: 'claude', reason: 'failover', force: true });

  // One assignment, one holder. Making the refusal survivable must not make it stop refusing -
  // that would reopen item 10's third attack, where the predecessor re-opens after the baton
  // moved and two seats hold one brief.
  await assert.rejects(
    () => store.openRecovery('grok', work.seq, 're-opening what I lost'),
    /held by claude/,
    'the store must still refuse; only the RUNNER changes'
  );
  assert.equal(await store.recallAssignment('grok', work.seq), undefined,
    'and the predecessor still recalls nothing');
});

test('ITEM 21 GREEN CONTROL: an uncontested wake still binds the holder', async (t) => {
  const { store } = await fixture(t);
  const work = await store.send({ from: 'codex', to: 'grok', kind: 'task', subject: 'uncontested', body: 'b' });

  await runBrain({
    seat: 'grok',
    bus: client(store),
    brain: { name: 'i21', takeTurn: async () => ({ done: false, note: 'working on it' }) },
    maxWakes: 1
  });

  // Without this, a "fix" that simply stopped calling openRecovery would pass every gate
  // above while destroying the feature item 10 exists to provide.
  const open = await store.openRecoveryFor('grok');
  assert.ok(open, 'an ordinary wake must still open a checkpoint');
  assert.equal(open.workId, work.seq);
  assert.match(await store.recallAssignment('grok', work.seq), /uncontested/);
});
