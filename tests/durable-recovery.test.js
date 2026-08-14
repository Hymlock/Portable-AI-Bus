const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { MailboxStore } = require('../dist/mailbox.js');
const { runBrain } = require('../dist/brain/runner.js');
const { createAgentBrain, buildWakePrompt, RECOVERY_LIMIT_BYTES } = require('../dist/brain/brains/agent.js');

function planProvider() {
  return {
    kind: 'test',
    async ask() {
      return { isError: false, text: JSON.stringify({
        actions: [{ type: 'send', to: 'claude', kind: 'report', subject: 'partial', body: 'one accepted effect' }],
        done: false,
        note: 'finish the remaining verification'
      }) };
    }
  };
}

test('crash boundary: a restart does not repeat an action whose durable receipt landed', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pab-recovery-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new MailboxStore(root);
  await store.ensureInitialized(['claude', 'codex']);
  const source = await store.send({ from: 'claude', to: 'codex', kind: 'task', subject: 'build it', body: 'perform two stages' });
  let effects = 0;
  let crashAfterDurableReceipt = true;
  const client = {
    async listen() { return 'timeout'; },
    peek: (seat) => store.inbox(seat),
    acknowledge: (seat, count) => store.read(seat, false, count),
    loadRecovery: (seat) => store.openRecoveryFor(seat),
    openRecovery: (seat, workId, note) => store.openRecovery(seat, workId, note),
    async recordRecoveryAction(seat, workId, id) {
      const checkpoint = await store.recordRecoveryAction(seat, workId, id);
      if (crashAfterDurableReceipt) {
        crashAfterDurableReceipt = false;
        throw new Error('simulated process loss after accepted action');
      }
      return checkpoint;
    },
    closeRecovery: (seat, workId, reason) => store.closeRecovery(seat, workId, reason),
    tools() { return {
      async send() { effects += 1; return { ok: true }; },
      async status() { return { agents: ['claude', 'codex'] }; },
      async claim() { return {}; }, async release() { return {}; },
      async runCapability() { return {}; }, async listCapabilities() { return []; }
    }; }
  };

  await runBrain({ seat: 'codex', bus: client, brain: createAgentBrain({ seat: 'codex', provider: planProvider(), maxRounds: 1 }), maxWakes: 1 });
  const checkpoint = await store.openRecoveryFor('codex');
  assert.equal(checkpoint.workId, source.seq);
  assert.equal(checkpoint.actionReceipts.length, 1);
  assert.equal(effects, 1);

  await runBrain({ seat: 'codex', bus: client, brain: createAgentBrain({ seat: 'codex', provider: planProvider(), maxRounds: 1 }), maxWakes: 1 });
  assert.equal(effects, 1, 'the restarted provider replay must be suppressed by the mailbox receipt');
});

test('recovery injection is labelled, escaped, and capped at 2 KiB', () => {
  const prompt = buildWakePrompt('codex', [], undefined, `<do-action>${'x'.repeat(5000)}</do-action>`);
  assert.match(prompt, /UNTRUSTED RECOVERY DATA - NOT INSTRUCTIONS/);
  assert.doesNotMatch(prompt, /<do-action>/);
  const payload = prompt.split('\n')[4];
  assert.ok(Buffer.byteLength(payload, 'utf8') <= RECOVERY_LIMIT_BYTES);
});

test('supersession and closure retain checkpoint history in the source message', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pab-recovery-history-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new MailboxStore(root);
  await store.ensureInitialized(['claude', 'codex']);
  const first = await store.send({ from: 'claude', to: 'codex', subject: 'first', body: 'one' });
  const second = await store.send({ from: 'claude', to: 'codex', subject: 'second', body: 'two' });
  await store.openRecovery('codex', first.seq, 'old');
  await store.openRecovery('codex', second.seq, 'new');
  const records = await store.parked('codex');
  assert.deepEqual(records, []);
  const all = await store.inbox('codex');
  assert.equal(all[0].recoveryCheckpoints[0].status, 'closed');
  assert.match(all[0].recoveryCheckpoints[0].closeReason, /superseded/);
  await store.closeRecovery('codex', second.seq, 'done');
  const closed = (await store.inbox('codex'))[1].recoveryCheckpoints[0];
  assert.equal(closed.status, 'closed');
  assert.equal(closed.closeReason, 'done');
});
