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

async function readMessageFromDisk(rootDir, seq) {
  const dir = path.join(rootDir, '.ai-bus', 'runtime', 'mailbox', 'inbox');
  const files = await fs.readdir(dir);
  for (const file of files) {
    const parsed = JSON.parse(await fs.readFile(path.join(dir, file), 'utf8'));
    if (parsed.seq === seq) return parsed;
  }
  return undefined;
}
async function removeTree(target) {
  await fs.rm(target, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 });
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'portable-ai-bus-'));
  await fs.mkdir(path.join(root, 'src'), { recursive: true });
  await fs.mkdir(path.join(root, 'tests', 'unit'), { recursive: true });
  await fs.writeFile(path.join(root, 'src', 'mailbox.ts'), 'fixture');
  await fs.writeFile(path.join(root, 'src', 'bus.ts'), 'fixture');
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

test('targeted acknowledgement refuses a stale sequence without consuming current mail', async () => {
  const stale = await store.send({ from: 'claude', to: 'codex', subject: 'old', body: 'presented earlier' });
  const current = await store.send({ from: 'claude', to: 'codex', subject: 'correction', body: 'must survive refusal' });
  await store.acknowledge('codex', [stale.seq]);

  await assert.rejects(
    store.acknowledge('codex', [stale.seq, current.seq]),
    /no longer current unread mail/,
    'the complete requested set is validated before any row is mutated'
  );
  assert.deepEqual((await store.inbox('codex')).map((message) => message.seq), [current.seq]);
});

test('acknowledging a presented message refuses it after supersession without consuming its replacement', async () => {
  const original = await store.send({ from: 'claude', to: 'codex', subject: 'old', body: 'present this first' });
  const replacement = await store.send({ from: 'claude', to: 'codex', subject: 'new', body: 'must remain unread' });
  const [presented] = await store.inbox('codex');
  assert.equal(presented.seq, original.seq);

  await store.supersedeMessage(original.seq, replacement.seq, 'corrected instruction', 'claude');
  await assert.rejects(
    store.acknowledge('codex', [presented.seq]),
    /no longer current unread mail/,
    'a sequence that became stale after presentation must not acknowledge its replacement'
  );
  assert.deepEqual((await store.inbox('codex')).map((message) => message.seq), [replacement.seq]);
});

test('acknowledging a presented current message consumes only that message', async () => {
  const original = await store.send({ from: 'claude', to: 'codex', subject: 'first', body: 'present this first' });
  const next = await store.send({ from: 'claude', to: 'codex', subject: 'second', body: 'must remain unread' });
  const [presented] = await store.inbox('codex');
  assert.equal(presented.seq, original.seq);

  assert.deepEqual((await store.acknowledge('codex', [presented.seq])).map((message) => message.seq), [original.seq]);
  assert.deepEqual((await store.inbox('codex')).map((message) => message.seq), [next.seq]);
});

test('replacing a goal clears assignments from the previous coordination contract', async () => {
  await store.setGoal({ statement: 'old work', doneWhen: 'old evidence exists', setBy: 'operator' });
  await store.assignGoal('codex', 'implement the old work');
  assert.equal((await store.status()).goal.assignments.codex, 'implement the old work');

  const replaced = await store.setGoal({
    statement: 'new work',
    doneWhen: 'new evidence exists',
    setBy: 'operator'
  });
  assert.deepEqual(replaced.goal.assignments, {});
  assert.equal(replaced.lifecycleEvents.length, 2);
  assert.equal(replaced.lifecycleEvents[0].kind, 'goal-set');
  assert.equal(replaced.lifecycleEvents[1].kind, 'goal-replaced');
  assert.equal(replaced.lifecycleEvents[1].previousIdentity, replaced.lifecycleEvents[0].nextIdentity);
  assert.equal(replaced.lifecycleEvents[1].nextIdentity, replaced.goal.setAt);
});

test('a delayed acknowledgement cannot steal the baton from a newer holder', async () => {
  await store.send({ from: 'codex', to: 'claude', subject: 'work', body: 'take this task' });
  assert.equal((await store.status()).baton.holder, 'claude');
  await store.send({ from: 'claude', to: 'codex', kind: 'ack', subject: 'accepted', body: 'working' });
  assert.equal((await store.status()).baton.holder, 'claude');

  await store.send({ from: 'codex', to: 'codex', subject: 'new coordination', body: 'codex takes over' });
  assert.equal((await store.status()).baton.holder, 'codex');
  await store.send({ from: 'grok', to: 'claude', kind: 'ack', subject: 'late receipt', body: 'old work received' });
  assert.equal((await store.status()).baton.holder, 'codex');
});

