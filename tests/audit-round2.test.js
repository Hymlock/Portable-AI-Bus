const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { test } = require('node:test');
const { MailboxStore } = require('../dist/mailbox.js');

// ---------------------------------------------------------------------------
// Round 2 of grok's audit. Every gate here is one of ITS attacks, not a restatement of the
// patch, because round 1 is exactly what happens when the gate is written from the fix: I
// closed the attack I was shown and grok walked one step around the edge of it.
//
// So each of these also carries a WIDER case than the attack that prompted it - the point is
// to prove the CLASS is closed, not the instance.
// ---------------------------------------------------------------------------

const REPO = path.join(__dirname, '..');
const GUARD = path.join(REPO, 'scripts', 'claim-guard-cli.js');

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' });
}

function junction(link, target) {
  try {
    execFileSync('cmd.exe', ['/c', 'mklink', '/J', link, target], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

/**
 * A throwaway git repo with a real staged type error, plus a bus root whose state.json grants
 * the seat a claim over everything in it. The claim stage must PASS so that what these gates
 * observe is the compile stage and nothing else.
 */
async function fixtureRepo(t) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'pab-guard-'));
  t.after(() => fsp.rm(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 }).catch(() => {}));

  const repo = path.join(dir, 'repo');
  await fsp.mkdir(path.join(repo, 'src'), { recursive: true });
  git(repo, 'init', '-q');
  git(repo, 'config', 'user.email', 'gate@example.com');
  git(repo, 'config', 'user.name', 'gate');
  // node_modules is linked in below. Without this, `git add -A` walks the whole real
  // node_modules through the junction and the fixture never finishes.
  await fsp.writeFile(path.join(repo, '.gitignore'), 'node_modules/\n');

  await fsp.writeFile(path.join(repo, 'tsconfig.json'), JSON.stringify({
    compilerOptions: { strict: true, noEmit: true, skipLibCheck: true, types: [] },
    include: ['src']
  }, null, 2));
  await fsp.writeFile(path.join(repo, 'src', 'ok.ts'), 'export const fine: number = 1;\n');
  await fsp.writeFile(path.join(repo, 'src', 'index.ts'), 'export const good: number = 1;\n');

  // The compiler is found at repo/node_modules; link the real one rather than installing.
  const linked = junction(path.join(repo, 'node_modules'), path.join(REPO, 'node_modules'));

  const busRoot = path.join(dir, 'bus');
  const mailboxDir = path.join(busRoot, '.ai-bus', 'runtime', 'mailbox');
  await fsp.mkdir(mailboxDir, { recursive: true });
  await fsp.writeFile(path.join(mailboxDir, 'state.json'),
    JSON.stringify({ claims: { claude: [{ path: 'src' }, { path: 'tsconfig.json' }] } }));

  return { dir, repo, busRoot, linked };
}

function runGuard(repo, busRoot) {
  try {
    const stdout = execFileSync(process.execPath, [GUARD, '--repo', repo, '--seat', 'claude', '--root', busRoot],
      { cwd: repo, encoding: 'utf8', stdio: 'pipe' });
    return { code: 0, out: stdout };
  } catch (error) {
    return { code: error.status ?? 1, out: `${error.stdout || ''}${error.stderr || ''}` };
  }
}

// ---------------------------------------------------------------------------
// ITEM 15. Materialising the index was right; everything around it consulted the WORKING TREE
// about a question only the INDEX can answer.
// ---------------------------------------------------------------------------

test('ITEM 15 GREEN CONTROL: an honest commit still passes, or the guard gets bypassed', async (t) => {
  const { repo, busRoot, linked } = await fixtureRepo(t);
  if (!linked) return t.skip('could not link node_modules');
  git(repo, 'add', '-A');
  const result = runGuard(repo, busRoot);
  assert.equal(result.code, 0, `an honest commit must pass, got: ${result.out}`);
  assert.match(result.out, /compile OK \(staged index\)/);
});

