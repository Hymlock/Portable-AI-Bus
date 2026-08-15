const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { runBrain } = require('../dist/brain/runner.js');
const { createStallLedger } = require('../dist/brain/stall-ledger.js');
const { runProcess, processOutcome } = require('../dist/brain/process-host.js');
const { EventEmitter } = require('node:events');

function transactionalBus(message) {
  let unread = message ? [message] : [];
  return {
    get unread() { return unread.slice(); },
    client: {
      async listen(_seat, _seconds, afterSeq) {
        const newest = unread.reduce((highest, item) => Math.max(highest, item.seq), 0);
        if (unread.length && (afterSeq === undefined || newest > afterSeq)) return 'mail';
        return 'timeout';
      },
      async peek() { return unread.slice(); },
      async acknowledge(_seat, count) {
        const batch = unread.slice(0, count);
        unread = unread.slice(count);
        return batch;
      },
      async read() { throw new Error('transactional runner must not destructively read'); },
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
    }
  };
}

const task = {
  seq: 501, from: 'claude', to: 'codex', kind: 'task',
  subject: 'item 5', body: 'distinguish stall from spent'
};

function tmpLedger(seat) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'portable-ai-bus-stall-'));
  return {
    dir,
    filePath: path.join(dir, `${seat}.json`),
    dispose() { fs.rmSync(dir, { recursive: true, force: true }); }
  };
}

test('GATE A: a stall that resolves emits both edges and is not reported as exhaustion', async () => {
  const tmp = tmpLedger('codex');
  const events = [];
  const ledger = createStallLedger({ seat: 'codex', filePath: tmp.filePath });
  const fixture = transactionalBus(task);
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const running = runBrain({
    seat: 'codex',
    brain: { name: 'slow-ok', async takeTurn() { await gate; return { done: true, note: 'recovered' }; } },
    bus: fixture.client,
    maxWakes: 1,
    providerStallMs: 15,
    stallLedger: ledger,
    log: (event, data) => events.push({ event, data })
  });
  await new Promise((resolve) => setTimeout(resolve, 40));
  release();
  await running;

  const start = events.find((entry) => entry.event === 'stall-start');
  const resolution = events.find((entry) => entry.event === 'stall-resolution');
  assert.ok(start, 'stall-start must fire');
  assert.ok(resolution, 'stall-resolution must fire');
  assert.equal(start.data.source, 'runner');
  assert.equal(resolution.data.outcome, 'returned');
  assert.equal(resolution.data.stallId, start.data.stallId);
  assert.ok(resolution.data.durationMs >= 15);
  assert.equal(events.some((entry) => entry.event === 'chain-exhausted'), false);
  const persisted = JSON.parse(fs.readFileSync(tmp.filePath, 'utf8'));
  assert.equal(persisted.started, 1);
  assert.equal(persisted.resolved, 1);
  assert.deepEqual(persisted.open, []);
  assert.equal(persisted.recent[0].outcome, 'returned');
  tmp.dispose();
});

test('GATE B: an unresolved stall is distinguishable from a resolved one without a human', async () => {
  const tmp = tmpLedger('grok');
  const first = createStallLedger({ seat: 'grok', filePath: tmp.filePath });
  const open = first.start({ seat: 'grok', source: 'runner', thresholdMs: 30_000 });
  const hanging = JSON.parse(fs.readFileSync(tmp.filePath, 'utf8'));
  assert.equal(hanging.open.length, 1, 'unresolved stall must remain in the persisted open set');
  assert.equal(hanging.resolved, 0);
  assert.equal(hanging.open[0].id, open.id);

  const resolvedTmp = tmpLedger('grok');
  const resolvedLedger = createStallLedger({ seat: 'grok', filePath: resolvedTmp.filePath });
  const resolvedId = resolvedLedger.start({ seat: 'grok', source: 'runner', thresholdMs: 30_000 }).id;
  resolvedLedger.resolve(resolvedId, 'returned', 90_000);
  const recovered = JSON.parse(fs.readFileSync(resolvedTmp.filePath, 'utf8'));
  assert.equal(recovered.open.length, 0);
  assert.equal(recovered.resolved, 1);

  assert.notEqual(hanging.open.length, recovered.open.length,
    'unresolved vs resolved must be readable from the file, not from watching a human');
  tmp.dispose();
  resolvedTmp.dispose();
});