test('atomic mailbox publish retries transient Windows rename failures', async () => {
  let failuresRemaining = 2;
  let renameAttempts = 0;
  const resilient = new MailboxStore(root, {
    renameFile: async (source, destination) => {
      renameAttempts += 1;
      if (failuresRemaining > 0) {
        failuresRemaining -= 1;
        const error = new Error('simulated scanner lock');
        error.code = 'EPERM';
        throw error;
      }
      await fs.rename(source, destination);
    }
  });

  await resilient.send({ from: 'codex', to: 'grok', subject: 'durable', body: 'survives contention' });
  assert.equal(renameAttempts, 4, 'message and state publishes should succeed after two retries');
  assert.equal((await resilient.inbox('grok'))[0].body, 'survives contention');
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
  await store.claim({ agent: 'codex', paths: ['src/mailbox.ts', 'src/bus.ts'], why: 'test fixture' });
  const held = await store.claim({ agent: 'codex', paths: ['src'], why: 'test fixture' });
  assert.deepEqual(held.map((claim) => claim.path), ['src']);
});

test('claim paths cannot escape the workspace', async () => {
  await assert.rejects(
    store.claim({ agent: 'codex', paths: ['../other-repo'], why: 'test fixture' }),
    /escapes the workspace/
  );
  await assert.rejects(
    store.claim({ agent: 'codex', paths: ['C:\\outside'], why: 'test fixture' }),
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

test('claiming a nonexistent path is refused atomically and records no hold', async () => {
  await assert.rejects(
    store.claim({ agent: 'codex', paths: ['src/mailbox.ts', 'bus.py'], why: 'test fixture' }),
    /Claim refused.*bus\.py.*No claim was recorded/i
  );
  assert.deepEqual(await store.claims(), {});
});

test('re-claiming an already held path is an idempotent confirmation, not a new record', async () => {
  const first = await store.claim({ agent: 'codex', paths: ['src/mailbox.ts'], why: 'first' });
  const transcriptBefore = await fs.readFile(store.paths.transcriptPath, 'utf8');
  const second = await store.claim({ agent: 'codex', paths: ['src/mailbox.ts'], why: 'retry' });
  const transcriptAfter = await fs.readFile(store.paths.transcriptPath, 'utf8');

  assert.deepEqual(second, first, 'the original claim metadata is preserved');
  assert.equal(second.length, 1, 'the held path appears exactly once');
  assert.equal(transcriptAfter, transcriptBefore, 'a retry does not append another claim event');
});

test('a symlink alias cannot bypass an existing physical-file claim', async () => {
  const alias = path.join(root, 'src', 'mailbox-alias.ts');
  await fs.symlink(path.join(root, 'src', 'mailbox.ts'), alias, 'file');

  await store.claim({ agent: 'codex', paths: ['src/mailbox.ts'], why: 'physical file' });
  await assert.rejects(
    store.claim({ agent: 'grok', paths: ['src/mailbox-alias.ts'], why: 'same file through alias' }),
    ClaimConflictError
  );
});

test('a directory junction cannot bypass a claim on a file beneath its target', async () => {
  const alias = path.join(root, 'source-junction');
  await fs.symlink(path.join(root, 'src'), alias, 'junction');

  await store.claim({ agent: 'codex', paths: ['src/mailbox.ts'], why: 'physical file' });
  await assert.rejects(
    store.claim({ agent: 'grok', paths: ['source-junction/mailbox.ts'], why: 'same file through junction' }),
    ClaimConflictError
  );
});

test('a hardlink alias cannot bypass an existing physical-file claim', async () => {
  const alias = path.join(root, 'src', 'mailbox-hardlink.ts');
  await fs.link(path.join(root, 'src', 'mailbox.ts'), alias);

  await store.claim({ agent: 'codex', paths: ['src/mailbox.ts'], why: 'physical file' });
  await assert.rejects(
    store.claim({ agent: 'grok', paths: ['src/mailbox-hardlink.ts'], why: 'same inode through hardlink' }),
    ClaimConflictError
  );
});

test('a directory claim covers a hardlink to one of its files outside the directory', async () => {
  const other = path.join(root, 'other');
  const alias = path.join(other, 'mailbox-hardlink.ts');
  await fs.mkdir(other);
  await fs.link(path.join(root, 'src', 'mailbox.ts'), alias);

  await store.claim({ agent: 'codex', paths: ['src'], why: 'source tree' });
  await assert.rejects(
    store.claim({ agent: 'grok', paths: ['other/mailbox-hardlink.ts'], why: 'same inode outside tree' }),
    ClaimConflictError
  );
});

test('a directory claim is refused when a hardlink to one of its files is already held', async () => {
  const other = path.join(root, 'other');
  const alias = path.join(other, 'mailbox-hardlink.ts');
  await fs.mkdir(other);
  await fs.link(path.join(root, 'src', 'mailbox.ts'), alias);

  await store.claim({ agent: 'codex', paths: ['other/mailbox-hardlink.ts'], why: 'file inode' });
  await assert.rejects(
    store.claim({ agent: 'grok', paths: ['src'], why: 'tree containing the inode' }),
    ClaimConflictError
  );
});

test('ITEM 14: an outbound junction from a claimed directory does not cover the foreign target', async () => {
  const other = path.join(root, 'other');
  await fs.mkdir(other);
  await fs.writeFile(path.join(other, 'only-in-other.ts'), 'foreign\n');
  await fs.symlink(other, path.join(root, 'src', 'out'), 'junction');

  await store.claim({ agent: 'codex', paths: ['src'], why: 'source tree' });
  const held = await store.claim({
    agent: 'grok',
    paths: ['other/only-in-other.ts'],
    why: 'outside the claimed tree'
  });
  assert.equal(held[0].path, 'other/only-in-other.ts');
});

test('ITEM 14: a directory claim does not walk an outbound junction onto a foreign tree', async () => {
  const other = path.join(root, 'other');
  await fs.mkdir(other);
  await fs.writeFile(path.join(other, 'unrelated.ts'), 'no overlap\n');
  const foreign = await fs.mkdtemp(path.join(os.tmpdir(), 'pab-i14-foreign-'));
  try {
    for (let d = 0; d < 50; d += 1) {
      const dir = path.join(foreign, `bucket-${String(d).padStart(2, '0')}`);
      await fs.mkdir(dir);
      await Promise.all(
        Array.from({ length: 50 }, (_, i) => fs.writeFile(path.join(dir, `f-${i}.txt`), `n=${d}-${i}\n`))
      );
    }
    await fs.symlink(foreign, path.join(root, 'src', 'escape'), 'junction');
    await store.claim({ agent: 'codex', paths: ['src'], why: 'tiny tree with outbound junction' });
    const started = process.hrtime.bigint();
    const held = await store.claim({
      agent: 'grok',
      paths: ['other/unrelated.ts'],
      why: 'must not walk the foreign volume'
    });
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
    assert.equal(held[0].path, 'other/unrelated.ts');
    assert.ok(
      elapsedMs < 80,
      `outbound junction made overlap check take ${elapsedMs.toFixed(1)}ms; unbounded walk was 326ms`
    );
  } finally {
    await fs.rm(foreign, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 });
  }
});

test('repo-root claims refuse paths missing from both roots and traversal outside them', async () => {
  const otherRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'portable-ai-bus-empty-root-'));
  try {
    await assert.rejects(
      store.claim({ agent: 'codex', paths: ['missing.txt'], repoRoot: otherRoot, why: 'test fixture' }),
      /Claim refused.*missing\.txt.*No claim was recorded/i
    );
    await assert.rejects(
      store.claim({ agent: 'codex', paths: ['../outside.txt'], repoRoot: otherRoot, why: 'test fixture' }),
      /escapes the workspace/
    );
    assert.deepEqual(await store.claims(), {});
  } finally {
    await removeTree(otherRoot);
  }
});