test('ITEM 15 RED: hiding the worktree tsconfig no longer skips the check', async (t) => {
  const { repo, busRoot, linked } = await fixtureRepo(t);
  if (!linked) return t.skip('could not link node_modules');
  // Stage a type error, then rename the tsconfig away. The INDEX still holds both.
  await fsp.writeFile(path.join(repo, 'src', 'index.ts'), 'export const broken: number = "no";\n');
  git(repo, 'add', '-A');
  await fsp.rename(path.join(repo, 'tsconfig.json'), path.join(repo, 'tsconfig.hidden.json'));

  const result = runGuard(repo, busRoot);
  assert.equal(result.code, 1, `must REFUSE; got exit ${result.code}: ${result.out}`);
  assert.doesNotMatch(result.out, /SKIPPED/, 'REGRESSION: a hidden worktree tsconfig skipped the check');
});

test('ITEM 15 RED: a narrow worktree tsconfig cannot shrink what the index compiles', async (t) => {
  const { repo, busRoot, linked } = await fixtureRepo(t);
  if (!linked) return t.skip('could not link node_modules');
  await fsp.writeFile(path.join(repo, 'src', 'index.ts'), 'export const broken: number = "no";\n');
  git(repo, 'add', '-A');
  // The staged tsconfig covers src/. The WORKTREE one now covers only the good file.
  await fsp.writeFile(path.join(repo, 'tsconfig.json'), JSON.stringify({
    compilerOptions: { strict: true, noEmit: true, skipLibCheck: true, types: [] },
    include: ['src/ok.ts']
  }, null, 2));

  const result = runGuard(repo, busRoot);
  assert.equal(result.code, 1, `must REFUSE; got exit ${result.code}: ${result.out}`);
  assert.match(result.out, /does not compile/);
});

test('ITEM 15 RED: a staged tsconfig that does not parse cannot hide behind a good one', async (t) => {
  const { repo, busRoot, linked } = await fixtureRepo(t);
  if (!linked) return t.skip('could not link node_modules');
  await fsp.writeFile(path.join(repo, 'tsconfig.json'), '{ this is not json');
  git(repo, 'add', '-A');
  // Restore a valid tsconfig in the worktree only.
  await fsp.writeFile(path.join(repo, 'tsconfig.json'), JSON.stringify({
    compilerOptions: { strict: true, noEmit: true, skipLibCheck: true, types: [] }, include: ['src']
  }, null, 2));

  const result = runGuard(repo, busRoot);
  assert.equal(result.code, 1, `must REFUSE; got exit ${result.code}: ${result.out}`);
});

test('ITEM 15 RED: a missing compiler refuses rather than exiting 0', async (t) => {
  const { repo, busRoot, linked } = await fixtureRepo(t);
  if (!linked) return t.skip('could not link node_modules');
  await fsp.writeFile(path.join(repo, 'src', 'index.ts'), 'export const broken: number = "no";\n');
  git(repo, 'add', '-A');
  // Remove the compiler entirely. "No compiler" is not a broken build - but it is not a
  // VERIFIED one either, and the guard used to print the same silence for both.
  await fsp.rm(path.join(repo, 'node_modules'), { recursive: true, force: true, maxRetries: 8 });

  const result = runGuard(repo, busRoot);
  assert.equal(result.code, 1, `must REFUSE; got exit ${result.code}: ${result.out}`);
  assert.match(result.out, /npm install/, 'and it must say how to satisfy it, or it gets bypassed');
});

test('ITEM 15: the escape hatch still works, because an unsatisfiable guard gets bypassed', async (t) => {
  const { repo, busRoot, linked } = await fixtureRepo(t);
  if (!linked) return t.skip('could not link node_modules');
  await fsp.writeFile(path.join(repo, 'src', 'index.ts'), 'export const broken: number = "no";\n');
  git(repo, 'add', '-A');

  let result;
  try {
    const out = execFileSync(process.execPath, [GUARD, '--repo', repo, '--seat', 'claude', '--root', busRoot],
      { cwd: repo, encoding: 'utf8', stdio: 'pipe', env: { ...process.env, BUS_ALLOW_BROKEN_BUILD: '1' } });
    result = { code: 0, out };
  } catch (error) {
    result = { code: error.status ?? 1, out: `${error.stdout || ''}${error.stderr || ''}` };
  }
  assert.equal(result.code, 0, 'the deliberate, logged override must still pass');
  assert.match(result.out, /SKIPPED/, 'and it must be loud about it');
});

