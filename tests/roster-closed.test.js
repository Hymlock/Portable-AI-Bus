const assert = require('node:assert/strict');
const test = require('node:test');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { MailboxStore } = require('../dist/mailbox.js');

/**
 * A seat is a FUNDED ACTOR. It is not a name that happened to show up.
 *
 * Live cost: the roster drifted to five seats - claude, codex, grok, hymlock, worker - when only
 * three vendors were ever funded. `hymlock` is the human operator, who holds no vendor wallet and
 * therefore cannot be a seat at all; `worker` was an invented seat served by codex's wallet, which
 * silently doubled that vendor's concurrency. 117 reports were addressed to `hymlock`, a seat that
 * can never read anything, and were never delivered to a human.
 *
 * Two independent defects produced that, both measured before this test was written:
 *   1. any well-formed name became a seat merely by claiming a path or sending a message;
 *   2. `init --agents` UNIONED with the existing roster, so a later correct run could never
 *      evict a name that should not have been there. Ghosts were permanent.
 */

function tempRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'roster-closed-'));
  test.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

const SEATS = ['claude', 'codex', 'grok'];

test('an unlisted name cannot join the roster by claiming a path', async () => {
  const store = new MailboxStore(tempRoot());
  await store.ensureInitialized(SEATS, 50);

  await assert.rejects(
    () => store.claim({ agent: 'ghost', paths: ['some/file.txt'], why: 'probe' }),
    /not a seat|unknown/i,
    'acting must not be a way to become a seat'
  );

  const state = await store.status();
  assert.deepEqual(state.agents.slice().sort(), SEATS.slice().sort());
});

test('an unlisted name cannot join the roster by sending mail', async () => {
  const store = new MailboxStore(tempRoot());
  await store.ensureInitialized(SEATS, 50);

  await assert.rejects(
    () => store.send({ from: 'ghost', to: 'claude', kind: 'note', subject: 's', body: 'b' }),
    /not a seat|unknown/i
  );

  const state = await store.status();
  assert.equal(state.agents.length, 3);
});

test('init is authoritative: a name dropped from --agents is retired', async () => {
  const store = new MailboxStore(tempRoot());
  await store.ensureInitialized([...SEATS, 'worker'], 50);
  assert.equal((await store.status()).agents.length, 4, 'precondition: worker was seated');

  const after = await store.ensureInitialized(SEATS, 50);
  assert.deepEqual(after.agents.slice().sort(), SEATS.slice().sort(),
    'the roster passed to init IS the roster, not an addition to it');
});

test('retiring a seat that still holds claims is refused, not done silently', async () => {
  // Silent retirement would orphan the claim and let another seat edit the same file.
  const store = new MailboxStore(tempRoot());
  await store.ensureInitialized([...SEATS, 'worker'], 50);
  await store.claim({ agent: 'worker', paths: ['scripts/thing.js'], why: 'mid-flight work' });

  await assert.rejects(
    () => store.ensureInitialized(SEATS, 50),
    /claim/i,
    'an operator must resolve the claim deliberately rather than lose it'
  );

  assert.ok((await store.status()).agents.includes('worker'), 'and the seat survives the refusal');
});

test('a seat listed in init keeps working normally', async () => {
  const store = new MailboxStore(tempRoot());
  await store.ensureInitialized(SEATS, 50);
  await store.claim({ agent: 'codex', paths: ['src/bus.ts'], why: 'real work' });
  const message = await store.send({ from: 'codex', to: 'claude', kind: 'report', subject: 's', body: 'b' });
  assert.equal(message.from, 'codex', 'the guard must not break the funded seats it protects');
});
