const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const { spawnSync } = require('node:child_process');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
require('./helpers/require-fresh-dist')();
const { MailboxStore } = require('../dist/mailbox.js');
const { createExhaustionHandler } = require('../dist/brain/cli.js');

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

test('expected holder prevents a failover race from stealing a newly moved baton', async (t) => {
  const { root, mailbox } = await store();
  t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 10 }));
  await mailbox.send({ from: 'grok', to: 'claude', kind: 'note', subject: 'drive', body: 'x' });
  await mailbox.send({ from: 'claude', to: 'grok', kind: 'note', subject: 'moved meanwhile', body: 'x' });
  const result = await mailbox.reassignBaton({
    to: 'codex', reason: 'stale observation', force: true, expectedFrom: 'claude'
  });
  assert.equal(result.moved, false);
  assert.match(result.why, /changed/i);
  assert.equal((await mailbox.status()).baton.holder, 'grok');
});

test('exhausted non-holder cannot steal baton and a holder hands off only once', async (t) => {
  const { root, mailbox } = await store();
  t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 10 }));
  await mailbox.send({ from: 'grok', to: 'claude', kind: 'note', subject: 'drive', body: 'x' });

  const logs = [];
  const nonHolder = createExhaustionHandler({ seat: 'grok', root, log: (event) => logs.push(event) });
  await nonHolder({ seat: 'grok', detail: 'all links spent' });
  assert.equal((await mailbox.status()).baton.holder, 'claude');
  assert.ok(logs.includes('exhausted-not-holder'));

  const holder = createExhaustionHandler({ seat: 'claude', root, log: (event) => logs.push(event) });
  await holder({ seat: 'claude', detail: 'all links spent' });
  assert.equal((await mailbox.status()).baton.holder, 'codex');
  const firstInbox = await mailbox.inbox('codex');
  assert.equal(firstInbox.filter((m) => m.kind === 'handoff').length, 1);
  await holder({ seat: 'claude', detail: 'still spent' });
  const secondInbox = await mailbox.inbox('codex');
  assert.equal(secondInbox.filter((m) => m.kind === 'handoff').length, 1, 'no repeated handoff storm');
});

test('ITEM 11: BROKEN detail does not announce out of providers or move the baton', async (t) => {
  const { root, mailbox } = await store();
  t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 10 }));
  await mailbox.send({ from: 'grok', to: 'claude', kind: 'note', subject: 'drive', body: 'x' });

  const logs = [];
  const holder = createExhaustionHandler({
    seat: 'claude',
    root,
    log: (event, data) => logs.push({ event, data })
  });
  await holder({
    seat: 'claude',
    detail: "BROKEN:ConPTY unavailable: Cannot find module 'node-pty'"
  });

  assert.equal((await mailbox.status()).baton.holder, 'claude', 'holder stays; remedy is fix the machine');
  assert.equal(logs.some((entry) => entry.event === 'chain-broken'), true);
  assert.match(logs.find((entry) => entry.event === 'chain-broken').data.error, /Cannot find module/);
  const inbox = await mailbox.inbox('codex');
  assert.equal(inbox.filter((m) => m.kind === 'handoff').length, 0);
  assert.equal(inbox.some((m) => /out of providers/.test(m.subject || '')), false);
});

test('mailbox CLI exposes guarded reassign recovery', async (t) => {
  const { root, mailbox } = await store();
  t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 10 }));
  await mailbox.send({ from: 'grok', to: 'claude', kind: 'note', subject: 'drive', body: 'x' });
  const cli = spawnSync(process.execPath, [
    require.resolve('../dist/mailbox.js'), 'reassign', '--root', root,
    '--to', 'grok', '--reason', 'operator verified exhaustion', '--force', '--json'
  ], { encoding: 'utf8', windowsHide: true });
  assert.equal(cli.status, 0, `stdout=${cli.stdout} stderr=${cli.stderr} error=${cli.error}`);
  assert.equal(JSON.parse(cli.stdout).moved, true);
  assert.equal((await mailbox.status()).baton.holder, 'grok');
});