test('same relative path in two roots remains independently claimable and releasable', async () => {
  const otherRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'portable-ai-bus-other-root-'));
  try {
    await fs.mkdir(path.join(otherRoot, 'src'), { recursive: true });
    await fs.writeFile(path.join(otherRoot, 'src', 'mailbox.ts'), 'other fixture');

    await store.claim({ agent: 'codex', paths: ['src/mailbox.ts'], repoRoot: otherRoot, why: 'other repo' });
    const held = await store.claim({ agent: 'codex', paths: ['src/mailbox.ts'], why: 'bus repo' });
    assert.equal(held.length, 2);
    const comparableRoot = (value) => {
      const normalized = path.resolve(value).replace(/\\/g, '/').replace(/\/$/, '');
      return process.platform === 'win32' ? normalized.toLocaleLowerCase('en-US') : normalized;
    };
    assert.deepEqual(
      new Set(held.map((claim) => claim.root)),
      new Set([comparableRoot(await fs.realpath(root)), comparableRoot(await fs.realpath(otherRoot))])
    );

    const remaining = await store.release('codex', ['src/mailbox.ts']);
    assert.equal(remaining.length, 1);
    assert.equal(remaining[0].root, comparableRoot(await fs.realpath(otherRoot)));

    const busClaim = await store.claim({ agent: 'grok', paths: ['src/mailbox.ts'], why: 'bus repo' });
    assert.equal(busClaim[0].root, comparableRoot(await fs.realpath(root)));
    const healthy = await store.doctor();
    assert.equal(healthy.ok, true, healthy.problems.join('\n'));
  } finally {
    await removeTree(otherRoot);
  }
});

