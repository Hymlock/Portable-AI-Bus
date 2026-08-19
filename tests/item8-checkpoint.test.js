const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
require('./helpers/require-fresh-dist')();
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

test('ITEM 8 RED: a broken mid-assignment wake leaves the checkpoint open', async (t) => {
  await withStore(t, 'pab-item8-broken-', async (store, client) => {
    const source = await store.send({
      from: 'claude', to: 'grok', kind: 'task',
      subject: 'work', body: 'transport failed'
    });

    await runBrain({
      seat: 'grok',
      bus: client,
      brain: scriptedBrain(async (context) => {
        await context.recordRecoveryAction?.('0:{"kind":"note","subject":"partial","type":"send"}');
        return {
          done: true,
          broken: true,
          retainMessages: true,
          note: 'BROKEN:ConPTY unavailable: Cannot find module \'node-pty\''
        };
      }),
      maxWakes: 1
    });

    const checkpoint = await store.openRecoveryFor('grok');
    assert.ok(checkpoint, 'BROKEN is a machine failure; closing it discarded 1740 and 1722');
    assert.equal(checkpoint.workId, source.seq);
    assert.equal(checkpoint.status, 'open');
    assert.equal(checkpoint.actionReceipts.length, 1, 'receipts must survive the transport fault');
  });
});

test('ITEM 8 RED: an exhausted wake with no successor leaves the checkpoint open', async (t) => {
  await withStore(t, 'pab-item8-exhausted-', async (store, client) => {
    const source = await store.send({
      from: 'claude', to: 'grok', kind: 'task',
      subject: 'work', body: 'cannot think'
    });

    await runBrain({
      seat: 'grok',
      bus: client,
      brain: scriptedBrain(async (context) => {
        await context.recordRecoveryAction?.('0:{"kind":"note","subject":"partial","type":"send"}');
        return {
          done: true,
          exhausted: true,
          retainMessages: true,
          note: 'provider chain spent'
        };
      }),
      maxWakes: 1
    });

    const checkpoint = await store.openRecoveryFor('grok');
    assert.ok(checkpoint, 'credits returning does not change the task; close is only live when inherit does not run');
    assert.equal(checkpoint.workId, source.seq);
    assert.equal(checkpoint.status, 'open');
    assert.equal(checkpoint.actionReceipts.length, 1);
  });
});

test('ITEM 8 GREEN: exhausted with a successor still inherits', async (t) => {
  await withStore(t, 'pab-item8-inherit-', async (store, client) => {
    const source = await store.send({
      from: 'claude', to: 'grok', kind: 'task',
      subject: 'work', body: 'cannot think'
    });

    await runBrain({
      seat: 'grok',
      bus: client,
      brain: scriptedBrain(async (context) => {
        await context.recordRecoveryAction?.('0:{"kind":"note","subject":"partial","type":"send"}');
        return {
          done: true,
          exhausted: true,
          retainMessages: true,
          note: 'provider chain spent'
        };
      }),
      onExhausted: async () => {
        const moved = await store.reassignBaton({
          to: 'codex',
          reason: 'grok exhausted every provider',
          expectedFrom: 'grok',
          force: true
        });
        assert.equal(moved.moved, true, moved.why);
        assert.equal(moved.inheritedWorkId, source.seq);
      },
      maxWakes: 1
    });

    assert.equal(await store.openRecoveryFor('grok'), undefined, 'source must close as reassigned, not as exhausted');
    const inherited = await store.openRecoveryFor('codex');
    assert.ok(inherited, 'item 4 inherit must stay green');
    assert.equal(inherited.workId, source.seq);
    assert.equal(inherited.inheritedFrom, 'grok');
    assert.equal(inherited.actionReceipts.length, 1);
    const previous = (await store.inbox('grok'))[0].recoveryCheckpoints.find((item) => item.seat === 'grok');
    assert.match(previous.closeReason, /reassigned to codex/);
  });
});

test('ITEM 8 GREEN: a later completing report still closes after a broken wake', async (t) => {
  await withStore(t, 'pab-item8-broken-then-done-', async (store, client) => {
    await store.send({
      from: 'claude', to: 'grok', kind: 'task',
      subject: 'work', body: 'transport failed then recovered'
    });

    await runBrain({
      seat: 'grok',
      bus: client,
      brain: scriptedBrain(async () => ({
        done: true,
        broken: true,
        retainMessages: true,
        note: 'BROKEN:ConPTY unavailable'
      })),
      maxWakes: 1
    });
    assert.ok(await store.openRecoveryFor('grok'), 'broken wake must leave the row for the next attempt');

    await runBrain({
      seat: 'grok',
      bus: client,
      brain: scriptedBrain(async (context) => {
        await context.tools.send({
          to: 'claude',
          kind: 'report',
          subject: 'item landed',
          body: 'gates passed and committed'
        });
        return { done: true, note: 'gates passed' };
      }),
      maxWakes: 1
    });

    assert.equal(await store.openRecoveryFor('grok'), undefined, 'a real report plus done must still close');
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