// ---------------------------------------------------------------------------
// ITEM 13. Round 1 refused a claim whose identity EQUALS a claim root. grok walked around it
// twice. The rule is now positive - a claim must resolve STRICTLY UNDER a claim root - so
// there is no edge left to step over.
// ---------------------------------------------------------------------------

async function claimFixture(t) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'pab-i13b-'));
  t.after(() => fsp.rm(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 }).catch(() => {}));
  const workspace = path.join(dir, 'ws');
  await fsp.mkdir(path.join(workspace, 'src'), { recursive: true });
  await fsp.writeFile(path.join(workspace, 'src', 'bus.ts'), 'x');
  const busRoot = path.join(dir, 'bus');
  await fsp.mkdir(busRoot, { recursive: true });
  const store = new MailboxStore(busRoot);
  await store.ensureInitialized(['claude', 'codex'], 500);
  return { dir, workspace, busRoot, store };
}

test('ITEM 13 RED: a junction to the root PARENT is refused - one directory up is still everything', async (t) => {
  const { dir, workspace, store } = await claimFixture(t);
  if (process.platform !== 'win32' || !junction(path.join(workspace, 'above'), dir)) {
    return t.skip('directory junctions unavailable');
  }
  await assert.rejects(
    () => store.claim({ agent: 'codex', paths: ['above'], why: 'the parent of the tree', repoRoot: workspace }),
    /whole repositor|too broad/i,
    'a claim resolving ABOVE the root contains it, and blocks every seat just as completely'
  );
  // The attack was aiming at locking out other seats. It did not.
  assert.ok(await store.claim({ agent: 'claude', paths: ['src/bus.ts'], why: 'still free', repoRoot: workspace }));
});

test('ITEM 13 RED: a junction to a FOREIGN tree is refused - it is under no root at all', async (t) => {
  const { dir, workspace, store } = await claimFixture(t);
  const foreign = path.join(dir, 'someone-elses-repo');
  await fsp.mkdir(path.join(foreign, 'deep'), { recursive: true });
  await fsp.writeFile(path.join(foreign, 'deep', 'file.ts'), 'x');
  if (process.platform !== 'win32' || !junction(path.join(workspace, 'otherrepo'), foreign)) {
    return t.skip('directory junctions unavailable');
  }
  await assert.rejects(
    () => store.claim({ agent: 'codex', paths: ['otherrepo'], why: 'a whole unrelated tree', repoRoot: workspace }),
    /whole repositor|too broad/i,
    'a claim must land UNDER a claim root; a foreign tree is under none of them'
  );
});

test('ITEM 13 RED: a claim root that does not exist refuses rather than silently dropping out', async (t) => {
  const { workspace, store } = await claimFixture(t);
  // Under the old code a missing repoRoot vanished from the comparison and took the
  // containment rule with it - which is how the foreign-tree attack got in.
  await assert.rejects(
    () => store.claim({
      agent: 'codex', paths: ['src/bus.ts'], why: 'misconfigured',
      repoRoot: path.join(workspace, 'does-not-exist')
    }),
    /claim root does not exist/,
    'a misconfigured root is not a licence'
  );
});

// ---------------------------------------------------------------------------
// ITEM 10. Round 1 made recall follow the baton by falling back to the checkpoint when the
// ADDRESS did not match, leaving the address as an authority. grok went around it three ways,
// all through the address. The rule is now: an open checkpoint for that seat, or nothing.
// ---------------------------------------------------------------------------

async function recallFixture(t) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'pab-i10c-'));
  t.after(() => fsp.rm(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 }).catch(() => {}));
  const store = new MailboxStore(dir);
  await store.ensureInitialized(['claude', 'grok', 'codex'], 500);
  const source = await store.send({
    from: 'claude', to: 'grok', kind: 'task',
    subject: 'ITEM 2 consolidation', body: 'PATHS: src/evidence.ts\nGATES: invalidate must not orphan.'
  });
  await store.openRecovery('grok', source.seq, 'started');
  return { store, source };
}