test('repo-scoped release respects the requested root when only one lexical match is held', async () => {
  const otherRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'portable-ai-bus-release-root-'));
  try {
    await fs.mkdir(path.join(otherRoot, 'src'), { recursive: true });
    await fs.writeFile(path.join(otherRoot, 'src', 'mailbox.ts'), 'other fixture');
    await store.claim({ agent: 'codex', paths: ['src/mailbox.ts'], why: 'bus repo' });

    await assert.rejects(
      store.release('codex', ['src/mailbox.ts'], otherRoot),
      /does not hold exact claim/
    );
    assert.equal((await store.claims()).codex.length, 1);
  } finally {
    await removeTree(otherRoot);
  }
});

test('same file in the same root remains mutually exclusive', async () => {
  await store.claim({ agent: 'codex', paths: ['src/mailbox.ts'], why: 'test fixture' });
  await assert.rejects(
    store.claim({ agent: 'grok', paths: ['src/mailbox.ts'], why: 'test fixture' }),
    ClaimConflictError
  );
});

async function writeLegacyClaim(agent = 'codex', claimPath = 'src/mailbox.ts') {
  const statePath = path.join(root, '.ai-bus', 'runtime', 'mailbox', 'state.json');
  const state = JSON.parse(await fs.readFile(statePath, 'utf8'));
  state.claims[agent] = [{ path: claimPath, why: 'legacy hold', at: new Date().toISOString() }];
  await fs.writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
}

async function writeClaims(claims) {
  const statePath = path.join(root, '.ai-bus', 'runtime', 'mailbox', 'state.json');
  const state = JSON.parse(await fs.readFile(statePath, 'utf8'));
  state.claims = claims;
  await fs.writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
}

test('doctor detects directory coverage of an out-of-tree hardlink', async () => {
  const other = path.join(root, 'other');
  const alias = path.join(other, 'mailbox-hardlink.ts');
  await fs.mkdir(other);
  await fs.link(path.join(root, 'src', 'mailbox.ts'), alias);
  await store.claim({ agent: 'codex', paths: ['src'], why: 'source tree' });
  const directoryClaim = (await store.claims()).codex[0];
  await store.release('codex');
  await store.claim({ agent: 'grok', paths: ['other/mailbox-hardlink.ts'], why: 'file inode' });
  const fileClaim = (await store.claims()).grok[0];
  await writeClaims({ codex: [directoryClaim], grok: [fileClaim] });

  const report = await store.doctor();
  assert.equal(report.ok, false);
  assert.match(report.problems.join('\n'), /claims overlap: codex:src and grok:other\/mailbox-hardlink\.ts/);
});

test('doctor migrates reachable legacy and path-identity claims before hardlink comparison', async () => {
  const other = path.join(root, 'other');
  const alias = path.join(other, 'mailbox-hardlink.ts');
  await fs.mkdir(other);
  await fs.link(path.join(root, 'src', 'mailbox.ts'), alias);
  const at = new Date().toISOString();
  const pathIdentity = await fs.realpath(path.join(root, 'src', 'mailbox.ts'));
  await store.claim({ agent: 'grok', paths: ['other/mailbox-hardlink.ts'], why: 'inode shape' });
  const inodeClaim = (await store.claims()).grok[0];

  for (const oldClaim of [
    { path: 'src/mailbox.ts', why: 'legacy shape', at },
    { path: 'src/mailbox.ts', root, identity: pathIdentity, why: 'path-identity shape', at }
  ]) {
    await writeClaims({ codex: [oldClaim], grok: [inodeClaim] });
    const report = await store.doctor();
    assert.equal(report.ok, false, `doctor missed ${oldClaim.why}`);
    assert.match(report.problems.join('\n'), /claims overlap/);
    const migrated = (await store.claims()).codex[0];
    assert.match(migrated.identity, /^filesystem-v1:/);
    assert.ok(migrated.root, 'migration records the observed root');
  }
});

