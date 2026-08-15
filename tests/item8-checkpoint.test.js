const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { MailboxStore } = require('../dist/mailbox.js');
const { runBrain } = require('../dist/brain/runner.js');

function recoveryClient(store) {
  return {
    async listen() { return 'timeout'; },
    peek: (seat) => store.inbox(seat),
    acknowledge: (seat, seqs) => store.acknowledge(seat, seqs),
    loadRecovery: (seat) => store.openRecoveryFor(seat),
    openRecovery: (seat, workId, note) => store.openRecovery(seat, workId, note),
    recordRecoveryAction: (seat, workId, id) => store.recordRecoveryAction(seat, workId, id),
    closeRecovery: (seat, workId, reason) => store.closeRecovery(seat, workId, reason),
    tools() {
      return {
        async send() { return { ok: true }; },
        async status() { return { agents: ['claude', 'codex', 'grok'] }; },
        async claim() { return {}; },
        async release() { return {}; },
        async runCapability() { return {}; },
        async listCapabilities() { return []; }
      };
    }
  };
}

function scriptedBrain(turn) {
  return { name: 'item8-scripted', takeTurn: turn };
}

async function withStore(t, prefix, fn) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const store = new MailboxStore(root);
  await store.ensureInitialized(['claude', 'codex', 'grok']);
  return fn(store, recoveryClient(store));
}

// Item 8: recovery checkpoints close when the wake ends, not when the task is done.
// Measured live 2026-08-15 on 1694/1702 (grok) and 1698/1704/1706 (codex).
// runner.ts closed as "done" because hasOpenWork is result.done === false, and seats
// emit done:true after an acknowledgement. done-requires-report.js is not this gate:
// a note saying "working on it" still closes recovery today.

test('ITEM 8 RED: an ack-only wake leaves the checkpoint open', async (t) => {
  await withStore(t, 'pab-item8-ack-', async (store, client) => {
    const source = await store.send({
      from: 'claude', to: 'grok', kind: 'task',
      subject: 'implement item 12', body: 'do the dead wire'
    });

    await runBrain({
      seat: 'grok',
      bus: client,
      brain: scriptedBrain(async (context) => {
        await context.tools.send({
          to: 'claude',
          kind: 'ack',
          subject: 'ACK: item 12',
          body: 'received'
        });
        return { done: true, note: 'acknowledged' };
      }),
      maxWakes: 1
    });

    const checkpoint = await store.openRecoveryFor('grok');
    assert.ok(checkpoint, 'today runner.ts closes this as done; an ack is not completion');
    assert.equal(checkpoint.workId, source.seq);
    assert.equal(checkpoint.status, 'open');
  });
});

test('ITEM 8 RED: an ack-plus-note wake leaves the checkpoint open', async (t) => {
  await withStore(t, 'pab-item8-note-', async (store, client) => {
    const source = await store.send({
      from: 'claude', to: 'codex', kind: 'task',
      subject: 'implement item 19', body: 'transcript metadata'
    });

    await runBrain({
      seat: 'codex',
      bus: client,
      brain: scriptedBrain(async (context) => {
        await context.tools.send({
          to: 'claude',
          kind: 'ack',
          subject: 'ACK: item 19',
          body: 'received'
        });
        await context.tools.send({
          to: 'claude',
          kind: 'note',
          subject: 'working on it',
          body: 'will implement after this wake'
        });
        return { done: true, note: 'working on it' };
      }),
      maxWakes: 1
    });

    const checkpoint = await store.openRecoveryFor('codex');
    assert.ok(checkpoint, 'a note saying working on it must not close recovery; done-requires-report is not this gate');
    assert.equal(checkpoint.workId, source.seq);
    assert.equal(checkpoint.status, 'open');
  });
});

test('ITEM 8 GREEN: a wake that reports completed gates still closes', async (t) => {
  await withStore(t, 'pab-item8-green-', async (store, client) => {
    await store.send({
      from: 'claude', to: 'grok', kind: 'task',
      subject: 'implement item 12', body: 'do the dead wire'
    });

    await runBrain({
      seat: 'grok',
      bus: client,
      brain: scriptedBrain(async (context) => {
        await context.tools.send({
          to: 'claude',
          kind: 'ack',
          subject: 'ACK',
          body: 'received'
        });
        await context.tools.send({
          to: 'claude',
          kind: 'report',
          subject: 'item 12 landed',
          body: 'gates passed and committed'
        });
        return { done: true, note: 'gates passed' };
      }),
      maxWakes: 1
    });

    assert.equal(await store.openRecoveryFor('grok'), undefined, 'a real report plus done must still close');
  });
});

test('ITEM 8: exhausted still closes', async (t) => {
  await withStore(t, 'pab-item8-exhausted-', async (store, client) => {
    await store.send({
      from: 'claude', to: 'grok', kind: 'task',
      subject: 'work', body: 'cannot think'
    });

    await runBrain({
      seat: 'grok',
      bus: client,
      brain: scriptedBrain(async () => ({
        done: true,
        exhausted: true,
        note: 'provider chain spent'
      })),
      maxWakes: 1
    });

    assert.equal(await store.openRecoveryFor('grok'), undefined);
  });
});

test('ITEM 8: broken still closes', async (t) => {
  await withStore(t, 'pab-item8-broken-', async (store, client) => {
    await store.send({
      from: 'claude', to: 'grok', kind: 'task',
      subject: 'work', body: 'transport failed'
    });

    await runBrain({
      seat: 'grok',
      bus: client,
      brain: scriptedBrain(async () => ({
        done: true,
        broken: true,
        note: 'ConPTY unavailable'
      })),
      maxWakes: 1
    });

    assert.equal(await store.openRecoveryFor('grok'), undefined);
  });
});

test('ITEM 8: the production prompt no longer teaches done as wake-scoped', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'brains', 'agent-seat.js'), 'utf8');
  assert.doesNotMatch(
    src,
    /done ends only this wake/i,
    'that sentence is half the bug: seats emit done:true after an ack because the prompt says to'
  );
  assert.match(
    src,
    /gates passed/i,
    'the prompt must reserve done:true for assigned gates that actually passed'
  );
});
