const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { afterEach, beforeEach, test } = require('node:test');

const execFileAsync = promisify(execFile);
const { BusHaltedError, ClaimConflictError, MailboxStore } = require('../dist/mailbox.js');
const mailboxCli = path.resolve(__dirname, '..', 'dist', 'mailbox.js');

let root;
let store;

async function removeTree(target) {
  await fs.rm(target, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 });
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'portable-ai-bus-'));
  store = new MailboxStore(root);
  await store.ensureInitialized(['claude', 'codex', 'grok'], 32);
});

afterEach(async () => {
  await removeTree(root);
});

test('Unicode messages round-trip and batch read marks every selected message', async () => {
  await store.send({
    from: 'grok',
    to: 'codex',
    kind: 'finding',
    subject: 'Delegation - exact edge',
    body: 'AGENT -> AGENT_DELEGATED; save barrier remains explicit.'
  });
  await store.send({
    from: 'claude',
    to: 'codex',
    kind: 'review',
    subject: 'Unicode survives',
    body: 'cell detach \u2192 delegated; em dash \u2014 preserved'
  });

  const messages = await store.read('codex', true);
  assert.equal(messages.length, 2);
  assert.match(messages[1].body, /\u2192 delegated/);
  assert.equal((await store.inbox('codex')).length, 0);
});

test('a non-repository mailbox does not spawn git merely to report status', async () => {
  const fakeBin = await fs.mkdtemp(path.join(os.tmpdir(), 'portable-ai-bus-fake-git-'));
  const marker = path.join(fakeBin, 'invoked.txt');
  const hook = path.join(fakeBin, 'hook.cjs');
  const fakeGit = path.join(fakeBin, process.platform === 'win32' ? 'git.exe' : 'git');
  const originalPath = process.env.PATH;
  const originalNodeOptions = process.env.NODE_OPTIONS;
  try {
    await fs.copyFile(process.execPath, fakeGit);
    if (process.platform !== 'win32') await fs.chmod(fakeGit, 0o755);
    await fs.writeFile(
      hook,
      `require('node:fs').appendFileSync(${JSON.stringify(marker)}, 'git spawned\\n');`,
      'utf8'
    );
    process.env.PATH = fakeBin;
    process.env.NODE_OPTIONS = `--require=${hook}`;

    await store.status();

    await assert.rejects(fs.access(marker), { code: 'ENOENT' });
  } finally {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    if (originalNodeOptions === undefined) delete process.env.NODE_OPTIONS;
    else process.env.NODE_OPTIONS = originalNodeOptions;
    await removeTree(fakeBin);
  }
});

test('claims accumulate and an exact scoped release preserves remaining ownership', async () => {
  await store.claim({ agent: 'codex', paths: ['src/mailbox.ts'], why: 'runtime' });
  const held = await store.claim({ agent: 'codex', paths: ['tests/'], why: 'regressions' });
  assert.deepEqual(
    held.map((claim) => claim.path),
    ['src/mailbox.ts', 'tests']
  );

  const remaining = await store.release('codex', ['src/mailbox.ts']);
  assert.deepEqual(remaining.map((claim) => claim.path), ['tests']);
  await assert.rejects(
    store.claim({ agent: 'grok', paths: ['tests/unit'], why: 'collision' }),
    ClaimConflictError
  );
  await store.claim({ agent: 'grok', paths: ['src/mailbox.ts'], why: 'now free' });
});

test('a broader claim replaces redundant narrower claims owned by the same agent', async () => {
  await store.claim({ agent: 'codex', paths: ['src/mailbox.ts', 'src/bus.ts'] });
  const held = await store.claim({ agent: 'codex', paths: ['src'] });
  assert.deepEqual(held.map((claim) => claim.path), ['src']);
});

test('claim paths cannot escape the workspace', async () => {
  await assert.rejects(
    store.claim({ agent: 'codex', paths: ['../other-repo'] }),
    /escapes the workspace/
  );
  await assert.rejects(
    store.claim({ agent: 'codex', paths: ['C:\\outside'] }),
    /workspace-relative/
  );
});