test('ITEM 10 RED: the PREDECESSOR stops recalling work the baton took away', async (t) => {
  const { store, source } = await recallFixture(t);
  assert.ok(await store.recallAssignment('grok', source.seq), 'grok holds it to begin with');

  const moved = await store.reassignBaton({ to: 'codex', reason: 'grok went dark', force: true });
  assert.equal(moved.inheritedWorkId, source.seq, 'the fixture must really move the work');

  assert.ok(await store.recallAssignment('codex', source.seq), 'the successor recalls it');
  assert.equal(await store.recallAssignment('grok', source.seq), undefined,
    'REGRESSION: the seat that LOST the work still received the brief, because message.to still named it');
});

test('ITEM 10 RED: an addressee with every checkpoint closed recalls nothing', async (t) => {
  const { store, source } = await recallFixture(t);
  await store.operatorCloseRecovery('grok', source.seq, 'instruction withdrawn');
  // item10-recall.test.js appeared to cover this, but it only proved the RUNNER declines to
  // ask. This asks the store directly, which is what any other caller does.
  assert.equal(await store.recallAssignment('grok', source.seq), undefined,
    'a closed checkpoint must revoke recall at the STORE, not merely in the runner');
});

test('ITEM 10 RED: an addressee that closed its OWN checkpoint recalls nothing', async (t) => {
  const { store, source } = await recallFixture(t);
  await store.closeRecovery('grok', source.seq, 'finished');
  assert.equal(await store.recallAssignment('grok', source.seq), undefined,
    'self-closing is still closing; the address must not resurrect the brief');
});

test('ITEM 10 RED: the predecessor cannot re-open a checkpoint on work that moved', async (t) => {
  const { store, source } = await recallFixture(t);
  await store.reassignBaton({ to: 'codex', reason: 'grok went dark', force: true });
  await assert.rejects(
    () => store.openRecovery('grok', source.seq, 're-opening what I lost'),
    /held by codex/,
    'one assignment, one holder - two open checkpoints hand the brief to two seats at once'
  );
  assert.equal(await store.recallAssignment('grok', source.seq), undefined);
});

test('ITEM 10 GREEN CONTROL: the holder keeps recalling across ordinary wakes', async (t) => {
  const { store, source } = await recallFixture(t);
  // Without this a fix that revoked everything would look identical to a correct one.
  const brief = await store.recallAssignment('grok', source.seq);
  assert.match(brief, /PATHS: src\/evidence\.ts/);
  assert.match(brief, /GATES: invalidate must not orphan/, 'the gates come back, not just the subject');
  assert.ok(await store.recallAssignment('grok', source.seq), 'and again on the next wake');
});

// ---------------------------------------------------------------------------
// ITEM 18. Round 1 wired nine caller surfaces and stopped one layer short of the one that
// gates the model, then left the two retract verbs disagreeing about what is legal.
// ---------------------------------------------------------------------------

const { PLAN_SCHEMA, buildDefaultSystem } = require('../dist/brain/brains/agent.js');

test('ITEM 18 RED: the constrained-decoding schema lets a seat emit an atomic retract', () => {
  // A field absent here cannot be emitted however well the tool surfaces are wired - the
  // schema is upstream of all of them.
  const props = PLAN_SCHEMA?.properties?.actions?.items?.properties
    ?? PLAN_SCHEMA?.properties?.actions?.items?.oneOf?.[0]?.properties;
  assert.ok(props, 'the plan schema must expose action properties for this gate to mean anything');
  assert.ok(props.supersedes, 'REGRESSION: a schema-constrained seat cannot emit supersedes');
  assert.ok(props.supersedeReason);
});

