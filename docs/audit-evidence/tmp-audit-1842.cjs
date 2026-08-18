'use strict';
/**
 * Live attacks against the five fixes in 0472056 / 6480d81.
 * Does not touch src/ or tests/.
 */
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { MailboxStore } = require('./dist/mailbox.js');
const { cliBusClient } = require('./dist/brain/bus-client.js');
const { PLAN_SCHEMA } = require('./dist/brain/brains/agent.js');

const results = [];
function rec(item, name, status, detail) {
  results.push({ item, name, status, detail });
  console.log(`[${status}] item ${item} / ${name}: ${detail}`);
}

function junctionsAvailable(link, target) {
  try {
    execFileSync('cmd.exe', ['/c', 'mklink', '/J', link, target], { stdio: 'pipe' });
    return true;
  } catch (error) {
    console.log('junction failed:', error.message.split('\n')[0]);
    return false;
  }
}

async function withStore(prefix, seats = ['claude', 'grok', 'codex']) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), prefix));
  const store = new MailboxStore(root);
  await store.ensureInitialized(seats, 500);
  return { store, root, cleanup: () => fsp.rm(root, { recursive: true, force: true, maxRetries: 8 }) };
}

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

// ---------------------------------------------------------------------------
// ITEM 7
// ---------------------------------------------------------------------------
async function item7() {
  const calls = [];
  const tools = cliBusClient({
    root: 'C:/nowhere',
    async callSeatTool(_options, name, input) {
      calls.push({ name, input });
      return { ok: true };
    }
  }).tools('grok');

  const empty = await tools.claim(['src/mailbox.ts'], '');
  rec(7, 'empty-why-refused', calls.length === 0 && empty && typeof empty.refused === 'string' ? 'PASS' : 'FAIL',
    calls.length === 0 ? `refused=${JSON.stringify(empty)}` : `leaked to wire: ${JSON.stringify(calls[0])}`);

  const missing = await tools.claim(['src/mailbox.ts']);
  rec(7, 'missing-why-refused', calls.length === 0 && missing && typeof missing.refused === 'string' ? 'PASS' : 'FAIL',
    `refused=${JSON.stringify(missing)}`);

  rec(7, 'no-unstated-invention',
    !JSON.stringify({ empty, missing }).includes('unstated') ? 'PASS' : 'FAIL',
    'unstated must not be invented');

  await tools.claim(['src/mailbox.ts'], 'real why');
  rec(7, 'real-why-forwarded',
    calls.length === 1 && calls[0].input.why === 'real why' ? 'PASS' : 'FAIL',
    `calls=${JSON.stringify(calls)}`);

  const vscodeSrc = fs.readFileSync(path.join(__dirname, 'src', 'vscode-lm-worker.ts'), 'utf8');
  rec(7, 'vscode-why-schema',
    /mailbox_claim[\s\S]*?required: \[[^\]]*why/.test(vscodeSrc) ? 'PASS' : 'NOTE',
    'vscode mailbox_claim schema does not list why as required; store still refuses');
}