test('a legacy claim with no root or identity still blocks a conflicting claim', async () => {
  await writeLegacyClaim();
  await assert.rejects(
    store.claim({ agent: 'grok', paths: ['src/mailbox.ts'], why: 'collision' }),
    ClaimConflictError
  );
});

test('a legacy claim can still be released exactly by its holder', async () => {
  await writeLegacyClaim();
  assert.deepEqual(await store.release('codex', ['src/mailbox.ts']), []);
  assert.deepEqual(await store.claims(), {});
});

test('doctor upgrades a reachable non-overlapping legacy claim from observed filesystem identity', async () => {
  await writeLegacyClaim();
  const report = await store.doctor();
  assert.equal(report.ok, true, report.problems.join('\n'));
  const held = (await store.claims()).codex[0];
  assert.ok(held.root);
  assert.match(held.identity, /^filesystem-v1:/);
});

test('doctor names an unreachable legacy claim as weaker instead of inventing an inode', async () => {
  await writeLegacyClaim('codex', 'src/vanished.ts');
  const report = await store.doctor();
  assert.equal(report.ok, true, report.problems.join('\n'));
  assert.match(
    report.warnings.join('\n'),
    /codex:src\/vanished\.ts uses weaker legacy claim identity.*cannot be verified/
  );
  const held = (await store.claims()).codex[0];
  assert.equal(held.root, undefined);
  assert.equal(held.identity, undefined);
});

test('superseded unread mail is skipped by delivery and unread status', async () => {
  const original = await store.send({ from: 'codex', to: 'grok', subject: 'old', body: 'stale' });
  const correction = await store.send({ from: 'codex', to: 'grok', subject: 'new', body: 'current' });
  assert.equal((await store.status()).unread.grok, 2);
  assert.deepEqual((await store.inbox('grok')).map((message) => message.seq), [original.seq, correction.seq],
    'red-first gate: send alone still delivers the stale original first');
  await store.supersedeMessage(original.seq, correction.seq, 'corrected instruction', 'codex');
  assert.equal((await store.status()).unread.grok, 1);
  assert.deepEqual((await store.inbox('grok')).map((message) => message.seq), [correction.seq]);
  assert.deepEqual((await store.read('grok')).map((message) => message.seq), [correction.seq]);
});

test('transcript records message supersession metadata', async () => {
  const original = await store.send({ from: 'codex', to: 'grok', subject: 'old', body: 'stale' });
  const correction = await store.send({ from: 'codex', to: 'grok', subject: 'new', body: 'current' });

  await store.supersedeMessage(original.seq, correction.seq, 'corrected instruction', 'codex');

  const transcript = await fs.readFile(store.paths.transcriptPath, 'utf8');
  assert.match(transcript, new RegExp(`supersededBy: ${correction.seq}`));
  assert.match(transcript, /supersedeReason: corrected instruction/);
});

test('mailbox usage lists the supersede command', async () => {
  await assert.rejects(
    execFileAsync(process.execPath, [mailboxCli, 'not-a-command', '--root', root]),
    (error) => {
      assert.match(error.stderr, /usage: mailbox/);
      assert.match(error.stderr, /supersede/);
      return true;
    }
  );
});

test('mailbox CLI exposes sender-authorized supersede', async () => {
  const original = await store.send({ from: 'codex', to: 'grok', subject: 'old', body: 'stale' });
  const correction = await store.send({ from: 'codex', to: 'grok', subject: 'new', body: 'current' });
  await execFileAsync(process.execPath, [
    mailboxCli, 'supersede', '--root', root, '--from', 'codex', '--seq', String(original.seq),
    '--by', String(correction.seq), '--reason', 'CLI correction'
  ]);
  assert.deepEqual((await store.inbox('grok')).map((message) => message.seq), [correction.seq]);
});

