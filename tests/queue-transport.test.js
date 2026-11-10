// Self-pruning queue (bus-prune-queue): T5 brief/guard cost, T14 frozen old binaries,
// T15 multi-day simulation, T16 transport. Temp roots only; nothing touches a live mailbox.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { test } = require('node:test');

require('./helpers/require-fresh-dist')();
const { MailboxStore, QueueFullError } = require('../dist/mailbox.js');
const { HarnessServer } = require('../dist/harness.js');
const { callSeatTool, sendWithQueueBackoff, isQueueFull } = require('../dist/worker-client.js');
const { cliBusClient } = require('../dist/brain/bus-client.js');

const execFileAsync = promisify(execFile);
const distDir = path.resolve(__dirname, '..', 'dist');
const srcDir = path.resolve(__dirname, '..', 'src');
const HOUR = 3_600_000;
const statePath = (root) => path.join(root, '.ai-bus', 'runtime', 'mailbox', 'state.json');
const inboxDir = (root) => path.join(root, '.ai-bus', 'runtime', 'mailbox', 'inbox');
const rm = (root) => fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });

async function tempRoot(prefix) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  await fs.mkdir(path.join(root, '.ai-bus'), { recursive: true });
  await fs.writeFile(path.join(root, '.ai-bus', 'capabilities.json'), JSON.stringify({ version: 1, capabilities: [] }), 'utf8');
  return root;
}

async function harness(agents, retention) {
  const root = await tempRoot('pab-queue-harness-');
  const credentialsDir = path.join(root, '.credentials');
  const server = new HarnessServer(root, { token: 'test-token', credentialsDir });
  await server.mailbox.ensureInitialized(agents, 20);
  if (retention) await server.mailbox.configureRetention(retention);
  const endpoint = await server.start(0);
  const asSeat = (seat) => ({ root, seat, credentialsDir });
  const operator = async (name, input) => {
    const response = await fetch(`http://${endpoint.host}:${endpoint.port}/v1/tool`, {
      method: 'POST',
      headers: { authorization: 'Bearer test-token', 'content-type': 'application/json' },
      body: JSON.stringify({ requestId: `op-${Math.random()}`, name, input })
    });
    return { status: response.status, headers: response.headers, body: await response.json() };
  };
  const cleanup = async () => { await server.stop(); await rm(root); };
  return { root, server, endpoint, asSeat, operator, credentialsDir, cleanup };
}

// ---------------------------------------------------------------- T5

