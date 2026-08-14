const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

const { MailboxStore } = require('../dist/mailbox.js');
const { runBrain } = require('../dist/brain/runner.js');

function recoveryClient(store, tools = {}) {
  return {
    async listen() { return 'timeout'; },
    peek: (seat) => store.inbox(seat),
    acknowledge: (seat, count) => store.read(seat, false, count),
    loadRecovery: (seat) => store.openRecoveryFor(seat),
    openRecovery: (seat, workId, note) => store.openRecovery(seat, workId, note),
    recordRecoveryAction: (seat, workId, id) => store.recordRecoveryAction(seat, workId, id),
    closeRecovery: (seat, workId, reason) => store.closeRecovery(seat, workId, reason),
    listEvidence: (workIds) => store.evidenceForWake(workIds),
    tools() {
      return {
        async send() { return { ok: true }; },
        async status() { return { agents: ['claude', 'codex', 'grok'] }; },
        async claim() { return {}; },
        async release() { return {}; },
        async runCapability() { return {}; },
        async listCapabilities() { return []; },
        ...tools
      };
    }
  };
}

async function mailboxWithOpenWork() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pab-reassign-'));
  const store = new MailboxStore(root);
  await store.ensureInitialized(['claude', 'codex', 'grok'], 100);
  const assigned = await store.send({
    from: 'claude',
    to: 'codex',
    kind: 'task',
    subject: 'DELTA D',
    body: 'do not lose this brief'
  });
  const checkpoint = await store.openRecovery('codex', assigned.seq, 'paused at the verifier boundary');
  const committedSend = '0:{"body":"already sent","kind":"report","subject":"partial","to":"claude","type":"send"}';
  await store.recordRecoveryAction('codex', assigned.seq, committedSend);
  return { root, store, assigned, checkpoint, committedSend };
}

test('a successor cannot inherit another seat\'s open checkpoint without reassignment', async (t) => {
  const { root, store, assigned } = await mailboxWithOpenWork();
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  await assert.rejects(
    () => store.openRecovery('grok', assigned.seq, 'I took the baton'),
    /addressed to codex/
  );
  assert.equal(await store.openRecoveryFor('grok'), undefined);
  const stillOpen = await store.openRecoveryFor('codex');
  assert.equal(stillOpen.workId, assigned.seq);
  assert.equal(stillOpen.seat, 'codex');
});

test('reassigning the baton transfers the open checkpoint, receipts, and workId', async (t) => {
  const { root, store, assigned } = await mailboxWithOpenWork();
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  const moved = await store.reassignBaton({
    to: 'grok',
    reason: 'codex out of providers',
    force: true
  });
  assert.equal(moved.moved, true);
  assert.equal(moved.from, 'codex');
  assert.equal(moved.inheritedWorkId, assigned.seq);

  const inherited = await store.openRecoveryFor('grok');
  assert.ok(inherited, 'successor must see the previous holder\'s open work');
  assert.equal(inherited.workId, assigned.seq);
  assert.equal(inherited.seat, 'grok');
  assert.equal(inherited.note, 'paused at the verifier boundary');
  assert.deepEqual(inherited.actionReceipts, [
    '0:{"body":"already sent","kind":"report","subject":"partial","to":"claude","type":"send"}'
  ]);
  assert.equal(inherited.inheritedFrom, 'codex');

  const previous = (await store.inbox('codex'))[0].recoveryCheckpoints.find((item) => item.seat === 'codex');
  assert.equal(previous.status, 'closed');
  assert.match(previous.closeReason, /reassigned to grok/);
  assert.equal(previous.note, 'paused at the verifier boundary');
  assert.equal(await store.openRecoveryFor('codex'), undefined);
});

test('a third seat still cannot steal the inherited work', async (t) => {
  const { root, store, assigned } = await mailboxWithOpenWork();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await store.reassignBaton({ to: 'grok', reason: 'credit loss', force: true });

  await assert.rejects(
    () => store.openRecovery('claude', assigned.seq, 'not mine'),
    /addressed to codex/
  );
  assert.equal(await store.openRecoveryFor('claude'), undefined);
});

test('the successor continues the inherited note without the original brief being resent', async (t) => {
  const { root, store, assigned } = await mailboxWithOpenWork();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await store.read('codex', false, 1);
  await store.reassignBaton({ to: 'grok', reason: 'codex spent', force: true });
  await store.send({
    from: 'codex',
    to: 'grok',
    kind: 'handoff',
    subject: 'codex is out of providers - baton is yours',
    body: 'Every provider in my chain is spent'
  });

  let recovered;
  await runBrain({
    seat: 'grok',
    bus: recoveryClient(store),
    brain: { name: 'successor', async takeTurn(context) { recovered = context; return { done: false, note: context.openWork }; } },
    maxWakes: 1
  });

  assert.equal(recovered.openWork, 'paused at the verifier boundary');
  assert.equal(recovered.recoveryData, 'paused at the verifier boundary');
  assert.equal(
    recovered.recoveryActionIds[0],
    '0:{"body":"already sent","kind":"report","subject":"partial","to":"claude","type":"send"}'
  );
  assert.equal((await store.openRecoveryFor('grok')).workId, assigned.seq,
    'a courtesy handoff must not supersede the inherited workId');
});

test('inherited receipts still suppress replay on the successor seat', async (t) => {
  const { root, store } = await mailboxWithOpenWork();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await store.reassignBaton({ to: 'grok', reason: 'codex spent', force: true });

  let effects = 0;
  const client = recoveryClient(store, {
    async send() { effects += 1; return { ok: true }; }
  });
  const plan = {
    actions: [{ type: 'send', to: 'claude', kind: 'report', subject: 'partial', body: 'already sent' }],
    done: false,
    note: 'continue after inherit'
  };
  const { createAgentBrain } = require('../dist/brain/brains/agent.js');
  await runBrain({
    seat: 'grok',
    bus: client,
    brain: createAgentBrain({
      seat: 'grok',
      maxRounds: 1,
      provider: {
        kind: 'test',
        async ask() { return { isError: false, text: JSON.stringify(plan) }; }
      }
    }),
    maxWakes: 1
  });
  assert.equal(effects, 0, 'the successor must not replay an action the previous holder already committed');
});