// ---------------------------------------------------------------------------
// ITEM 13
// ---------------------------------------------------------------------------
async function item13() {
  const { store, root, cleanup } = await withStore('pab-1842-13-');
  const extras = [];
  try {
    await fsp.mkdir(path.join(root, 'src'), { recursive: true });
    await fsp.writeFile(path.join(root, 'src', 'bus.ts'), 'x');

    for (const spelling of ['src/..', 'src/../.', './', '.', 'src/foo/../..']) {
      try {
        await store.claim({ agent: 'codex', paths: [spelling], why: `spelling ${spelling}` });
        rec(13, `spelling:${spelling}`, 'FAIL', 'accepted as a claim');
      } catch (error) {
        rec(13, `spelling:${spelling}`,
          /whole repositor|too broad|escapes|workspace-relative/i.test(error.message) ? 'PASS' : 'FAIL',
          error.message);
      }
    }

    const everything = path.join(root, 'everything');
    if (process.platform === 'win32' && junctionsAvailable(everything, root)) {
      try {
        await store.claim({ agent: 'codex', paths: ['everything'], why: 'junction to bus root' });
        rec(13, 'junction-to-bus-root', 'FAIL', 'accepted');
      } catch (error) {
        rec(13, 'junction-to-bus-root', /whole repositor|too broad/i.test(error.message) ? 'PASS' : 'FAIL', error.message);
      }
      for (const spelling of ['everything/.', './everything', 'everything/']) {
        try {
          await store.claim({ agent: 'codex', paths: [spelling], why: spelling });
          rec(13, `spelling:${spelling}`, 'FAIL', 'accepted');
        } catch (error) {
          rec(13, `spelling:${spelling}`,
            /whole repositor|too broad/i.test(error.message) ? 'PASS' : 'FAIL',
            error.message);
        }
      }
      // Nested junction: src/alias -> root
      const nested = path.join(root, 'src', 'alias');
      if (junctionsAvailable(nested, root)) {
        try {
          await store.claim({ agent: 'codex', paths: ['src/alias'], why: 'nested junction to root' });
          rec(13, 'nested-junction-to-root', 'FAIL', 'src/alias -> root was accepted');
        } catch (error) {
          rec(13, 'nested-junction-to-root', /whole repositor|too broad/i.test(error.message) ? 'PASS' : 'FAIL', error.message);
        }
      }
    } else {
      rec(13, 'junction-to-bus-root', 'SKIP', 'junctions unavailable');
    }

    const repo = await fsp.mkdtemp(path.join(os.tmpdir(), 'pab-1842-13repo-'));
    extras.push(repo);
    await fsp.mkdir(path.join(repo, 'src'), { recursive: true });
    await fsp.writeFile(path.join(repo, 'src', 'bus.ts'), 'x');

    const busAlias = path.join(repo, 'busroot');
    if (process.platform === 'win32' && junctionsAvailable(busAlias, root)) {
      try {
        await store.claim({ agent: 'grok', paths: ['busroot'], why: 'path is the BUS root', repoRoot: repo });
        rec(13, 'path-is-bus-root-not-repo', 'FAIL', 'junction to BUS root accepted when claiming under repoRoot');
      } catch (error) {
        rec(13, 'path-is-bus-root-not-repo', /whole repositor|too broad/i.test(error.message) ? 'PASS' : 'FAIL', error.message);
      }
    } else {
      rec(13, 'path-is-bus-root-not-repo', 'SKIP', 'junctions unavailable');
    }

    const repoEverything = path.join(repo, 'everything');
    if (process.platform === 'win32' && junctionsAvailable(repoEverything, repo)) {
      try {
        await store.claim({ agent: 'grok', paths: ['everything'], why: 'junction to repo root', repoRoot: repo });
        rec(13, 'junction-to-repo-root', 'FAIL', 'junction to repoRoot accepted');
      } catch (error) {
        rec(13, 'junction-to-repo-root', /whole repositor|too broad/i.test(error.message) ? 'PASS' : 'FAIL', error.message);
      }
    } else {
      rec(13, 'junction-to-repo-root', 'SKIP', 'junctions unavailable');
    }

    // Missing repoRoot is skipped. A junction from the bus to that intended tree is then
    // compared only against the bus identity, so a whole foreign tree can be claimed.
    const ghost = path.join(os.tmpdir(), 'pab-ghost-' + Date.now());
    const intended = await fsp.mkdtemp(path.join(os.tmpdir(), 'pab-1842-intended-'));
    extras.push(intended);
    await fsp.writeFile(path.join(intended, 'readme.txt'), 'x');
    const aliasToIntended = path.join(root, 'otherrepo');
    if (process.platform === 'win32' && junctionsAvailable(aliasToIntended, intended)) {
      try {
        const held = await store.claim({
          agent: 'claude',
          paths: ['otherrepo'],
          why: 'ghost repoRoot',
          repoRoot: ghost
        });
        rec(13, 'missing-repoRoot-foreign-tree', 'FAIL',
          `accepted a claim whose realpath is an entire other tree because repoRoot did not exist and was skipped. held=${held.map((c) => c.path).join(',')}`);
      } catch (error) {
        rec(13, 'missing-repoRoot-foreign-tree', /whole repositor|too broad/i.test(error.message) ? 'PASS' : 'NOTE',
          error.message);
      }
    } else {
      rec(13, 'missing-repoRoot-foreign-tree', 'SKIP', 'junctions unavailable');
    }

    const busAgain = path.join(root, 'busagain');
    if (process.platform === 'win32' && junctionsAvailable(busAgain, root)) {
      try {
        await store.claim({ agent: 'codex', paths: ['busagain'], why: 'ghost but bus', repoRoot: ghost });
        rec(13, 'missing-repoRoot-still-checks-bus', 'FAIL', 'bus-root junction got through because repoRoot was missing');
      } catch (error) {
        rec(13, 'missing-repoRoot-still-checks-bus', /whole repositor|too broad/i.test(error.message) ? 'PASS' : 'FAIL', error.message);
      }
    } else {
      rec(13, 'missing-repoRoot-still-checks-bus', 'SKIP', 'junctions unavailable');
    }

    // Parent-of-root junction: identity is not a claim root. Does overlap then lock the tree?
    const sandbox = await fsp.mkdtemp(path.join(os.tmpdir(), 'pab-1842-sandbox-'));
    extras.push(sandbox);
    const nestedRoot = path.join(sandbox, 'ws');
    await fsp.mkdir(path.join(nestedRoot, 'src'), { recursive: true });
    await fsp.writeFile(path.join(nestedRoot, 'src', 'bus.ts'), 'x');
    const nestedStore = new MailboxStore(nestedRoot);
    await nestedStore.ensureInitialized(['claude', 'grok', 'codex'], 500);
    const above = path.join(nestedRoot, 'above');
    if (process.platform === 'win32' && junctionsAvailable(above, sandbox)) {
      try {
        const held = await nestedStore.claim({ agent: 'codex', paths: ['above'], why: 'parent of the claim root' });
        try {
          await nestedStore.claim({ agent: 'grok', paths: ['src/bus.ts'], why: 'should still be free' });
          rec(13, 'parent-of-root-junction', 'NOTE',
            `accepted (${held.map((c) => c.path)}) but did not lock src/bus.ts`);
        } catch (error) {
          rec(13, 'parent-of-root-junction', 'FAIL',
            `parent-of-root junction accepted and blocked src/bus.ts: ${error.message}`);
        }
      } catch (error) {
        rec(13, 'parent-of-root-junction', /whole repositor|too broad|escapes/i.test(error.message) ? 'PASS' : 'FAIL',
          error.message);
      }
    } else {
      rec(13, 'parent-of-root-junction', 'SKIP', 'junctions unavailable');
    }

    // Green control
    try {
      const below = await store.claim({ agent: 'grok', paths: ['src'], why: 'below root' });
      rec(13, 'below-root-still-legal', below && below.length ? 'PASS' : 'FAIL', JSON.stringify(below));
    } catch (error) {
      rec(13, 'below-root-still-legal', 'FAIL', error.message);
    }
  } finally {
    await cleanup();
    for (const extra of extras) {
      await fsp.rm(extra, { recursive: true, force: true, maxRetries: 8 }).catch(() => undefined);
    }
  }
}