test('round guard halts sends until an explicit resume adds capacity', async () => {
  const limitedRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'portable-ai-bus-limited-'));
  try {
    const limited = new MailboxStore(limitedRoot);
    await limited.ensureInitialized(['codex', 'grok'], 1);
    await limited.send({ from: 'codex', to: 'grok', subject: 'one', body: 'first' });
    await assert.rejects(
      limited.send({ from: 'codex', to: 'grok', subject: 'two', body: 'second' }),
      BusHaltedError
    );
    await limited.resume(1);
    const second = await limited.send({ from: 'codex', to: 'grok', subject: 'two', body: 'second' });
    assert.equal(second.round, 2);
  } finally {
    await removeTree(limitedRoot);
  }
});

test('registering a late seat preserves the configured round limit', async () => {
  const limitedRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'portable-ai-bus-register-'));
  try {
    const limited = new MailboxStore(limitedRoot);
    await limited.ensureInitialized(['codex'], 3);
    const state = await limited.registerAgents(['vscode-lm']);
    assert.equal(state.maxRounds, 3);
    assert.deepEqual(state.agents, ['codex', 'vscode-lm']);
  } finally {
    await removeTree(limitedRoot);
  }
});

test('active worker registration fails closed at the round guard', async () => {
  const limitedRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'portable-ai-bus-active-register-'));
  try {
    const limited = new MailboxStore(limitedRoot);
    await limited.ensureInitialized(['codex'], 1);
    await limited.send({ from: 'codex', to: 'codex', subject: 'cap', body: 'reach guard' });
    await assert.rejects(() => limited.registerAgents(['pab-lm-worker'], true), BusHaltedError);
    assert.deepEqual((await limited.status()).agents, ['codex']);
  } finally {
    await removeTree(limitedRoot);
  }
});

test('step and goal completion use independent explicit halt policies', async () => {
  const initial = await store.status();
  assert.deepEqual(initial.haltPolicy, { onStepCompletion: false, onGoalCompletion: true, atRounds: [], everyRounds: null });
  const firstStep = await store.complete({ scope: 'step', actor: 'codex', summary: 'Implemented parser', evidence: ['npm test'] });
  assert.equal(firstStep.halted, false);
  assert.equal((await store.status()).halted, false);

  await store.configureHalting({ onStepCompletion: true, onGoalCompletion: false });
  const secondStep = await store.complete({ scope: 'step', actor: 'codex', summary: 'Reviewed checkpoint' });
  assert.equal(secondStep.halted, true);
  assert.match((await store.status()).stopReason, /step completed by codex/);
  await store.resume();

  const goal = await store.complete({ scope: 'goal', actor: 'operator', summary: 'Goal evidence accepted' });
  assert.equal(goal.halted, false);
  const status = await store.status();
  assert.equal(status.halted, false);
  assert.deepEqual(status.completions.map((item) => item.scope), ['step', 'step', 'goal']);
});

test('completion records cannot mutate an already halted mailbox', async () => {
  await store.halt('review checkpoint');
  await assert.rejects(store.complete({ scope: 'step', actor: 'codex', summary: 'late mutation' }), /review checkpoint/);
  assert.equal((await store.status()).completions.length, 0);
});

test('legacy mailbox state receives safe completion policy defaults', async () => {
  const statePath = path.join(root, '.ai-bus', 'runtime', 'mailbox', 'state.json');
  const legacy = JSON.parse(await fs.readFile(statePath, 'utf8'));
  delete legacy.haltPolicy;
  delete legacy.completions;
  await fs.writeFile(statePath, `${JSON.stringify(legacy, null, 2)}\n`, 'utf8');
  const status = await store.status();
  assert.deepEqual(status.haltPolicy, { onStepCompletion: false, onGoalCompletion: true, atRounds: [], everyRounds: null });
  assert.deepEqual(status.completions, []);
});

