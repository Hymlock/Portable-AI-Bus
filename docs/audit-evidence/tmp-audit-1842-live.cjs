'use strict';
/**
 * Live attacks against HEAD for items 13, 10, 18, 15. Read-only vs src/tests.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { MailboxStore } = require('./dist/mailbox.js');

const results = [];
function record(item, name, verdict, detail) {
  results.push({ item, name, verdict, detail });
  console.log(`[${item}] ${verdict.padEnd(4)} ${name}`);
  if (detail) console.log(`       ${detail.split('\n').join('\n       ')}`);
}

function junction(link, target) {
  try {
    execFileSync('cmd.exe', ['/c', 'mklink', '/J', link, target], { stdio: 'pipe' });
    return true;
  } catch (error) {
    return false;
  }
}

async function withStore(prefix, seats = ['claude', 'grok', 'codex']) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), prefix));
  const store = new MailboxStore(root);
  await store.ensureInitialized(seats, 500);
  return { store, root, cleanup: () => fsp.rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 }) };
}

async function attack13() {
  const { store, root, cleanup } = await withStore('pab-a13-');
  try {
    await fsp.mkdir(path.join(root, 'src'), { recursive: true });
    await fsp.writeFile(path.join(root, 'src', 'bus.ts'), 'x');

    // Original attack: junction named everything -> root
    if (!junction(path.join(root, 'everything'), root)) {
      record(13, 'everything-junction', 'SKIP', 'mklink /J unavailable');
    } else {
      try {
        await store.claim({ agent: 'codex', paths: ['everything'], why: 'alias of root' });
        record(13, 'everything-junction', 'FAIL', 'junction to root was ACCEPTED');
        await store.release('codex');
      } catch (error) {
        const msg = String(error && error.message);
        if (/whole repositor|too broad/i.test(msg)) {
          record(13, 'everything-junction', 'PASS', 'refused: ' + msg.split('\n')[0]);
        } else {
          record(13, 'everything-junction', 'FAIL', 'refused for the wrong reason: ' + msg);
        }
      }
    }

    // Nested spelling src/alias -> root
    if (junction(path.join(root, 'src', 'alias'), root)) {
      try {
        await store.claim({ agent: 'codex', paths: ['src/alias'], why: 'nested alias of root' });
        record(13, 'nested-junction-to-root', 'FAIL', 'src/alias -> root was ACCEPTED');
        await store.release('codex');
      } catch (error) {
        const msg = String(error && error.message);
        record(13, 'nested-junction-to-root', /whole repositor|too broad/i.test(msg) ? 'PASS' : 'FAIL', msg.split('\n')[0]);
      }
    }

    // Lexical spellings of the root
    for (const spelling of ['.', 'src/..', 'src/../.', './']) {
      try {
        await store.claim({ agent: 'codex', paths: [spelling], why: 'lexical root' });
        record(13, `lexical:${spelling}`, 'FAIL', 'accepted');
        await store.release('codex');
      } catch (error) {
        const msg = String(error && error.message);
        record(13, `lexical:${JSON.stringify(spelling)}`, /whole repositor|too broad|escapes/i.test(msg) ? 'PASS' : 'FAIL', msg.split('\n')[0]);
      }
    }

    // Path resolving to BUS root via a separate repoRoot
    const repo = await fsp.mkdtemp(path.join(os.tmpdir(), 'pab-a13-repo-'));
    await fsp.mkdir(path.join(repo, 'src'), { recursive: true });
    await fsp.writeFile(path.join(repo, 'src', 'a.ts'), 'x');
    if (junction(path.join(repo, 'tobus'), root)) {
      try {
        await store.claim({ agent: 'codex', paths: ['tobus'], why: 'points at bus root', repoRoot: repo });
        record(13, 'junction-to-bus-root-from-repo', 'FAIL', 'accepted a path that resolves to the BUS root');
        await store.release('codex');
      } catch (error) {
        const msg = String(error && error.message);
        record(13, 'junction-to-bus-root-from-repo', /whole repositor|too broad/i.test(msg) ? 'PASS' : 'FAIL', msg.split('\n')[0]);
      }
    }
    // Missing repoRoot: identity check skips it
    try {
      await store.claim({
        agent: 'codex',
        paths: ['src'],
        why: 'missing repoRoot should still resolve via bus root',
        repoRoot: path.join(root, 'does-not-exist')
      });
      record(13, 'missing-repoRoot-src-still-works', 'PASS', 'src resolved via bus root');
      await store.release('codex');
    } catch (error) {
      record(13, 'missing-repoRoot-src-still-works', 'FAIL', String(error.message).split('\n')[0]);
    }

    // Missing repoRoot + junction to a foreign tree
    const foreign = await fsp.mkdtemp(path.join(os.tmpdir(), 'pab-a13-foreign-'));
    await fsp.mkdir(path.join(foreign, 'secret'), { recursive: true });
    await fsp.writeFile(path.join(foreign, 'secret', 'x.ts'), 'x');
    if (junction(path.join(root, 'otherrepo'), foreign)) {
      try {
        const held = await store.claim({
          agent: 'codex',
          paths: ['otherrepo'],
          why: 'foreign tree via missing repoRoot',
          repoRoot: path.join(root, 'does-not-exist')
        });
        record(13, 'missing-repoRoot-foreign-tree', 'FAIL', `accepted foreign tree claim: ${JSON.stringify(held.map(h => h.path))}`);
        await store.release('codex');
      } catch (error) {
        const msg = String(error && error.message);
        record(13, 'missing-repoRoot-foreign-tree', /whole repositor|too broad|missing/i.test(msg) ? 'PASS' : 'FAIL', msg.split('\n')[0]);
      }
    }
    await fsp.rm(foreign, { recursive: true, force: true }).catch(() => {});

    // Parent-of-root junction
    const sandbox = path.dirname(root);
    if (junction(path.join(root, 'above'), sandbox)) {
      try {
        await store.claim({ agent: 'codex', paths: ['above'], why: 'parent of root' });
        record(13, 'parent-of-root-accepted', 'FAIL', 'junction to parent of root was ACCEPTED (identity is not a claim root)');
        try {
          await store.claim({ agent: 'grok', paths: ['src/bus.ts'], why: 'should be free' });
          record(13, 'parent-of-root-locks-tree', 'PASS', 'accepted above but did NOT lock src/bus.ts');
          await store.release('grok');
        } catch (error) {
          const msg = String(error && error.message);
          record(13, 'parent-of-root-locks-tree', /already holds|conflict/i.test(msg) ? 'FAIL' : 'FAIL', 'src/bus.ts blocked: ' + msg.split('\n')[0]);
        }
        await store.release('codex');
      } catch (error) {
        const msg = String(error && error.message);
        record(13, 'parent-of-root-accepted', /whole repositor|too broad/i.test(msg) ? 'PASS' : 'FAIL', msg.split('\n')[0]);
      }
    }

    // Green control
    try {
      const held = await store.claim({ agent: 'grok', paths: ['src'], why: 'below-root ancestor' });
      record(13, 'green-below-root', held ? 'PASS' : 'FAIL', 'src claim');
      await store.release('grok');
    } catch (error) {
      record(13, 'green-below-root', 'FAIL', String(error.message).split('\n')[0]);
    }

    await fsp.rm(repo, { recursive: true, force: true }).catch(() => {});
  } finally {
    await cleanup();
  }
}

async function attack10() {
  const { store, cleanup } = await withStore('pab-a10-');
  try {
    const source = await store.send({
      from: 'claude', to: 'grok', kind: 'task',
      subject: 'ITEM 18 wiring', body: 'PATHS: src/harness.ts\nGATES: supersedes reaches every surface.'
    });
    await store.openRecovery('grok', source.seq, 'started');

    const moved = await store.reassignBaton({ to: 'codex', reason: 'grok went dark', force: true });
    if (!moved.moved || moved.inheritedWorkId !== source.seq) {
      record(10, 'baton-moved', 'FAIL', JSON.stringify(moved));
      return;
    }
    record(10, 'baton-moved', 'PASS', `inherited ${moved.inheritedWorkId}`);

    const successor = await store.recallAssignment('codex', source.seq);
    record(10, 'successor-recalls', successor ? 'PASS' : 'FAIL', successor ? 'codex got the brief' : 'codex got nothing');

    const uninvolved = await store.recallAssignment('claude', source.seq);
    record(10, 'uninvolved-blocked', uninvolved ? 'FAIL' : 'PASS', uninvolved ? 'claude leaked the brief' : 'claude got nothing');

    const predecessor = await store.recallAssignment('grok', source.seq);
    record(10, 'predecessor-after-baton', predecessor ? 'FAIL' : 'PASS',
      predecessor ? 'grok still recalls after losing the baton (address short-circuit)' : 'predecessor blocked');

    // Closed checkpoint does not authorize non-addressee
    await store.operatorCloseRecovery('codex', source.seq, 'done');
    const closedSuccessor = await store.recallAssignment('codex', source.seq);
    record(10, 'closed-checkpoint-non-addressee', closedSuccessor ? 'FAIL' : 'PASS',
      closedSuccessor ? 'codex recalled via closed checkpoint' : 'closed checkpoint grants nothing to successor');

    // Closed checkpoint on the addressee: address still grants recall
    const closedAddressee = await store.recallAssignment('grok', source.seq);
    record(10, 'closed-checkpoint-addressee', closedAddressee ? 'FAIL' : 'PASS',
      closedAddressee ? 'addressee recalls with no open checkpoint' : 'addressee blocked after close');

    // Predecessor can reopen after inherit
    const source2 = await store.send({
      from: 'claude', to: 'grok', kind: 'task', subject: 'second', body: 'another brief'
    });
    await store.openRecovery('grok', source2.seq, 'started');
    await store.reassignBaton({ to: 'codex', reason: 'again', force: true });
    try {
      await store.openRecovery('grok', source2.seq, 'I am back');
      const grokAgain = await store.recallAssignment('grok', source2.seq);
      const codexStill = await store.recallAssignment('codex', source2.seq);
      record(10, 'addressee-reopen-after-inherit',
        grokAgain && codexStill ? 'FAIL' : 'PASS',
        `grok reopen allowed; grokRecall=${Boolean(grokAgain)} codexRecall=${Boolean(codexStill)}`);
    } catch (error) {
      record(10, 'addressee-reopen-after-inherit', 'PASS', 'openRecovery refused predecessor: ' + String(error.message).split('\n')[0]);
    }
  } finally {
    await cleanup();
  }
}

async function attack18() {
  const { store, cleanup } = await withStore('pab-a18-');
  try {
    const original = await store.send({
      from: 'claude', to: 'grok', kind: 'task', subject: 'stale', body: 'old instruction'
    });

    // Cross-recipient atomic supersede
    const crossed = await store.send({
      from: 'claude', to: 'codex', kind: 'task', subject: 'correction', body: 'new instruction',
      supersedes: original.seq, supersedeReason: 'redirect'
    });
    const grokInbox = await store.inbox('grok');
    const reread = await store.recallAssignment('grok', original.seq);
    record(18, 'cross-recipient-atomic',
      crossed.superseded === true && grokInbox.every((m) => m.seq !== original.seq) ? 'FAIL' : 'PASS',
      `superseded=${crossed.superseded} grokStillHasOriginal=${grokInbox.some((m) => m.seq === original.seq)} recall=${Boolean(reread)} replacementTo=${crossed.to}`);

    // Two-step on a consumed target
    const consumed = await store.send({
      from: 'claude', to: 'grok', kind: 'task', subject: 'act', body: 'do this'
    });
    await store.acknowledge('grok', [consumed.seq]);
    const replacement = await store.send({
      from: 'claude', to: 'grok', kind: 'task', subject: 'too late', body: 'never mind'
    });
    const atomic = await store.send({
      from: 'claude', to: 'grok', kind: 'task', subject: 'atomic-late', body: 'late correction',
      supersedes: consumed.seq
    });
    record(18, 'atomic-consumed-does-not-retract',
      atomic.supersedeOutcome === 'target-consumed' && atomic.superseded !== true ? 'PASS' : 'FAIL',
      `outcome=${atomic.supersedeOutcome} superseded=${atomic.superseded}`);

    try {
      const twoStep = await store.supersedeMessage(consumed.seq, replacement.seq, 'late two-step', 'claude');
      record(18, 'two-step-retracts-consumed',
        twoStep.supersededBy === replacement.seq ? 'FAIL' : 'PASS',
        `two-step set supersededBy=${twoStep.supersededBy} (atomic would not)`);
    } catch (error) {
      record(18, 'two-step-retracts-consumed', 'PASS', 'two-step refused consumed target: ' + String(error.message).split('\n')[0]);
    }

    // Two-step same-recipient requirement vs atomic
    const grokMail = await store.send({
      from: 'claude', to: 'grok', kind: 'task', subject: 'g', body: 'g'
    });
    const otherSeat = await store.send({
      from: 'claude', to: 'codex', kind: 'task', subject: 'c', body: 'c'
    });
    try {
      await store.supersedeMessage(grokMail.seq, otherSeat.seq, 'cross', 'claude');
      record(18, 'two-step-rejects-cross-recipient', 'FAIL', 'two-step allowed different to');
    } catch (error) {
      record(18, 'two-step-rejects-cross-recipient', /addressed to/i.test(String(error.message)) ? 'PASS' : 'FAIL', String(error.message).split('\n')[0]);
    }

    // supersededAt difference
    const a = await store.send({ from: 'claude', to: 'grok', kind: 'note', subject: 'a', body: 'a' });
    const atomicRep = await store.send({
      from: 'claude', to: 'grok', kind: 'note', subject: 'b', body: 'b', supersedes: a.seq
    });
    // reload original
    const all = await store.inbox('grok');
    record(18, 'atomic-sets-superseded', atomicRep.superseded === true ? 'PASS' : 'FAIL', `superseded=${atomicRep.superseded}`);

    // PLAN_SCHEMA / system prompt — static
    const agentSrc = fs.readFileSync(path.join(__dirname, 'src', 'brain', 'brains', 'agent.ts'), 'utf8');
    const schemaBlock = (agentSrc.match(/export const PLAN_SCHEMA = \{[\s\S]*?^};/m) || [''])[0];
    const schemaHas = /supersedes/.test(schemaBlock) && /supersedeReason/.test(schemaBlock);
    const sendLine = (agentSrc.match(/send requires[^']+/) || [''])[0];
    record(18, 'PLAN_SCHEMA-has-supersedes', schemaHas ? 'PASS' : 'FAIL',
      schemaHas ? 'schema includes supersedes' : `PLAN_SCHEMA properties omit supersedes/supersedeReason; keys seen: ${(schemaBlock.match(/^\s{10}(\w+):/gm) || []).join(',')}`);
    record(18, 'system-prompt-describes-atomic', /supersedes/.test(sendLine) ? 'PASS' : 'FAIL',
      sendLine || 'send line missing');

    // extension.ts mailboxSend
    const ext = fs.readFileSync(path.join(__dirname, 'src', 'extension.ts'), 'utf8');
    const extSend = /mailboxSend[\s\S]*?store\.send\(\{ from, to, kind, subject, body \}\)/.test(ext);
    record(18, 'extension-mailboxSend-drops-supersedes', extSend ? 'FAIL' : 'PASS',
      extSend ? 'VS Code mailboxSend calls store.send without supersedes' : 'extension send appears to forward supersedes');
  } finally {
    await cleanup();
  }
}

function git(cwd, args, opts = {}) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: opts.stdio || 'pipe' });
}

function runGuard(busRoot, repo) {
  const cli = path.join(__dirname, 'scripts', 'claim-guard-cli.js');
  try {
    const out = execFileSync(process.execPath, [cli, '--root', busRoot, '--seat', 'grok', '--repo', repo], {
      encoding: 'utf8',
      stdio: 'pipe'
    });
    return { code: 0, out };
  } catch (error) {
    return { code: error.status ?? 1, out: `${error.stdout || ''}${error.stderr || ''}` };
  }
}

async function attack15() {
  const sandbox = await fsp.mkdtemp(path.join(os.tmpdir(), 'pab-a15-'));
  const repo = path.join(sandbox, 'repo');
  const bus = path.join(sandbox, 'bus');
  try {
    fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
    fs.mkdirSync(path.join(bus, '.ai-bus', 'runtime', 'mailbox'), { recursive: true });
    fs.writeFileSync(path.join(bus, '.ai-bus', 'runtime', 'mailbox', 'state.json'), JSON.stringify({
      schema: 1, agents: ['grok'], seq: 0, round: 0,
      claims: {
        grok: [
          { path: 'src', why: 'audit', at: '2026-08-17T00:00:00.000Z' },
          { path: 'tsconfig.json', why: 'audit', at: '2026-08-17T00:00:00.000Z' }
        ]
      }
    }));
    fs.writeFileSync(path.join(repo, 'tsconfig.json'), JSON.stringify({
      compilerOptions: { strict: true, noEmit: true, skipLibCheck: true, target: 'ES2022', module: 'commonjs' },
      include: ['src']
    }, null, 2));
    fs.writeFileSync(path.join(repo, 'src', 'ok.ts'), 'export const n: number = 1;\n');
    fs.writeFileSync(path.join(repo, 'src', 'index.ts'), 'export const n: number = 1;\n');
    // node_modules: junction to this project's so tsc exists
    const modules = path.join(__dirname, 'node_modules');
    if (!junction(path.join(repo, 'node_modules'), modules) && !fs.existsSync(path.join(repo, 'node_modules'))) {
      try { fs.symlinkSync(modules, path.join(repo, 'node_modules'), 'junction'); } catch { /* ignore */ }
    }

    git(repo, ['init']);
    git(repo, ['config', 'user.email', 'audit@example.com']);
    git(repo, ['config', 'user.name', 'audit']);
    git(repo, ['add', 'tsconfig.json', 'src/ok.ts', 'src/index.ts']);
    git(repo, ['commit', '-m', 'base']);

    // Original attack: stage type error, restore good worktree
    fs.writeFileSync(path.join(repo, 'src', 'index.ts'), 'export const n: number = "broken";\n');
    git(repo, ['add', 'src/index.ts']);
    fs.writeFileSync(path.join(repo, 'src', 'index.ts'), 'export const n: number = 1;\n');
    let r = runGuard(bus, repo);
    record(15, 'staged-error-good-worktree',
      r.code === 1 && /REFUSING/.test(r.out) ? 'PASS' : 'FAIL',
      `exit=${r.code} ${r.out.trim().split('\n').slice(0, 4).join(' | ')}`);

    // reset
    git(repo, ['checkout', '--', 'src/index.ts']);
    git(repo, ['reset', 'HEAD', 'src/index.ts']);

    // hide-worktree-tsconfig
    fs.writeFileSync(path.join(repo, 'src', 'index.ts'), 'export const n: number = "broken";\n');
    git(repo, ['add', 'src/index.ts']);
    fs.renameSync(path.join(repo, 'tsconfig.json'), path.join(repo, 'tsconfig.json.hidden'));
    r = runGuard(bus, repo);
    record(15, 'hide-worktree-tsconfig-skips',
      r.code === 0 && /SKIPPED/i.test(r.out) ? 'FAIL' : (r.code === 1 ? 'PASS' : 'FAIL'),
      `exit=${r.code} ${r.out.trim().split('\n').slice(0, 3).join(' | ')}`);
    fs.renameSync(path.join(repo, 'tsconfig.json.hidden'), path.join(repo, 'tsconfig.json'));
    git(repo, ['checkout', '--', 'src/index.ts']);
    git(repo, ['reset', 'HEAD']);

    // worktree-tsconfig-narrow-include
    fs.writeFileSync(path.join(repo, 'src', 'index.ts'), 'export const n: number = "broken";\n');
    git(repo, ['add', 'src/index.ts']);
    fs.writeFileSync(path.join(repo, 'tsconfig.json'), JSON.stringify({
      compilerOptions: { strict: true, noEmit: true, skipLibCheck: true, target: 'ES2022', module: 'commonjs' },
      include: ['src/ok.ts']
    }, null, 2));
    r = runGuard(bus, repo);
    record(15, 'worktree-tsconfig-narrow-include',
      r.code === 0 && /compile OK/.test(r.out) ? 'FAIL' : (r.code === 1 ? 'PASS' : 'FAIL'),
      `exit=${r.code} ${r.out.trim().split('\n').slice(0, 4).join(' | ')}`);
    git(repo, ['checkout', '--', 'tsconfig.json', 'src/index.ts']);
    git(repo, ['reset', 'HEAD']);

    // staged-broken-tsconfig-good-worktree
    fs.writeFileSync(path.join(repo, 'tsconfig.json'), '{ this is not json');
    git(repo, ['add', 'tsconfig.json']);
    fs.writeFileSync(path.join(repo, 'tsconfig.json'), JSON.stringify({
      compilerOptions: { strict: true, noEmit: true, skipLibCheck: true, target: 'ES2022', module: 'commonjs' },
      include: ['src']
    }, null, 2));
    git(repo, ['add', 'src/ok.ts']); // something staged besides? tsconfig is staged
    r = runGuard(bus, repo);
    record(15, 'staged-broken-tsconfig-good-worktree',
      r.code === 0 && /compile OK/.test(r.out) ? 'FAIL' : (r.code === 1 ? 'PASS' : 'FAIL'),
      `exit=${r.code} ${r.out.trim().split('\n').slice(0, 4).join(' | ')}`);

    // honest control
    git(repo, ['checkout', '--', '.']);
    git(repo, ['reset', 'HEAD']);
    fs.writeFileSync(path.join(repo, 'src', 'index.ts'), 'export const n: number = 2;\n');
    git(repo, ['add', 'src/index.ts']);
    r = runGuard(bus, repo);
    record(15, 'honest-staged-compiles',
      r.code === 0 && /staged index/.test(r.out) ? 'PASS' : 'FAIL',
      `exit=${r.code} ${r.out.trim().split('\n').slice(0, 3).join(' | ')}`);
  } catch (error) {
    record(15, 'setup', 'FAIL', String(error && error.stack || error));
  } finally {
    await fsp.rm(sandbox, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 }).catch(() => {});
  }
}

(async () => {
  await attack13();
  await attack10();
  await attack18();
  await attack15();
  const out = path.join(__dirname, 'tmp-audit-1842-live-out.json');
  fs.writeFileSync(out, JSON.stringify(results, null, 2));
  console.log('\n--- SUMMARY ---');
  for (const row of results) {
    console.log(`${row.item} ${row.verdict} ${row.name}`);
  }
  const fails = results.filter((r) => r.verdict === 'FAIL');
  console.log(`\n${fails.length} FAIL / ${results.length} recorded`);
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