test('GATE C RED: genuine chain exhaustion still reports as exhaustion, not as a stall', async () => {
  const tmp = tmpLedger('codex');
  const events = [];
  const ledger = createStallLedger({ seat: 'codex', filePath: tmp.filePath });
  const fixture = transactionalBus(task);
  await runBrain({
    seat: 'codex',
    brain: {
      name: 'spent-fast',
      async takeTurn() {
        return { done: true, exhausted: true, note: 'cli:quota,api:quota' };
      }
    },
    bus: fixture.client,
    maxWakes: 1,
    providerStallMs: 30_000,
    stallLedger: ledger,
    log: (event, data) => events.push({ event, data })
  });

  assert.equal(events.some((entry) => entry.event === 'chain-exhausted'), true,
    'spent chain must still be named exhaustion');
  assert.equal(events.some((entry) => entry.event === 'stall-start'), false,
    'a fast exhaustion must not be rewritten as a stall — this is the red control');
  assert.equal(events.some((entry) => entry.event === 'stall-resolution'), false);
  const persisted = JSON.parse(fs.readFileSync(tmp.filePath, 'utf8'));
  assert.equal(persisted.started, 0);
  assert.equal(persisted.open.length, 0);
  tmp.dispose();
});

test('GATE C green: a stall that later exhausts still reports both measurements', async () => {
  const tmp = tmpLedger('codex');
  const events = [];
  const ledger = createStallLedger({ seat: 'codex', filePath: tmp.filePath });
  const fixture = transactionalBus(task);
  await runBrain({
    seat: 'codex',
    brain: {
      name: 'slow-spent',
      async takeTurn() {
        await new Promise((resolve) => setTimeout(resolve, 25));
        return { done: true, exhausted: true, note: 'cli:quota' };
      }
    },
    bus: fixture.client,
    maxWakes: 1,
    providerStallMs: 5,
    stallLedger: ledger,
    log: (event, data) => events.push({ event, data })
  });

  assert.equal(events.some((entry) => entry.event === 'stall-start'), true);
  assert.equal(events.some((entry) => entry.event === 'stall-resolution'), true);
  assert.equal(events.some((entry) => entry.event === 'chain-exhausted'), true,
    'spent must remain spent even when the same wake also stalled');
  const resolution = events.find((entry) => entry.event === 'stall-resolution');
  assert.equal(resolution.data.outcome, 'returned');
  assert.equal(Object.hasOwn(resolution.data, 'exhausted'), false,
    'the stall record must not absorb the exhaustion flag');
  tmp.dispose();
});

test('GATE D: unresolved counters survive a restart, not silently reset to zero', async () => {
  const tmp = tmpLedger('grok');
  const first = createStallLedger({ seat: 'grok', filePath: tmp.filePath });
  first.start({ seat: 'grok', source: 'runner', thresholdMs: 30_000, wakeReason: 'mail', messages: 1 });
  first.start({ seat: 'grok', source: 'process-host', thresholdMs: 30_000 });
  const before = first.snapshot();
  assert.equal(before.started, 2);
  assert.equal(before.resolved, 0);
  assert.equal(before.open.length, 2);

  const restarted = createStallLedger({ seat: 'grok', filePath: tmp.filePath });
  const after = restarted.snapshot();
  assert.equal(after.started, 2, 'restart must not zero started');
  assert.equal(after.resolved, 0);
  assert.equal(after.open.length, 2, 'unresolved stalls remain unresolved after restart');
  assert.deepEqual(after.open.map((item) => item.source).sort(), ['process-host', 'runner']);

  const stillOnDisk = JSON.parse(fs.readFileSync(tmp.filePath, 'utf8'));
  assert.equal(stillOnDisk.open.length, 2);
  tmp.dispose();
});