test('a sender cannot supersede another seat\'s mail', async () => {
  const original = await store.send({ from: 'claude', to: 'grok', subject: 'old', body: 'first' });
  const correction = await store.send({ from: 'codex', to: 'grok', subject: 'new', body: 'second' });
  await assert.rejects(
    store.supersedeMessage(original.seq, correction.seq, 'not mine', 'codex'),
    /only messages it sent itself/
  );
});

test('the mailbox store requires an actor to supersede mail', async () => {
  const original = await store.send({ from: 'claude', to: 'grok', subject: 'old', body: 'first' });
  const correction = await store.send({ from: 'claude', to: 'grok', subject: 'new', body: 'second' });
  await assert.rejects(
    store.supersedeMessage(original.seq, correction.seq, 'forged retract'),
    /actor/
  );
  assert.deepEqual((await store.inbox('grok')).map((message) => message.seq), [original.seq, correction.seq]);
});

test('Windows claim comparison preserves case and separator exclusion', {
  skip: process.platform !== 'win32'
}, async () => {
  await store.claim({ agent: 'codex', paths: ['src/mailbox.ts'], why: 'test fixture' });
  await assert.rejects(
    store.claim({ agent: 'grok', paths: ['SRC\\MAILBOX.TS'], why: 'test fixture' }),
    ClaimConflictError
  );
});

test('status warns well before the round guard fails mutating tools closed', async () => {
  const limitedRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'portable-ai-bus-round-warning-'));
  try {
    const limited = new MailboxStore(limitedRoot);
    await limited.ensureInitialized(['codex'], 20);
    for (let round = 0; round < 10; round += 1) {
      await limited.send({ from: 'codex', to: 'codex', subject: `round ${round}`, body: 'advance' });
    }
    const status = await limited.status();
    assert.match(status.roundWarning, /10 rounds remain.*10\/20/i);
  } finally {
    await removeTree(limitedRoot);
  }
});

test('parked poison mail remains inspectable and can be requeued', async () => {
  const poison = await store.send({ from: 'codex', to: 'grok', subject: 'poison', body: 'bad provider input' });
  const parked = await store.park('grok', poison.seq, 'three unusable provider plans');
  assert.equal(parked.read, true);
  assert.equal(typeof parked.parkedAt, 'string');
  assert.equal(parked.parkedReason, 'three unusable provider plans');
  assert.deepEqual((await store.inbox('grok')).map((message) => message.seq), []);
  assert.deepEqual((await store.parked('grok')).map((message) => message.seq), [poison.seq]);

  const recovered = await store.requeue('grok', poison.seq);
  assert.equal(recovered.read, false);
  assert.equal(recovered.parkedAt, undefined);
  assert.deepEqual((await store.inbox('grok')).map((message) => message.seq), [poison.seq]);
});