test('ITEM 18 RED: the system prompt describes the atomic retract, not only the two-step', () => {
  const system = buildDefaultSystem('claude');
  const text = Array.isArray(system) ? system.join('\n') : String(system);
  assert.match(text, /supersedes/,
    'REGRESSION: a seat told only about two-step supersede will use the two-step window');
  assert.match(text, /one step|ONE step/i, 'and it must say why to prefer it');
});

test('ITEM 18 RED: an atomic retract cannot be redirected to a different recipient', async (t) => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'pab-i18x-'));
  t.after(() => fsp.rm(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 }).catch(() => {}));
  const store = new MailboxStore(dir);
  await store.ensureInitialized(['claude', 'grok', 'codex'], 500);

  const toGrok = await store.send({ from: 'claude', to: 'grok', kind: 'task', subject: 'do X', body: 'X' });
  await assert.rejects(
    () => store.send({
      from: 'claude', to: 'codex', kind: 'task', subject: 'replacement', body: 'Y', supersedes: toGrok.seq
    }),
    /sent to grok, not codex/,
    'this retracted grok\'s brief and gave the replacement to codex - grok lost the work silently'
  );
  // Nothing was sent, so grok's original is untouched and still deliverable.
  const inbox = await store.inbox('grok');
  assert.equal(inbox.length, 1);
  assert.equal(inbox[0].seq, toGrok.seq);
});

test('ITEM 18 RED: the two-step verb cannot retract mail the recipient already read', async (t) => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'pab-i18y-'));
  t.after(() => fsp.rm(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 }).catch(() => {}));
  const store = new MailboxStore(dir);
  await store.ensureInitialized(['claude', 'grok'], 500);

  const original = await store.send({ from: 'claude', to: 'grok', kind: 'task', subject: 'do X', body: 'X' });
  await store.acknowledge('grok', [original.seq]);
  const replacement = await store.send({ from: 'claude', to: 'grok', kind: 'task', subject: 'do Y', body: 'Y' });

  // The atomic path already refuses this and reports target-consumed. The old verb did it
  // anyway, so which verb you used decided what was legal.
  await assert.rejects(
    () => store.supersedeMessage(original.seq, replacement.seq, 'changed my mind', 'claude'),
    /already read it/,
    'you cannot retract an instruction that was already acted on'
  );
});

test('ITEM 18: an atomic supersession records WHEN, as the two-step always did', async (t) => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'pab-i18z-'));
  t.after(() => fsp.rm(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 }).catch(() => {}));
  const store = new MailboxStore(dir);
  await store.ensureInitialized(['claude', 'grok'], 500);

  const original = await store.send({ from: 'claude', to: 'grok', kind: 'task', subject: 'stale', body: 'old' });
  const correction = await store.send({
    from: 'claude', to: 'grok', kind: 'task', subject: 'fresh', body: 'new',
    supersedes: original.seq, supersedeReason: 'settled already'
  });
  assert.equal(correction.superseded, true);

  const raw = JSON.parse(await fsp.readFile(await findMessageFile(dir, original.seq), 'utf8'));
  assert.equal(raw.supersededBy, correction.seq);
  assert.ok(raw.supersededAt, 'history must say when it stopped being current');
  assert.equal(raw.supersedeReason, 'settled already');
});

async function findMessageFile(root, seq) {
  const dir = path.join(root, '.ai-bus', 'runtime', 'mailbox', 'inbox');
  const names = await fsp.readdir(dir);
  const match = names.find((name) => name.startsWith(`${String(seq).padStart(6, '0')}-`) || name.includes(`${seq}-`));
  assert.ok(match, `no message file for #${seq} among ${names.join(', ')}`);
  return path.join(dir, match);
}

test('ITEM 13 GREEN CONTROL: ordinary claims below the root still succeed', async (t) => {
  const { workspace, store } = await claimFixture(t);
  // Without this, a fix that refused everything would look identical to a correct one.
  assert.ok(await store.claim({ agent: 'claude', paths: ['src'], why: 'a directory below the root' , repoRoot: workspace }));
  await store.release('claude');
  assert.ok(await store.claim({ agent: 'claude', paths: ['src/bus.ts'], why: 'a file below the root', repoRoot: workspace }));
});