// ---------------------------------------------------------------------------
// ITEM 10
// ---------------------------------------------------------------------------
async function item10() {
  const { store, cleanup } = await withStore('pab-1842-10-');
  try {
    const source = await store.send({
      from: 'claude', to: 'grok', kind: 'task',
      subject: 'secret brief', body: 'PATHS: src/harness.ts\nGATES: do not leak this'
    });
    await store.openRecovery('grok', source.seq, 'started');

    const moved = await store.reassignBaton({ to: 'codex', reason: 'grok went dark', force: true });
    rec(10, 'baton-moved', moved.moved === true && moved.inheritedWorkId === source.seq ? 'PASS' : 'FAIL',
      JSON.stringify(moved));

    const successor = await store.recallAssignment('codex', source.seq);
    rec(10, 'successor-after-baton', successor ? 'PASS' : 'FAIL',
      successor ? 'inheritor can recall' : 'inheritor still cannot recall');

    const predecessor = await store.recallAssignment('grok', source.seq);
    rec(10, 'predecessor-after-baton', predecessor ? 'FAIL' : 'PASS',
      predecessor
        ? 'PREDECESSOR still recalls after reassignBaton — message.to short-circuits the checkpoint check'
        : 'predecessor correctly recalls nothing');

    const uninvolved = await store.recallAssignment('claude', source.seq);
    rec(10, 'uninvolved-after-baton', uninvolved ? 'FAIL' : 'PASS',
      uninvolved ? 'uninvolved seat recalled' : 'uninvolved seat recalls nothing');

    await store.operatorCloseRecovery('codex', source.seq, 'withdrawn');
    const afterCloseSuccessor = await store.recallAssignment('codex', source.seq);
    rec(10, 'closed-checkpoint-non-addressee', afterCloseSuccessor ? 'FAIL' : 'PASS',
      afterCloseSuccessor
        ? 'non-addressee recalled via a CLOSED checkpoint'
        : 'closed checkpoint on non-addressee recalls nothing');

    const afterCloseAddressee = await store.recallAssignment('grok', source.seq);
    rec(10, 'closed-checkpoint-addressee', afterCloseAddressee ? 'FAIL' : 'PASS',
      afterCloseAddressee
        ? 'ADDRESSEE recalled after every checkpoint was closed — address still grants recall'
        : 'addressee with no open checkpoint recalls nothing');

    try {
      await store.openRecovery('grok', source.seq, 'I am taking it back');
      rec(10, 'addressee-reopen-after-inherit', 'FAIL',
        'addressee can openRecovery after losing the baton because source.to still matches');
    } catch (error) {
      rec(10, 'addressee-reopen-after-inherit', 'PASS', `openRecovery refused: ${error.message}`);
    }

    const consumed = await store.send({
      from: 'claude', to: 'grok', kind: 'task', subject: 'consumed', body: 'do the thing'
    });
    await store.openRecovery('grok', consumed.seq, 'working');
    await store.closeRecovery('grok', consumed.seq, 'settled');
    const afterOwnClose = await store.recallAssignment('grok', consumed.seq);
    rec(10, 'addressee-after-own-close', afterOwnClose ? 'FAIL' : 'PASS',
      afterOwnClose
        ? 'recallAssignment still returns the brief after closeRecovery; item10-recall.test.js "no open checkpoint, no recall" is only the runner'
        : 'store refuses addressee recall after close');

    // Stale open checkpoint: addressee still has an OPEN checkpoint after a second seat
    // somehow also has one? inherit closes the first. Directly inspect a leftover open
    // checkpoint that is not the current baton holder — reopen is the path above.
  } finally {
    await cleanup();
  }
}