test('GATE D runner: a resolved stall in one process is still resolved in the next', async () => {
  const tmp = tmpLedger('codex');
  const fixture = transactionalBus(task);
  const firstLedger = createStallLedger({ seat: 'codex', filePath: tmp.filePath });
  await runBrain({
    seat: 'codex',
    brain: { name: 'stalled', async takeTurn() { return { done: true }; } },
    bus: fixture.client,
    maxWakes: 1,
    providerStallMs: 0,
    stallLedger: firstLedger
  });
  const second = createStallLedger({ seat: 'codex', filePath: tmp.filePath });
  const snap = second.snapshot();
  assert.equal(snap.started, 1);
  assert.equal(snap.resolved, 1);
  assert.equal(snap.open.length, 0);
  assert.equal(snap.recent[0].outcome, 'returned');
  tmp.dispose();
});

test('GATE D in-flight: an unresolved runner stall stays open across a new ledger instance', async () => {
  const tmp = tmpLedger('grok');
  const events = [];
  const ledger = createStallLedger({ seat: 'grok', filePath: tmp.filePath });
  const fixture = transactionalBus(task);
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const running = runBrain({
    seat: 'grok',
    brain: { name: 'hangs', async takeTurn() { await gate; return { done: true }; } },
    bus: fixture.client,
    maxWakes: 1,
    providerStallMs: 10,
    stallLedger: ledger,
    log: (event, data) => events.push({ event, data })
  });
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(events.some((entry) => entry.event === 'stall-start'), true);
  assert.equal(events.some((entry) => entry.event === 'stall-resolution'), false,
    'still in flight: resolution must not have been invented');
  assert.equal(events.some((entry) => entry.event === 'chain-exhausted'), false);

  const mid = JSON.parse(fs.readFileSync(tmp.filePath, 'utf8'));
  assert.equal(mid.open.length, 1, 'persisted open set is the unresolved counter');
  assert.equal(mid.resolved, 0);

  const restarted = createStallLedger({ seat: 'grok', filePath: tmp.filePath });
  const after = restarted.snapshot();
  assert.equal(after.open.length, 1, 'a new process must still see the open stall');
  assert.equal(after.resolved, 0);
  assert.equal(after.open[0].id, events.find((entry) => entry.event === 'stall-start').data.stallId);

  release();
  await running;
  const done = JSON.parse(fs.readFileSync(tmp.filePath, 'utf8'));
  assert.equal(done.open.length, 0);
  assert.equal(done.resolved, 1);
  tmp.dispose();
});

test('two ledger handles on one file do not overwrite each other', () => {
  const tmp = tmpLedger('codex');
  const runner = createStallLedger({ seat: 'codex', filePath: tmp.filePath });
  const host = createStallLedger({ seat: 'codex', filePath: tmp.filePath });
  const runnerId = runner.start({ seat: 'codex', source: 'runner', thresholdMs: 30_000 }).id;
  const hostId = host.start({ seat: 'codex', source: 'process-host', thresholdMs: 30_000 }).id;
  const snap = runner.snapshot();
  assert.equal(snap.started, 2);
  assert.equal(snap.open.length, 2);
  assert.deepEqual(snap.open.map((item) => item.source).sort(), ['process-host', 'runner']);
  host.resolve(hostId, 'returned', 1_000);
  runner.resolve(runnerId, 'threw', 2_000);
  const done = JSON.parse(fs.readFileSync(tmp.filePath, 'utf8'));
  assert.equal(done.open.length, 0);
  assert.equal(done.resolved, 2);
  tmp.dispose();
});