test('designated and recurring round checkpoints halt after durably writing the triggering message', async () => {
  await store.configureHalting({ atRounds: [2], everyRounds: 3 });
  await store.send({ from: 'codex', to: 'grok', subject: 'round one', body: 'continue' });
  assert.equal((await store.status()).halted, false);
  const checkpoint = await store.send({ from: 'grok', to: 'codex', subject: 'round two', body: 'pause after delivery' });
  assert.equal(checkpoint.round, 2);
  assert.match((await store.status()).stopReason, /designated round checkpoint \(2\)/);
  assert.equal((await store.inbox('codex')).length, 1);
  await store.resume();
  await store.send({ from: 'codex', to: 'grok', subject: 'round three', body: 'recurring pause' });
  assert.match((await store.status()).stopReason, /designated round checkpoint \(3\)/);
});

test('concurrent CLI senders receive unique ordered sequences without losing messages', async () => {
  const sends = Array.from({ length: 12 }, (_, index) =>
    execFileAsync(process.execPath, [
      mailboxCli,
      'send',
      '--root',
      root,
      '--from',
      index % 2 === 0 ? 'codex' : 'grok',
      '--to',
      'claude',
      '--subject',
      `message-${index}`,
      '--body',
      `body-${index}`
    ])
  );
  await Promise.all(sends);

  const messages = await store.inbox('claude');
  assert.equal(messages.length, 12);
  assert.deepEqual(
    messages.map((message) => message.seq),
    Array.from({ length: 12 }, (_, index) => index + 1)
  );
  const status = await store.status();
  assert.equal(status.seq, 12);
  assert.equal(status.round, 12);
});

test('a dead mailbox owner is recovered without overlapping concurrent senders', async () => {
  const lockPath = path.join(root, '.ai-bus', 'runtime', 'mailbox', '.lock');
  await fs.writeFile(lockPath, `${JSON.stringify({ id: 'dead-owner', pid: 2147483647 })}\n`, 'utf8');
  await Promise.all(Array.from({ length: 8 }, (_, index) => execFileAsync(process.execPath, [
    mailboxCli, 'send', '--root', root, '--from', 'codex', '--to', 'grok', '--subject', `recovery-${index}`, '--body', 'one'
  ])));
  const messages = await store.inbox('grok');
  assert.equal(messages.length, 8);
  assert.deepEqual(messages.map((message) => message.seq), [1, 2, 3, 4, 5, 6, 7, 8]);
  await assert.rejects(fs.access(lockPath));
  await assert.rejects(fs.access(`${lockPath}.recovery`));
});

test('doctor reports healthy state and detects sequence drift', async () => {
  await store.send({ from: 'codex', to: 'grok', subject: 'health', body: 'check' });
  const healthy = await store.doctor();
  assert.equal(healthy.ok, true);
  assert.equal(healthy.metrics.messages, 1);

  const statePath = path.join(root, '.ai-bus', 'runtime', 'mailbox', 'state.json');
  const state = JSON.parse(await fs.readFile(statePath, 'utf8'));
  state.seq = 0;
  await fs.writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');

  const unhealthy = await store.doctor();
  assert.equal(unhealthy.ok, false);
  assert.match(unhealthy.problems.join('\n'), /state seq is 0; inbox maximum is 1/);
});

test('doctor reports a stranded recovery lock immediately with safe remediation', async () => {
  const recoveryPath = path.join(root, '.ai-bus', 'runtime', 'mailbox', '.lock.recovery');
  await fs.writeFile(recoveryPath, `${JSON.stringify({ id: 'stranded', pid: 2147483647 })}\n`, 'utf8');
  const started = Date.now();
  const report = await store.doctor();
  assert.equal(report.ok, false);
  assert.ok(Date.now() - started < 1000);
  assert.match(report.problems.join('\n'), /recovery lock.*dead PID.*blocks safe automatic recovery/);
  assert.match(report.warnings.join('\n'), /verify the recorded PID/);
});

test('missing state with durable messages fails closed instead of synthesizing a new epoch', async () => {
  await store.send({ from: 'codex', to: 'grok', subject: 'durable', body: 'must survive' });
  await fs.rm(path.join(root, '.ai-bus', 'runtime', 'mailbox', 'state.json'));
  await assert.rejects(store.status(), /Mailbox state is missing while durable artifacts remain/);
  await assert.rejects(store.send({ from: 'codex', to: 'grok', subject: 'unsafe', body: 'no' }), /Mailbox state is missing/);
});