// ---------------------------------------------------------------------------
// ITEM 18
// ---------------------------------------------------------------------------
async function item18() {
  const { store, root, cleanup } = await withStore('pab-1842-18-');
  try {
    const original = await store.send({
      from: 'claude', to: 'grok', kind: 'task', subject: 'stale', body: 'old instruction'
    });
    const atomic = await store.send({
      from: 'claude', to: 'grok', kind: 'task', subject: 'correction', body: 'new instruction',
      supersedes: original.seq, supersedeReason: 'settled'
    });

    const inbox = await store.inbox('grok');
    rec(18, 'atomic-removes-from-inbox', inbox.some((m) => m.seq === original.seq) ? 'FAIL' : 'PASS',
      `inbox=${inbox.map((m) => `${m.seq}:${m.subject}`).join(',')}`);
    rec(18, 'atomic-sets-superseded-on-new', atomic.superseded === true ? 'PASS' : 'FAIL',
      `superseded=${atomic.superseded} outcome=${atomic.supersedeOutcome}`);

    const inboxDir = path.join(root, '.ai-bus', 'runtime', 'mailbox', 'inbox');
    let origRow;
    for (const name of await fsp.readdir(inboxDir)) {
      const row = JSON.parse(await fsp.readFile(path.join(inboxDir, name), 'utf8'));
      if (row.seq === original.seq) origRow = row;
    }
    rec(18, 'atomic-sets-supersededAt', origRow?.supersededAt ? 'PASS' : 'FAIL',
      origRow
        ? `supersededBy=${origRow.supersededBy} supersededAt=${origRow.supersededAt ?? '<MISSING>'}`
        : 'original row missing');

    const a = await store.send({ from: 'claude', to: 'grok', kind: 'task', subject: 'A', body: 'first' });
    const b = await store.send({ from: 'claude', to: 'grok', kind: 'task', subject: 'B', body: 'second' });
    const midInbox = await store.inbox('grok');
    const bothLive = midInbox.some((m) => m.seq === a.seq) && midInbox.some((m) => m.seq === b.seq);
    rec(18, 'two-step-window-still-exists', bothLive ? 'NOTE' : 'NOTE',
      bothLive ? 'two-step still has the dual-live window (why atomic exists)' : 'window unexpectedly gone');

    const superseded = await store.supersedeMessage(a.seq, b.seq, 'settled', 'claude');
    rec(18, 'two-step-sets-supersededAt', superseded.supersededAt ? 'NOTE' : 'FAIL',
      `two-step supersededAt=${superseded.supersededAt ?? '<missing>'}`);

    const readTarget = await store.send({ from: 'claude', to: 'codex', kind: 'task', subject: 'readme', body: 'act' });
    await store.acknowledge('codex', [readTarget.seq]);
    const lateAtomic = await store.send({
      from: 'claude', to: 'codex', kind: 'task', subject: 'too late', body: 'correction',
      supersedes: readTarget.seq, supersedeReason: 'late'
    });
    rec(18, 'atomic-consumed-does-not-retract', lateAtomic.supersedeOutcome === 'target-consumed' ? 'PASS' : 'FAIL',
      `outcome=${lateAtomic.supersedeOutcome} superseded=${lateAtomic.superseded}`);

    try {
      const twoStepOnRead = await store.supersedeMessage(readTarget.seq, lateAtomic.seq, 'late-two-step', 'claude');
      rec(18, 'two-step-on-consumed', 'FAIL',
        `two-step STILL retracts an already-read target (supersededBy=${twoStepOnRead.supersededBy}). Atomic does not.`);
    } catch (error) {
      rec(18, 'two-step-on-consumed', 'PASS', `two-step also refused: ${error.message}`);
    }

    const toGrok = await store.send({ from: 'claude', to: 'grok', kind: 'task', subject: 'for grok', body: 'g' });
    try {
      const redirected = await store.send({
        from: 'claude', to: 'codex', kind: 'task', subject: 'now for codex', body: 'c',
        supersedes: toGrok.seq, supersedeReason: 'redirect'
      });
      const grokInbox = await store.inbox('grok');
      const stillInGrok = grokInbox.some((m) => m.seq === toGrok.seq);
      rec(18, 'atomic-cross-recipient', stillInGrok ? 'PASS' : 'FAIL',
        stillInGrok
          ? 'replacement sent but original stayed in grok inbox?'
          : `atomic retracted a grok-addressed message by sending a replacement to codex (#${redirected.seq}). two-step requires the same recipient.`);
    } catch (error) {
      rec(18, 'atomic-cross-recipient', 'PASS', `refused cross-recipient: ${error.message}`);
    }
  } finally {
    await cleanup();
  }

  const props = PLAN_SCHEMA?.properties?.actions?.items?.properties ?? {};
  rec(18, 'PLAN_SCHEMA-has-supersedes',
    Object.prototype.hasOwnProperty.call(props, 'supersedes') ? 'PASS' : 'FAIL',
    Object.prototype.hasOwnProperty.call(props, 'supersedes')
      ? 'PLAN_SCHEMA lists supersedes'
      : `PLAN_SCHEMA keys=${Object.keys(props).join(',')} — constrained decoding cannot emit atomic retract`);
  rec(18, 'PLAN_SCHEMA-has-supersedeReason',
    Object.prototype.hasOwnProperty.call(props, 'supersedeReason') ? 'PASS' : 'FAIL',
    Object.prototype.hasOwnProperty.call(props, 'supersedeReason')
      ? 'listed'
      : 'PLAN_SCHEMA omits supersedeReason');

  const agentSrc = fs.readFileSync(path.join(__dirname, 'src', 'brain', 'brains', 'agent.ts'), 'utf8');
  rec(18, 'system-prompt-mentions-supersedes',
    /send requires[\s\S]{0,400}supersedes/.test(agentSrc) ? 'PASS' : 'FAIL',
    'system prompt describes send without supersedes');

  rec(18, 'BrainAction-has-fields',
    /supersedes\?: number; supersedeReason\?: string/.test(agentSrc) ? 'PASS' : 'FAIL',
    'BrainAction type');

  rec(18, 'executePlan-forwards',
    /supersedes: action.supersedes/.test(agentSrc) ? 'PASS' : 'FAIL',
    'dispatcher');

  const vscodeSrc = fs.readFileSync(path.join(__dirname, 'src', 'vscode-lm-worker.ts'), 'utf8');
  rec(18, 'vscode-send-forwards',
    /mailbox_send[\s\S]*supersedes: requiredInteger/.test(vscodeSrc) ? 'PASS' : 'FAIL',
    'vscode worker');

  const workerSrc = fs.readFileSync(path.join(__dirname, 'src', 'worker-client.ts'), 'utf8');
  rec(18, 'worker-client-forwards',
    /--supersedes/.test(workerSrc) ? 'PASS' : 'FAIL',
    'worker-client CLI');
}