test('mailbox CLI lists and requeues parked mail for human recovery', async () => {
  const poison = await store.send({ from: 'codex', to: 'grok', subject: 'CLI poison', body: 'inspect me' });
  await store.park('grok', poison.seq, 'retry limit');
  const listed = await execFileAsync(process.execPath, [mailboxCli, 'parked', '--root', root, '--for', 'grok', '--json']);
  assert.deepEqual(JSON.parse(listed.stdout).map((message) => message.seq), [poison.seq]);
  const recovered = await execFileAsync(process.execPath, [mailboxCli, 'requeue', '--root', root, '--for', 'grok', '--seq', String(poison.seq)]);
  assert.match(recovered.stdout, new RegExp(`requeued #${poison.seq}`));
  assert.deepEqual((await store.inbox('grok')).map((message) => message.seq), [poison.seq]);
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
  delete legacy.lifecycleEvents;
  await fs.writeFile(statePath, `${JSON.stringify(legacy, null, 2)}\n`, 'utf8');
  const status = await store.status();
  assert.deepEqual(status.haltPolicy, { onStepCompletion: false, onGoalCompletion: true, atRounds: [], everyRounds: null });
  assert.deepEqual(status.completions, []);
  assert.deepEqual(status.lifecycleEvents, []);
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

// ---------------------------------------------------------------------------
// Item 7: a claim must say why it exists.
// Measured: ClaimInput.why was optional and landed as '', while the baton path has demanded a
// reason on every refusal since it was written. Two halves of one system disagreeing.
// ---------------------------------------------------------------------------

test('ITEM 7 RED: a claim with no reason is refused at the store', async () => {
  await assert.rejects(
    () => store.claim({ agent: 'grok', paths: ['src/bus.ts'] }),
    /--why is required/
  );
  const claims = await store.claims();
  assert.equal((claims.grok ?? []).length, 0, 'nothing may be recorded when the reason is missing');
});

test('ITEM 7 RED: a blank reason is refused too', async () => {
  await assert.rejects(
    () => store.claim({ agent: 'grok', paths: ['src/bus.ts'], why: '   ' }),
    /--why is required/
  );
  const claims = await store.claims();
  assert.equal((claims.grok ?? []).length, 0);
});

test('ITEM 7 GREEN: a claim with a reason succeeds and keeps it', async () => {
  const held = await store.claim({ agent: 'grok', paths: ['src/bus.ts'], why: 'item 14 walk bound' });
  assert.equal(held.length, 1);
  const persisted = (await store.claims()).grok[0];
  assert.equal(persisted.why, 'item 14 walk bound', 'the reason is what an operator reads later');
});

// ---------------------------------------------------------------------------
// Item 13: a claim can be too broad to be useful.
// Measured 2026-08-15: a seat claimed "." meaning the files it was editing, and locked all
// three seats out of the entire repository with no warning and no expiry.
// ---------------------------------------------------------------------------

test('ITEM 13 RED: claiming the repository root is refused', async () => {
  await assert.rejects(
    () => store.claim({ agent: 'codex', paths: ['.'], why: 'implement everything' }),
    /whole repository/
  );
  const claims = await store.claims();
  assert.equal((claims.codex ?? []).length, 0, 'a refused root claim must record nothing');
});

test('ITEM 13 GREEN: an ancestor claim below the root still works and still covers children', async () => {
  const held = await store.claim({ agent: 'codex', paths: ['src'], why: 'editing the src tree' });
  assert.equal(held.length, 1);
  await assert.rejects(
    () => store.claim({ agent: 'grok', paths: ['src/bus.ts'], why: 'conflicting' }),
    ClaimConflictError
  );
});

// ---------------------------------------------------------------------------
// Item 20: a checkpoint can become unclosable.
// closeRecovery is reachable only from the runner, so a checkpoint held by a seat with no
// running brain can never be closed. The live case asserted "implement item 9" for hours after
// item 9 was certified.
// ---------------------------------------------------------------------------

test('ITEM 20 RED: another seat cannot close it, and the row survives', async () => {
  const source = await store.send({ from: 'claude', to: 'grok', kind: 'task', subject: 'work', body: 'do it' });
  await store.openRecovery('grok', source.seq, 'half done');
  const nothing = await store.closeRecovery('codex', source.seq, 'not mine to close');
  assert.equal(nothing, undefined);
  const stillOpen = await store.openRecoveryFor('grok');
  assert.ok(stillOpen, 'another seat must not be able to clear it');
  assert.equal(stillOpen.status, 'open');
});

test('ITEM 20 GREEN: an operator can close a stranded checkpoint, marked as an operator action', async () => {
  const source = await store.send({ from: 'claude', to: 'grok', kind: 'task', subject: 'work', body: 'do it' });
  await store.openRecovery('grok', source.seq, 'implement item 9');
  const closed = await store.operatorCloseRecovery('grok', source.seq, 'item 9 certified hours ago');
  assert.ok(closed);
  assert.equal(closed.status, 'closed');
  assert.match(closed.closeReason, /^operator-closed: /, 'never reads as completed work');
  assert.equal(await store.openRecoveryFor('grok'), undefined);
});

test('ITEM 20: an operator close without a reason is refused and leaves the row alone', async () => {
  const source = await store.send({ from: 'claude', to: 'grok', kind: 'task', subject: 'work', body: 'do it' });
  await store.openRecovery('grok', source.seq, 'half done');
  await assert.rejects(() => store.operatorCloseRecovery('grok', source.seq, '  '), /reason is required/);
  assert.ok(await store.openRecoveryFor('grok'), 'a refused operator close must leave the row alone');
});


// ---------------------------------------------------------------------------
// Item 18: send and supersede were two steps, and between them BOTH were current.
// One operation, one lock, one pair of writes. Design argued by codex and accepted.
// ---------------------------------------------------------------------------

test('ITEM 18 GREEN: an atomic superseding send hides the original and marks the pair', async () => {
  const original = await store.send({
    from: 'claude', to: 'grok', kind: 'task', subject: 'COMMIT NOW', body: 'ship it'
  });
  const correction = await store.send({
    from: 'claude', to: 'grok', kind: 'task', subject: 'DO NOT COMMIT', body: 'hold',
    supersedes: original.seq, supersedeReason: 'wrong call, two minutes later'
  });

  assert.equal(correction.superseded, true, 'the send reports that supersession took effect');
  const inbox = await store.inbox('grok');
  assert.deepEqual(inbox.map((m) => m.seq), [correction.seq], 'only the correction is current');

  // read back from disk through a fresh store - not the object we just held
  const stale = await readMessageFromDisk(root, original.seq);
  assert.equal(stale.supersededBy, correction.seq);
  assert.match(stale.supersedeReason, /wrong call/);
  assert.equal(stale.body, 'ship it', 'the original body is preserved, not rewritten');
});

test('ITEM 18: a consumed target still delivers the correction and says target-consumed', async () => {
  const original = await store.send({
    from: 'claude', to: 'grok', kind: 'task', subject: 'COMMIT NOW', body: 'ship it'
  });
  await store.acknowledge('grok', [original.seq]);   // recipient already consumed it

  const correction = await store.send({
    from: 'claude', to: 'grok', kind: 'task', subject: 'DO NOT COMMIT', body: 'hold',
    supersedes: original.seq
  });

  assert.equal(correction.superseded, false, 'no supersession may be claimed');
  assert.equal(correction.supersedeOutcome, 'target-consumed', 'and the sender is told why');
  const consumed = await readMessageFromDisk(root, original.seq);
  assert.equal(consumed.supersededBy, undefined, 'a consumed row must not gain supersededBy');
  const current = await store.inbox('grok');
  assert.deepEqual(current.map((m) => m.seq), [correction.seq], 'the correction is still delivered');
});

test('ITEM 18 RED: an invalid target sends NOTHING - no half-applied state', async () => {
  const before = (await store.inbox('grok')).length;
  await assert.rejects(
    () => store.send({ from: 'claude', to: 'grok', kind: 'task', subject: 'x', body: 'y', supersedes: 99999 }),
    /no such message.*Nothing was sent/i
  );
  const after = (await store.inbox('grok')).length;
  assert.equal(after, before, 'a refused superseding send must not create a message');
});

test('ITEM 18 RED: superseding another sender message is refused and sends nothing', async () => {
  const theirs = await store.send({ from: 'codex', to: 'grok', kind: 'task', subject: 'theirs', body: 'mine' });
  const before = (await store.inbox('grok')).length;
  await assert.rejects(
    () => store.send({ from: 'claude', to: 'grok', kind: 'task', subject: 'x', body: 'y', supersedes: theirs.seq }),
    /sent by codex.*Nothing was sent/i
  );
  assert.equal((await store.inbox('grok')).length, before);
});

test('ITEM 18 RED: an already-superseded unconsumed target is refused', async () => {
  const original = await store.send({ from: 'claude', to: 'grok', kind: 'task', subject: 'a', body: 'a' });
  await store.send({
    from: 'claude', to: 'grok', kind: 'task', subject: 'b', body: 'b', supersedes: original.seq
  });
  const before = (await store.inbox('grok')).length;
  await assert.rejects(
    () => store.send({ from: 'claude', to: 'grok', kind: 'task', subject: 'c', body: 'c', supersedes: original.seq }),
    /already superseded/i
  );
  assert.equal((await store.inbox('grok')).length, before);
});

test('ITEM 18: the superseded original cannot then be acknowledged as current (item 3 holds)', async () => {
  const original = await store.send({ from: 'claude', to: 'grok', kind: 'task', subject: 'a', body: 'a' });
  await store.send({
    from: 'claude', to: 'grok', kind: 'task', subject: 'b', body: 'b', supersedes: original.seq
  });
  await assert.rejects(() => store.acknowledge('grok', [original.seq]), /no longer current/i);
});

test('ITEM 18 GREEN CONTROL: an ordinary send with no supersedes is untouched', async () => {
  const plain = await store.send({ from: 'claude', to: 'grok', kind: 'note', subject: 'ordinary', body: 'hello' });
  assert.equal(plain.superseded, undefined, 'a plain send carries no supersession fields');
  assert.equal(plain.supersedeOutcome, undefined);
  const inbox = await store.inbox('grok');
  assert.ok(inbox.some((m) => m.seq === plain.seq), 'and it is delivered normally');
});

