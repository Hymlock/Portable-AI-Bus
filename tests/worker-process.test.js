const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { HarnessServer } = require('../dist/harness.js');

test('three provider-neutral seat processes acquire, wake, and release independently', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'portable-ai-bus-real-seats-'));
  const credentialsDir = path.join(root, '.test-credentials');
  const seats = ['codex', 'claude', 'grok'];
  await fs.mkdir(path.join(root, '.ai-bus'), { recursive: true });
  for (const seat of seats) {
    await fs.mkdir(path.join(root, 'work', seat), { recursive: true });
  }
  await fs.writeFile(path.join(root, '.ai-bus', 'capabilities.json'), JSON.stringify({ version: 1, capabilities: [] }));
  const server = new HarnessServer(root, { credentialsDir });
  await server.mailbox.ensureInitialized(['dispatcher', ...seats]);
  await server.start(0);
  const workers = seats.map((seat) => spawnWorker(root, credentialsDir, seat));
  t.after(async () => {
    for (const worker of workers) {
      if (worker.child.exitCode === null) worker.child.kill('SIGTERM');
    }
    await Promise.all(workers.map((worker) => Promise.race([
      worker.completed,
      new Promise((resolve) => setTimeout(resolve, 2000))
    ])));
    await server.stop();
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  const leasesPath = path.join(root, '.ai-bus', 'runtime', 'harness', 'leases.json');
  await eventually(async () => {
    const state = await readJson(leasesPath);
    return seats.every((seat) => state?.leases?.some((lease) => lease.seat === seat && lease.clientId === `process-${seat}`));
  }, 'all three process leases');

  for (const seat of seats) {
    await server.mailbox.send({
      from: 'dispatcher',
      to: seat,
      kind: 'task',
      subject: `wake-${seat}`,
      body: `independent work for ${seat}`
    });
  }

  const results = await Promise.all(workers.map((worker) => worker.completed));
  for (let index = 0; index < seats.length; index += 1) {
    const result = results[index];
    assert.equal(result.code, 0, result.stderr);
    const wake = JSON.parse(result.stdout.trim());
    assert.equal(wake.wake, 'message');
    assert.equal(wake.messages.length, 1);
    assert.equal(wake.messages[0].to, seats[index]);
    assert.equal(wake.messages[0].subject, `wake-${seats[index]}`);
  }
  await eventually(async () => (await readJson(leasesPath))?.leases?.length === 0, 'all process leases released');
  const status = await server.mailbox.status();
  assert.deepEqual(seats.map((seat) => status.unread[seat]), [1, 1, 1], 'wake delivery must not acknowledge mail');

  const reads = await Promise.all(seats.map((seat) => runWorker(root, credentialsDir, seat, [
    'read', '--all', '--request-id', `read-${seat}`
  ])));
  for (let index = 0; index < seats.length; index += 1) {
    assert.equal(reads[index].code, 0, reads[index].stderr);
    const response = JSON.parse(reads[index].stdout.trim());
    assert.equal(response.result.length, 1);
    assert.equal(response.result[0].to, seats[index]);
  }

  const claims = await Promise.all(seats.map((seat) => runWorker(root, credentialsDir, seat, [
    'claim', '--paths', `work/${seat}`, '--why', 'independent process coverage', '--request-id', `claim-${seat}`
  ])));
  assert.ok(claims.every((result) => result.code === 0), claims.map((result) => result.stderr).join('\n'));
  const claimed = await server.mailbox.status();
  assert.deepEqual(Object.keys(claimed.claims).sort(), [...seats].sort());

  const forged = await runWorker(root, credentialsDir, 'codex', [
    'tool', '--name', 'mailbox_send', '--input-json', JSON.stringify({
      from: 'grok', to: 'claude', subject: 'forged', body: 'must be rejected'
    }), '--request-id', 'forged-process-call'
  ]);
  assert.equal(forged.code, 1);
  assert.match(forged.stderr, /seat_scope/);

  const malformedRelease = await runWorker(root, credentialsDir, 'codex', ['release', '--paths']);
  assert.equal(malformedRelease.code, 1);
  assert.match(malformedRelease.stderr, /Missing value for --paths/);
  const typoRelease = await runWorker(root, credentialsDir, 'codex', ['release', '--path', 'work/codex']);
  assert.equal(typoRelease.code, 1);
  assert.match(typoRelease.stderr, /Unknown option/);
  assert.ok((await server.mailbox.status()).claims.codex.length > 0, 'malformed release must not release claims');

  const duplicateArgs = [
    'send', '--to', 'grok', '--subject', 'idempotent process send', '--body', 'once', '--request-id', 'same-process-request'
  ];
  const duplicateSends = await Promise.all([
    runWorker(root, credentialsDir, 'codex', duplicateArgs),
    runWorker(root, credentialsDir, 'codex', duplicateArgs)
  ]);
  assert.ok(duplicateSends.every((result) => result.code === 0));
  assert.equal(
    JSON.parse(duplicateSends[0].stdout).result.seq,
    JSON.parse(duplicateSends[1].stdout).result.seq,
    'same seat and request id must execute once across processes'
  );
  const reused = await runWorker(root, credentialsDir, 'codex', [
    'send', '--to', 'grok', '--subject', 'changed', '--body', 'must fail', '--request-id', 'same-process-request'
  ]);
  assert.equal(reused.code, 1);
  assert.match(reused.stderr, /request_id_reuse/);
  const independent = await runWorker(root, credentialsDir, 'grok', [
    'send', '--to', 'codex', '--subject', 'independent principal', '--body', 'allowed', '--request-id', 'same-process-request'
  ]);
  assert.equal(independent.code, 0, independent.stderr);

  const endpoint = await readJson(path.join(root, '.ai-bus', 'runtime', 'harness', 'endpoint.json'));
  const seatDir = path.join(credentialsDir, endpoint.instanceId, 'seats');
  await fs.copyFile(path.join(seatDir, 'grok.token'), path.join(seatDir, 'codex.token'));
  const swapped = await runWorker(root, credentialsDir, 'codex', ['status']);
  assert.equal(swapped.code, 1);
  assert.match(swapped.stderr, /principal does not match/);
});

function spawnWorker(root, credentialsDir, seat) {
  const child = spawn(process.execPath, [
    path.resolve(__dirname, '..', 'dist', 'worker-client.js'),
    'wait', '--root', root, '--seat', seat, '--timeout-ms', '5000',
    '--credentials-dir', credentialsDir, '--client-id', `process-${seat}`
  ], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
  child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
  const completed = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
  return { child, completed };
}

function runWorker(root, credentialsDir, seat, command) {
  const child = spawn(process.execPath, [
    path.resolve(__dirname, '..', 'dist', 'worker-client.js'),
    ...command, '--root', root, '--seat', seat, '--credentials-dir', credentialsDir
  ], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
  child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
  return new Promise((resolve, reject) => {
    const watchdog = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error(`Worker command timed out: ${command.join(' ')}`));
    }, 15_000);
    watchdog.unref();
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      clearTimeout(watchdog);
      resolve({ code, signal, stdout, stderr });
    });
  });
}

async function readJson(candidate) {
  return fs.readFile(candidate, 'utf8').then(JSON.parse).catch(() => undefined);
}

async function eventually(predicate, label, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ${label}.`);
}