// ---------------------------------------------------------------------------
// ITEM 15
// ---------------------------------------------------------------------------
function runGuard(repo, root, extraEnv = {}) {
  try {
    const out = execFileSync(process.execPath, [
      path.join(__dirname, 'scripts', 'claim-guard-cli.js'),
      '--repo', repo,
      '--root', root,
      '--seat', 'grok'
    ], { encoding: 'utf8', env: { ...process.env, ...extraEnv } });
    return { code: 0, out };
  } catch (error) {
    return { code: error.status ?? 1, out: `${error.stdout || ''}${error.stderr || ''}` };
  }
}

async function item15() {
  const repo = await fsp.mkdtemp(path.join(os.tmpdir(), 'pab-1842-15-'));
  try {
    git(repo, ['init']);
    git(repo, ['config', 'user.email', 'audit@example.com']);
    git(repo, ['config', 'user.name', 'audit']);
    await fsp.mkdir(path.join(repo, 'src'), { recursive: true });
    await fsp.writeFile(path.join(repo, 'src', 'index.ts'), 'export const n: number = 1;\n');
    await fsp.writeFile(path.join(repo, 'tsconfig.json'), JSON.stringify({
      compilerOptions: { module: 'commonjs', target: 'ES2022', strict: true, noEmit: true, skipLibCheck: true },
      include: ['src']
    }, null, 2));
    const modules = path.join(__dirname, 'node_modules');
    fs.symlinkSync(modules, path.join(repo, 'node_modules'), 'junction');

    const store = new MailboxStore(repo);
    await store.ensureInitialized(['claude', 'grok', 'codex'], 500);
    await store.claim({ agent: 'grok', paths: ['src'], why: 'item 15 attack' });

    git(repo, ['add', 'src/index.ts', 'tsconfig.json']);
    git(repo, ['commit', '-m', 'good']);

    // Attack A: the original — stage a type error, restore a compiling worktree.
    await fsp.writeFile(path.join(repo, 'src', 'index.ts'), 'export const n: number = "broken";\n');
    git(repo, ['add', 'src/index.ts']);
    await fsp.writeFile(path.join(repo, 'src', 'index.ts'), 'export const n: number = 1;\n');
    const original = runGuard(repo, repo);
    rec(15, 'original-staged-error-good-worktree',
      original.code !== 0 && /REFUSING|does not compile/i.test(original.out) ? 'PASS' : 'FAIL',
      `code=${original.code} out=${original.out.slice(0, 400)}`);

    git(repo, ['reset', '--hard', 'HEAD']);

    // Attack B: hide the worktree tsconfig so the compile check is SKIPPED.
    await fsp.writeFile(path.join(repo, 'src', 'index.ts'), 'export const n: number = "broken";\n');
    git(repo, ['add', 'src/index.ts']);
    await fsp.rename(path.join(repo, 'tsconfig.json'), path.join(repo, 'tsconfig.json.bak'));
    const hidden = runGuard(repo, repo);
    rec(15, 'hide-worktree-tsconfig-skips',
      hidden.code === 0 && /SKIPPED/i.test(hidden.out) ? 'FAIL' : (hidden.code !== 0 ? 'PASS' : 'FAIL'),
      `code=${hidden.code} out=${hidden.out.slice(0, 400)}`);
    await fsp.rename(path.join(repo, 'tsconfig.json.bak'), path.join(repo, 'tsconfig.json'));
    git(repo, ['reset', '--hard', 'HEAD']);

    // Attack C: worktree tsconfig excludes the broken file; index still has the real include.
    await fsp.writeFile(path.join(repo, 'src', 'index.ts'), 'export const n: number = "broken";\n');
    git(repo, ['add', 'src/index.ts']);
    await fsp.writeFile(path.join(repo, 'tsconfig.json'), JSON.stringify({
      compilerOptions: { module: 'commonjs', target: 'ES2022', strict: true, noEmit: true, skipLibCheck: true },
      include: ['src'],
      exclude: ['src/index.ts']
    }, null, 2));
    const excluded = runGuard(repo, repo);
    rec(15, 'worktree-tsconfig-exclude-overwrites-index',
      excluded.code === 0 ? 'FAIL' : 'PASS',
      `code=${excluded.code} out=${excluded.out.slice(0, 400)}`);
    git(repo, ['reset', '--hard', 'HEAD']);

    // Attack D: stage a dummy node_modules so the junction into scratch fails and the
    // guard falls back to the compiling working tree.
    await fsp.writeFile(path.join(repo, 'src', 'index.ts'), 'export const n: number = "broken";\n');
    git(repo, ['add', 'src/index.ts']);
    await fsp.writeFile(path.join(repo, 'src', 'index.ts'), 'export const n: number = 1;\n');
    const dummyNm = path.join(repo, 'nm-dummy');
    await fsp.writeFile(dummyNm, 'not a real node_modules\n');
    git(repo, ['add', '-f', dummyNm]);
    // checkout-index writes every index path. To make scratch/node_modules exist as a
    // FILE (so symlinkSync fails), stage a file literally named node_modules.
    // That would replace our junction in the worktree when we add -f. Do it in a copy?
    // Safer: add a tracked file `node_modules` only in the index via --intent? Can't.
    // Instead: write a file into a nested path that checkout-index creates as node_modules.
    // On Windows we cannot have both a junction node_modules and a staged file node_modules
    // in the same worktree easily. Skip if we cannot stage it without destroying types.
    rec(15, 'stage-node_modules-fallback', 'NOTE',
      'not staged here: adding a tracked node_modules would remove the type junction this probe needs');

    // Attack E: stage a broken tsconfig, leave a good one in the worktree. The guard
    // overwrites the index tsconfig with the worktree copy, so the commit that lands
    // is a project that does not compile.
    await fsp.writeFile(path.join(repo, 'tsconfig.json'), '{ this is not json\n');
    git(repo, ['add', 'tsconfig.json']);
    await fsp.writeFile(path.join(repo, 'tsconfig.json'), JSON.stringify({
      compilerOptions: { module: 'commonjs', target: 'ES2022', strict: true, noEmit: true, skipLibCheck: true },
      include: ['src']
    }, null, 2));
    const stagedBadCfg = runGuard(repo, repo);
    rec(15, 'staged-broken-tsconfig-good-worktree',
      stagedBadCfg.code === 0 ? 'FAIL' : 'PASS',
      `code=${stagedBadCfg.code} out=${stagedBadCfg.out.slice(0, 400)}`);
    git(repo, ['reset', '--hard', 'HEAD']);

    // Attack F: hide local tsc (replace node_modules with a file). The guard treats
    // "no compiler" as skip-and-pass, so a staged type error lands.
    await fsp.writeFile(path.join(repo, 'src', 'index.ts'), 'export const n: number = "broken";\n');
    git(repo, ['add', 'src/index.ts']);
    const nm = path.join(repo, 'node_modules');
    try { fs.unlinkSync(nm); } catch { try { fs.rmSync(nm, { recursive: true, force: true }); } catch { /* keep going */ } }
    await fsp.writeFile(nm, 'not a directory\n');
    const noTsc = runGuard(repo, repo);
    rec(15, 'hide-tsc-skips-compile',
      noTsc.code === 0 && /skipped/i.test(noTsc.out) ? 'FAIL' : (noTsc.code !== 0 ? 'PASS' : 'FAIL'),
      `code=${noTsc.code} out=${noTsc.out.slice(0, 400)}`);
    try { fs.unlinkSync(nm); } catch { /* ignore */ }
    fs.symlinkSync(modules, nm, 'junction');
    git(repo, ['reset', '--hard', 'HEAD']);

    // Attack G: honest compile of the index (control)
    await fsp.writeFile(path.join(repo, 'src', 'index.ts'), 'export const n: number = 2;\n');
    git(repo, ['add', 'src/index.ts']);
    const honest = runGuard(repo, repo);
    rec(15, 'honest-staged-compiles',
      honest.code === 0 && /staged index/i.test(honest.out) ? 'PASS' : 'FAIL',
      `code=${honest.code} out=${honest.out.slice(0, 300)}`);
  } finally {
    await fsp.rm(repo, { recursive: true, force: true, maxRetries: 8 }).catch(() => undefined);
  }
}

(async () => {
  await item7();
  await item13();
  await item10();
  await item18();
  await item15();
  console.log('\n===== SUMMARY =====');
  const fail = results.filter((r) => r.status === 'FAIL');
  const pass = results.filter((r) => r.status === 'PASS');
  const note = results.filter((r) => r.status === 'NOTE' || r.status === 'SKIP');
  console.log(`PASS ${pass.length}  FAIL ${fail.length}  NOTE/SKIP ${note.length}`);
  for (const r of fail) console.log(`  FAIL item ${r.item} ${r.name}: ${r.detail}`);
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