test('process-host: a stall that times out is timed-out, not exhausted', async () => {
  const events = [];
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => true;
  const result = await runProcess('model', ['ask'], {
    timeoutMs: 40,
    stallMs: 5,
    log: (event, data) => events.push({ event, data })
  }, {
    platform: 'linux',
    spawn() { return child; }
  });

  assert.equal(result.code, 124);
  assert.equal(processOutcome(result.code), 'timed-out');
  assert.equal(events.some((entry) => entry.event === 'stall-start'), true);
  const start = events.find((entry) => entry.event === 'stall-start');
  const resolution = events.find((entry) => entry.event === 'stall-resolution');
  assert.equal(resolution.data.source, 'process-host');
  assert.equal(resolution.data.outcome, 'timed-out');
  assert.equal(resolution.data.stallId, start.data.stallId);
  assert.equal(events.some((entry) => entry.event === 'chain-exhausted'), false);
});

test('process-host: a stall that returns is returned, not exhausted', async () => {
  const events = [];
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => { throw new Error('successful child must not be killed'); };
  const pending = runProcess('model', ['ask'], {
    timeoutMs: 1_000,
    stallMs: 10,
    log: (event, data) => events.push({ event, data })
  }, {
    platform: 'linux',
    spawn() { return child; }
  });
  await new Promise((resolve) => setTimeout(resolve, 30));
  child.emit('close', 0);
  const result = await pending;

  assert.equal(result.code, 0);
  assert.equal(processOutcome(result.code), 'returned');
  assert.equal(events.some((entry) => entry.event === 'stall-start'), true);
  const resolution = events.find((entry) => entry.event === 'stall-resolution');
  assert.equal(resolution.data.outcome, 'returned');
  assert.equal(events.some((entry) => entry.event === 'chain-exhausted'), false);
});

test('process-host: a stall pair is persisted when a ledger is supplied', async () => {
  const tmp = tmpLedger('codex');
  const ledger = createStallLedger({ seat: 'codex', filePath: tmp.filePath });
  const events = [];
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => true;
  const pending = runProcess('model', ['ask'], {
    timeoutMs: 1_000,
    stallMs: 10,
    stallLedger: ledger,
    stallSeat: 'codex',
    log: (event, data) => events.push({ event, data })
  }, {
    platform: 'linux',
    spawn() { return child; }
  });
  await new Promise((resolve) => setTimeout(resolve, 30));
  const hanging = JSON.parse(fs.readFileSync(tmp.filePath, 'utf8'));
  assert.equal(hanging.open.length, 1);
  assert.equal(hanging.open[0].source, 'process-host');
  assert.equal(hanging.resolved, 0);
  const restarted = createStallLedger({ seat: 'codex', filePath: tmp.filePath });
  assert.equal(restarted.snapshot().open.length, 1,
    'process-host open stall must survive a new ledger instance');
  child.emit('close', 0);
  await pending;
  const done = JSON.parse(fs.readFileSync(tmp.filePath, 'utf8'));
  assert.equal(done.open.length, 0);
  assert.equal(done.resolved, 1);
  assert.equal(done.recent[0].outcome, 'returned');
  assert.equal(events.find((entry) => entry.event === 'stall-resolution').data.stallId, hanging.open[0].id);
  tmp.dispose();
});

test('process-host: a fast success emits neither stall edge nor exhaustion', async () => {
  const events = [];
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => true;
  const pending = runProcess('model', ['ask'], {
    timeoutMs: 1_000,
    stallMs: 30_000,
    log: (event, data) => events.push({ event, data })
  }, {
    platform: 'linux',
    spawn() {
      queueMicrotask(() => child.emit('close', 0));
      return child;
    }
  });
  const result = await pending;
  assert.equal(result.code, 0);
  assert.equal(events.some((entry) => entry.event === 'stall-start'), false);
  assert.equal(events.some((entry) => entry.event === 'stall-resolution'), false);
  assert.equal(events.some((entry) => entry.event === 'chain-exhausted'), false);
});