test('T5 status is brief (< 2 KB) on the harness tool and the CLI; full only for the operator', async (t) => {
  const h = await harness(['codex', 'grok', 'claude', 'gemini']);
  t.after(h.cleanup);
  await fs.mkdir(path.join(h.root, 'src'), { recursive: true });
  for (let index = 0; index < 40; index += 1) {
    await fs.writeFile(path.join(h.root, 'src', `f${index}.ts`), 'x', 'utf8');
    await h.server.mailbox.claim({ agent: index % 2 ? 'grok' : 'codex', paths: [`src/f${index}.ts`], why: `long reason ${'x'.repeat(200)} #${index}` });
  }
  await h.server.mailbox.send({ from: 'codex', to: 'grok', subject: 's', body: 'b'.repeat(5000) });
  const brief = await callSeatTool(h.asSeat('grok'), 'mailbox_status', {}, 'brief-1');
  const briefBytes = Buffer.byteLength(JSON.stringify(brief.result));
  assert.ok(briefBytes < 2048, `harness brief is ${briefBytes} bytes`);
  assert.equal(brief.result.brief, true);
  assert.equal(brief.result.claimCounts.codex, 20);
  // M5: a seat asking for full:true still gets the bounded brief (tool and HTTP status).
  const seatFull = await callSeatTool(h.asSeat('grok'), 'mailbox_status', { full: true }, 'full-1');
  assert.equal(seatFull.result.brief, true, 'seats never get the full state');
  assert.ok(Buffer.byteLength(JSON.stringify(seatFull.result)) < 2048);
  const seatToken = (await fs.readFile(h.endpoint.seatTokenPaths.grok, 'utf8')).trim();
  const seatHttp = await fetch(`http://${h.endpoint.host}:${h.endpoint.port}/v1/status?full=1`, { headers: { authorization: `Bearer ${seatToken}` } }).then((response) => response.json());
  assert.equal(seatHttp.mailbox.brief, true, '/v1/status?full=1 is brief for a seat');
  const operatorFull = await h.operator('mailbox_status', { full: true });
  assert.equal(operatorFull.status, 200);
  assert.notEqual(operatorFull.body.result.brief, true, 'the operator may ask for the full state');
  assert.ok(Buffer.byteLength(JSON.stringify(operatorFull.body.result)) > briefBytes * 2);
  const listed = h.server.tools().find((tool) => tool.name === 'mailbox_status');
  assert.doesNotMatch(listed.description, /full:true/);
  assert.match(listed.inputSchema.properties.full.description, /Operator only/);
  const cli = await execFileAsync(process.execPath, [path.join(distDir, 'mailbox.js'), 'status', '--brief', '--for', 'grok', '--root', h.root]);
  assert.ok(Buffer.byteLength(cli.stdout) < 2048, `CLI brief is ${Buffer.byteLength(cli.stdout)} bytes`);
  // LM worker tool: same statusBrief() call (vscode cannot load under node --test; source check).
  const lm = await fs.readFile(path.join(srcDir, 'vscode-lm-worker.ts'), 'utf8');
  assert.match(lm, /tool\('mailbox_status'[^\n]*mailbox\.statusBrief\(seat\)/);
  assert.doesNotMatch(lm, /mailbox\.status\(\)/);
});

test('T5 the send guard does 0 scans and 0 git; an idle wait does 0 full scans while others exchange mail', async (t) => {
  const root = await tempRoot('pab-queue-cost-');
  t.after(() => rm(root));
  const store = new MailboxStore(root);
  await store.ensureInitialized(['codex', 'grok', 'claude'], 20);
  await store.send({ from: 'codex', to: 'grok', subject: 'warm', body: 'counters exist' });
  const scans = store.metrics.scans;
  for (let index = 0; index < 20; index += 1) await store.send({ from: 'codex', to: 'grok', subject: `s${index}`, body: 'x' });
  assert.equal(store.metrics.scans - scans, 0, 'send/guard path: no full scans');
  // gitSpawns counts commit stamps; a temp dir without .git spawns none, and the guard adds none.
  assert.equal(store.metrics.gitSpawns, 0);

  const waiter = new MailboxStore(root);
  const waiting = waiter.waitFor('claude', 1_500, 50);
  await new Promise((resolve) => setTimeout(resolve, 120));
  const before = waiter.metrics.waitScans;
  const other = new MailboxStore(root);
  for (let index = 0; index < 10; index += 1) {
    await other.send({ from: 'codex', to: 'grok', subject: `x${index}`, body: 'x' });
    await other.send({ from: 'grok', to: 'codex', subject: `y${index}`, body: 'y' });
  }
  assert.equal(await waiting, 'timeout');
  assert.equal(waiter.metrics.waitScans - before, 0, 'no full rescans while idle');
  assert.ok(waiter.metrics.waitFileReads <= 20, `read only the new files (${waiter.metrics.waitFileReads})`);
});

// ---------------------------------------------------------------- T14

const frozenBins = (process.env.PAB_FROZEN_BINS ?? '').split(path.delimiter).filter((dir) => dir && fsSync.existsSync(path.join(dir, 'mailbox.js')));

async function migratedCopy() {
  const root = await tempRoot('pab-queue-frozen-');
  const store = new MailboxStore(root);
  await store.ensureInitialized(['codex', 'grok'], 20);
  await fs.mkdir(path.join(root, 'src'), { recursive: true });
  await fs.writeFile(path.join(root, 'src', 'a.ts'), 'x', 'utf8');
  for (let index = 0; index < 4; index += 1) await store.send({ from: 'codex', to: 'grok', subject: `m${index}`, body: 'x' });
  await store.upgradeState();
  return { root, store };
}

for (const dir of frozenBins) {
  test(`T14 frozen ${path.basename(dir)}: locked ops refused with state.json byte-identical; message ops allowed`, async (t) => {
    const { root, store } = await migratedCopy();
    t.after(() => rm(root));
    // Load the frozen module in its own directory so its siblings resolve to the frozen set.
    delete require.cache[path.join(dir, 'mailbox.js')];
    const Old = require(path.join(dir, 'mailbox.js')).MailboxStore;
    const old = new Old(root);
    const raw = await fs.readFile(statePath(root), 'utf8');
    const refused = {
      send: () => old.send({ from: 'codex', to: 'grok', subject: 'old', body: 'old' }),
      claim: () => old.claim({ agent: 'grok', paths: ['src/a.ts'], why: 'old' }),
      release: () => old.release('grok'),
      halt: () => old.halt('old halt', { force: true }),
      resume: () => old.resume(5),
      'init --max-rounds 99999': () => old.ensureInitialized(['codex', 'grok'], 99999)
    };
    for (const [name, op] of Object.entries(refused)) {
      await assert.rejects(op(), /Unsupported mailbox schema 2|upgrade required/, `${name} must be refused`);
      assert.equal(await fs.readFile(statePath(root), 'utf8'), raw, `${name} left state.json byte-identical`);
    }
    // Old harness start() refuses before it listens.
    delete require.cache[path.join(dir, 'harness.js')];
    const OldHarness = require(path.join(dir, 'harness.js')).HarnessServer;
    const oldServer = new OldHarness(root, { token: 'old-token', credentialsDir: path.join(root, '.old-credentials') });
    await assert.rejects(oldServer.start(0), /Unsupported mailbox schema 2|upgrade required|halted/);
    await oldServer.stop().catch(() => undefined);
    assert.equal(await fs.readFile(statePath(root), 'utf8'), raw, 'harness start left state.json byte-identical');
    // Old doctor reports the mismatch and does not write.
    const report = await old.doctor();
    assert.match(report.problems.join('\n'), /state schema is 2; expected 1/);
    assert.equal(await fs.readFile(statePath(root), 'utf8'), raw);
    // Read-only views work.
    assert.equal((await old.inbox('grok')).length, 4);
    const oldStatus = await old.status();
    assert.equal(oldStatus.halted, false);
    // Allowed message-file ops: only the targeted files change; state.json stays byte-identical.
    const [first] = await old.read('grok', false, 1);
    await old.acknowledge('grok', [first.seq + 1]);
    await old.park('grok', first.seq + 2, 'old park').catch((error) => assert.match(String(error), /schema/));
    assert.equal(await fs.readFile(statePath(root), 'utf8'), raw, 'message ops left state.json byte-identical');
    // One new-code timer run (or doctor) recounts: counters match inbox() for every seat.
    const fresh = new MailboxStore(root);
    await fresh.doctor();
    const state = JSON.parse(await fs.readFile(statePath(root), 'utf8'));
    for (const seat of state.agents) assert.equal(state.queue.unread[seat] ?? 0, (await fresh.inbox(seat)).length, seat);
    assert.equal(store instanceof MailboxStore, true);
  });
}

test('T14 frozen binaries are configured for this run (set PAB_FROZEN_BINS to run the matrix)', { skip: frozenBins.length > 0 ? false : 'PAB_FROZEN_BINS not set' }, () => {
  assert.ok(frozenBins.length > 0);
});

// ---------------------------------------------------------------- T15

async function simulate({ days, perDay, absentFromDay, harnessUp, seats = ['codex', 'grok', 'claude', 'gemini'], retention }) {
  const root = await tempRoot('pab-queue-sim-');
  const clock = { now: Date.parse('2026-11-01T00:00:00Z') };
  const store = new MailboxStore(root, { now: () => clock.now });
  await store.ensureInitialized(seats, 20);
  if (retention) await store.configureRetention(retention);
  const stats = { sends: 0, refused: {}, backstop: [], maxHot: 0, sendMs: [], batchesPerSend: 0, warnings: new Set(), halted: false, ticks: 0, backoff60: 0 };
  const stepMs = (24 * HOUR) / perDay;
  let turn = 0;
  for (let step = 0; step < days * perDay; step += 1) {
    clock.now += stepMs;
    const day = Math.floor(step / perDay);
    const from = seats[turn % seats.length];
    const to = seats[(turn + 1 + Math.floor(turn / seats.length)) % seats.length] === from ? seats[(turn + 2) % seats.length] : seats[(turn + 1 + Math.floor(turn / seats.length)) % seats.length];
    turn += 1;
    const batches = store.metrics.pruneBatches;
    const started = Date.now();
    try {
      await store.send({ from, to, subject: `d${day} s${step}`, body: 'x' });
      stats.sends += 1;
    } catch (error) {
      if (!(error instanceof QueueFullError)) throw error;
      if (error.scope === 'backstop') stats.backstop.push({ step, retryAfterMs: error.retryAfterMs });
      else stats.refused[error.seat] = (stats.refused[error.seat] ?? 0) + 1;
    }
    stats.sendMs.push(Date.now() - started);
    stats.batchesPerSend = Math.max(stats.batchesPerSend, store.metrics.pruneBatches - batches);
    // Readers: every seat but the absent one drains its inbox each simulated hour.
    if (step % Math.max(1, Math.round(perDay / 24)) === 0) {
      for (const seat of seats) {
        if (absentFromDay !== undefined && seat === 'claude' && day >= absentFromDay) continue;
        await store.read(seat, true);
      }
      if (harnessUp) {
        const tick = await store.maintenanceTick();
        if (tick.ran) stats.ticks += 1;
      }
      const brief = await store.statusBrief();
      if (brief.queueWarning) stats.warnings.add(brief.queueWarning);
      stats.halted ||= brief.halted;
    }
    stats.maxHot = Math.max(stats.maxHot, (await fs.readdir(inboxDir(root))).length);
  }
  const state = JSON.parse(await fs.readFile(statePath(root), 'utf8'));
  stats.maxHotAllowed = store.maxHotOf(state);
  stats.hotEnd = (await fs.readdir(inboxDir(root))).length;
  stats.unreadEnd = state.queue.unread;
  stats.p95 = stats.sendMs.sort((a, b) => a - b)[Math.floor(stats.sendMs.length * 0.95)];
  await rm(root);
  return stats;
}

test('T15a/b 14 days x 160 msgs/day, 4 seats, claude absent from day 2: only claude fills; no latch', { timeout: 600_000 }, async () => {
  const stats = await simulate({ days: 14, perDay: 160, absentFromDay: 2, harnessUp: true, retention: { keepRecent: 300, minAgeHours: 48 } });
  assert.equal(stats.halted, false);
  assert.ok(stats.refused.claude > 0, 'sends to claude refused once it hits the cap');
  assert.deepEqual(Object.keys(stats.refused), ['claude'], 'traffic among other seats has zero refusals');
  assert.equal(stats.backstop.length, 0);
  assert.equal(stats.unreadEnd.claude, 200);
  assert.ok([...stats.warnings].some((text) => /claude/.test(text)), 'queueWarning names claude');
  assert.ok(stats.maxHot <= stats.maxHotAllowed, `hot ${stats.maxHot} <= maxHot ${stats.maxHotAllowed}`);
  // (a) steady state: hot <= keepRecent + pins + current unread + 2 days of read mail at 160/day
  assert.ok(stats.hotEnd <= 300 + 200 + 2 * 160 + 200, `hot at end ${stats.hotEnd}`);
  assert.ok(stats.batchesPerSend <= 1, 'prune inside send is at most one batch');
  assert.ok(stats.p95 < 2000, `send p95 ${stats.p95} ms`);
  console.log(`# T15a/b ${JSON.stringify({ sends: stats.sends, refused: stats.refused, maxHot: stats.maxHot, maxHotAllowed: stats.maxHotAllowed, hotEnd: stats.hotEnd, ticks: stats.ticks, p95: stats.p95 })}`);
});

test('T15c harness down for 14 days: prune-on-pressure + backstop keep hot <= maxHot', { timeout: 600_000 }, async () => {
  const stats = await simulate({ days: 14, perDay: 160, absentFromDay: 2, harnessUp: false });
  assert.equal(stats.halted, false);
  assert.ok(stats.maxHot <= stats.maxHotAllowed, `hot ${stats.maxHot} <= maxHot ${stats.maxHotAllowed}`);
  assert.deepEqual(Object.keys(stats.refused), ['claude']);
  assert.ok(stats.batchesPerSend <= 1);
  console.log(`# T15c ${JSON.stringify({ sends: stats.sends, refused: stats.refused, backstop: stats.backstop.length, maxHot: stats.maxHot, maxHotAllowed: stats.maxHotAllowed, hotEnd: stats.hotEnd })}`);
});

for (const harnessUp of [true, false]) {
  test(`T15d triage burst: 1,500 sent and read in 6 h, maxHot 1,400, harness ${harnessUp ? 'up' : 'down'}`, { timeout: 600_000 }, async () => {
    // 1500 over 6 h = 6000/day rate; reads happen every ~simulated 15 min.
    const stats = await simulate({ days: 0.25, perDay: 6000, harnessUp });
    assert.equal(stats.maxHotAllowed, 1400);
    assert.equal(stats.halted, false);
    assert.ok(stats.maxHot <= 1400, `hot peaked at ${stats.maxHot}`);
    // Any backstop 429 lasts no longer than one prune period (5 min) and says so.
    for (const refusal of stats.backstop) assert.ok(refusal.retryAfterMs <= 5 * 60_000, JSON.stringify(refusal));
    assert.deepEqual(stats.refused, {});
    assert.ok(stats.hotEnd < 1400 * 0.8 + 500, `pressure mode archived young read mail (hot ${stats.hotEnd})`);
    assert.ok(stats.batchesPerSend <= 1);
    // A normal-mode timer run that found nothing must not hold the pressure batch off for
    // 60 minutes: the peak stays within one 5-minute pressure window (~21 sends) of 80%.
    assert.ok(stats.maxHot <= Math.ceil(1400 * 0.8) + 25, `hot peaked at ${stats.maxHot}`);
    console.log(`# T15d harness ${harnessUp ? 'up' : 'down'} ${JSON.stringify({ sends: stats.sends, backstop: stats.backstop.length, maxHot: stats.maxHot, hotEnd: stats.hotEnd, ticks: stats.ticks })}`);
  });
}

// ---------------------------------------------------------------- T16

test('T16 transport: store error -> 429 queue_full -> worker backs off -> brain refuses and caches; never "halted"', async (t) => {
  const h = await harness(['codex', 'grok'], { maxUnreadPerSeat: 3 });
  t.after(h.cleanup);
  for (let index = 0; index < 3; index += 1) await h.server.mailbox.send({ from: 'codex', to: 'grok', subject: `f${index}`, body: 'x' });
  // store
  const storeError = await h.server.mailbox.send({ from: 'codex', to: 'grok', subject: 'over', body: 'x' }).catch((error) => error);
  assert.ok(storeError instanceof QueueFullError);
  assert.equal(storeError.exitCode, 4);
  assert.equal(storeError.code, 'queue_full');
  // harness 429
  const http = await h.operator('mailbox_send', { from: 'codex', to: 'grok', subject: 'over', body: 'x' });
  assert.equal(http.status, 429);
  assert.equal(http.body.error.code, 'queue_full');
  assert.equal(http.body.error.retriable, true);
  assert.equal(http.headers.get('retry-after'), '300');
  assert.deepEqual({ seat: http.body.error.details.seat, unread: http.body.error.details.unread, cap: http.body.error.details.cap }, { seat: 'grok', unread: 3, cap: 3 });
  for (const text of [storeError.message, JSON.stringify(http.body)]) assert.doesNotMatch(text, /halted/i);
  // old frozen worker-client regex does not match -> it does not exit as "halted"
  assert.doesNotMatch(JSON.stringify(http.body), /bus_halted|halted/i);
  // new worker-client: same requestId on retries, sleeps >= retryAfterMs, returns refused (no throw)
  const sleeps = [];
  const refusals = [];
  const outcome = await sendWithQueueBackoff(h.asSeat('codex'), { from: 'codex', to: 'grok', subject: 'retry', body: 'x' },
    { maxAttempts: 3, requestId: 'same-id', onRefused: (refusal) => refusals.push(refusal) },
    { sleep: async (ms) => { sleeps.push(ms); } });
  assert.equal(outcome.refused.refused, 'queue_full');
  assert.deepEqual(sleeps, [300_000, 300_000]);
  assert.equal(refusals.length, 3);
  // reading frees the seat; the backoff send then goes through with the same requestId
  await h.server.mailbox.read('grok', true);
  const sent = await sendWithQueueBackoff(h.asSeat('codex'), { from: 'codex', to: 'grok', subject: 'retry', body: 'x' }, { requestId: 'after-read' });
  assert.ok(sent.sent.result.seq > 0);

  // brain client: refused result, then cached for min(retryAfterMs, 60 s) with 0 extra calls
  await h.server.mailbox.read('grok', true);
  for (let index = 0; index < 3; index += 1) await h.server.mailbox.send({ from: 'codex', to: 'grok', subject: `g${index}`, body: 'x' });
  let now = 1_000_000;
  let calls = 0;
  const logs = [];
  const bus = cliBusClient({
    root: h.root,
    log: (event, data) => logs.push({ event, data }),
    now: () => now,
    callSeatTool: (options, name, input, requestId, runtime) => { calls += 1; return callSeatTool({ ...options, credentialsDir: h.credentialsDir }, name, input, requestId, runtime); }
  });
  const tools = bus.tools('codex');
  const first = await tools.send({ to: 'grok', subject: 'brain', body: 'x' });
  assert.equal(first.refused, 'queue_full');
  assert.equal(calls, 1);
  assert.ok(logs.some((entry) => entry.event === 'bus-call-refused'));
  now += 30_000;
  const second = await tools.send({ to: 'grok', subject: 'brain', body: 'x' });
  assert.equal(second.cached, true);
  assert.equal(second.retryAfterMs, 30_000);
  assert.equal(calls, 1, 'served from cache: 0 extra calls');
  now += 30_001;
  await tools.send({ to: 'grok', subject: 'brain', body: 'x' });
  assert.equal(calls, 2, 'cache expires at 60 s even though retryAfterMs was 300 s');

  // CLI exit code 4 and a refusal JSON, not a halt.
  const cli = await execFileAsync(process.execPath, [path.join(distDir, 'mailbox.js'), 'send', '--from', 'codex', '--to', 'grok', '--subject', 'cli', '--body', 'x', '--root', h.root]).catch((error) => error);
  assert.equal(cli.code, 4);
  assert.doesNotMatch(`${cli.stdout}${cli.stderr}`, /halted/i);
  assert.equal(isQueueFull({ status: 429, code: 'queue_full' }), false, 'only HarnessRequestError instances count');
});

test('T16 a backstop 429 during the 60-minute backoff carries the remaining backoff; the brain cache holds 60 s', async (t) => {
  const root = await tempRoot('pab-queue-backstop-');
  t.after(() => rm(root));
  const clock = { now: Date.parse('2026-11-01T00:00:00Z') };
  const store = new MailboxStore(root, { now: () => clock.now });
  await store.ensureInitialized(['codex', 'grok'], 20);
  await store.configureRetention({ keepRecent: 0, pinnedAllowance: 0, maxUnreadPerSeat: 60 });
  // maxHot = 0 + 0 + 2*60 + 100 = 220; fill with UNREAD-free but pinned-free... use unread
  // split across both seats under their caps plus read mail younger than 48 h is archivable in
  // pressure mode, so make the hot set unarchivable: unread up to the cap on both seats, then
  // parked mail for the rest.
  for (let index = 0; index < 50; index += 1) await store.send({ from: 'codex', to: 'grok', subject: `u${index}`, body: 'x' });
  for (let index = 0; index < 50; index += 1) await store.send({ from: 'grok', to: 'codex', subject: `v${index}`, body: 'x' });
  const state = JSON.parse(await fs.readFile(statePath(root), 'utf8'));
  // 120 more parked messages written straight to disk (an old binary's parked backlog)
  const template = JSON.parse(await fs.readFile(path.join(inboxDir(root), (await fs.readdir(inboxDir(root)))[0]), 'utf8'));
  for (let index = 0; index < 120; index += 1) {
    const seq = state.seq + 1 + index;
    const message = { ...template, seq, read: true, parkedAt: new Date(clock.now).toISOString(), parkReason: 'backlog' };
    await fs.writeFile(path.join(inboxDir(root), `${String(seq).padStart(6, '0')}-codex-to-grok.json`), JSON.stringify(message), 'utf8');
  }
  // First over-limit send: the pressure batch runs, finds 0 eligible, backstop with 60 min backoff.
  const first = await store.send({ from: 'codex', to: 'grok', subject: 'x', body: 'x' }).catch((error) => error);
  assert.ok(first instanceof QueueFullError, String(first));
  assert.equal(first.scope, 'backstop');
  assert.equal(first.retryAfterMs, 60 * 60_000);
  clock.now += 20 * 60_000;
  const second = await store.send({ from: 'codex', to: 'grok', subject: 'x', body: 'x' }).catch((error) => error);
  assert.equal(second.scope, 'backstop');
  assert.equal(second.retryAfterMs, 40 * 60_000, 'remaining backoff, not a fixed value');
  assert.doesNotMatch(second.message, /halted/i);
});
