const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { MailboxStore } = require('../dist/mailbox.js');

async function store() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'baton-failover-'));
  const mailbox = new MailboxStore(root);
  await mailbox.ensureInitialized(['claude', 'codex', 'grok'], 100);
  return { root, mailbox };
}

async function age(mailbox, seconds) {
  // Backdate the baton rather than sleeping. The guard is about elapsed time, and a test that
  // waits five real minutes is a test nobody runs.
  const statePath = path.join(mailbox.paths.statePath);
  const state = JSON.parse(await fs.readFile(statePath, 'utf8'));
  state.baton.since = new Date(Date.now() - seconds * 1000).toISOString();
  await fs.writeFile(statePath, JSON.stringify(state, null, 2), 'utf8');
}

test('a stranded baton can be reassigned once the holder has gone quiet', async (t) => {
  // The scenario Hymlock named: the orchestrating seat runs out of tokens. stallCheck could
  // already SEE this; nothing could fix it. Detection without recovery is a smoke alarm with
  // no fire exit.
  const { root, mailbox } = await store();
  t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 10 }));

  await mailbox.send({ from: 'grok', to: 'claude', kind: 'note', subject: 'you drive', body: 'x' });
  assert.equal((await mailbox.status()).baton.holder, 'claude');

  await age(mailbox, 600);
  const result = await mailbox.reassignBaton({ to: 'grok', reason: 'claude out of tokens', staleAfterSeconds: 300 });

  assert.equal(result.moved, true);
  assert.equal(result.from, 'claude');
  assert.equal((await mailbox.status()).baton.holder, 'grok');
  assert.match(result.why, /claude/, 'the record must say who it came from and why');
});

test('the baton cannot be taken from an ACTIVE holder', async (t) => {
  // This guard is what separates failover from a coup. Two seats making decisions is worse
  // than a stall: a stall is visible and recoverable, contradictory work is neither.
  const { root, mailbox } = await store();
  t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 10 }));

  await mailbox.send({ from: 'grok', to: 'claude', kind: 'note', subject: 'you drive', body: 'x' });
  const result = await mailbox.reassignBaton({ to: 'grok', reason: 'I want it', staleAfterSeconds: 300 });

  assert.equal(result.moved, false);
  assert.equal((await mailbox.status()).baton.holder, 'claude', 'active holder keeps it');
  assert.match(result.why, /coup/i, 'the refusal should say why, not just refuse');
});

test('force overrides the guard, for an operator who can see the truth', async (t) => {
  const { root, mailbox } = await store();
  t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 10 }));

  await mailbox.send({ from: 'grok', to: 'claude', kind: 'note', subject: 'you drive', body: 'x' });
  const result = await mailbox.reassignBaton({ to: 'codex', reason: 'operator override', force: true });

  assert.equal(result.moved, true);
  assert.equal((await mailbox.status()).baton.holder, 'codex');
});

test('reassigning to an unknown agent is refused', async (t) => {
  const { root, mailbox } = await store();
  t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 10 }));
  await assert.rejects(
    () => mailbox.reassignBaton({ to: 'nobody', reason: 'typo', force: true }),
    /unknown agent/
  );
});

test('reassigning to the current holder is a no-op, not an error', async (t) => {
  const { root, mailbox } = await store();
  t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 10 }));
  await mailbox.send({ from: 'grok', to: 'claude', kind: 'note', subject: 'drive', body: 'x' });
  const result = await mailbox.reassignBaton({ to: 'claude', reason: 'redundant', force: true });
  assert.equal(result.moved, false);
  assert.match(result.why, /already holds/);
});
