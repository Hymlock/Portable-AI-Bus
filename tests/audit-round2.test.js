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

test('ITEM 13 GREEN CONTROL: ordinary claims below the root still succeed', async (t) => {
  const { workspace, store } = await claimFixture(t);
  // Without this, a fix that refused everything would look identical to a correct one.
  assert.ok(await store.claim({ agent: 'claude', paths: ['src'], why: 'a directory below the root' , repoRoot: workspace }));
  await store.release('claude');
  assert.ok(await store.claim({ agent: 'claude', paths: ['src/bus.ts'], why: 'a file below the root', repoRoot: workspace }));
});
