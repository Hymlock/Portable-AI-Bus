'use strict';
/**
 * Independent AUDIT instrument, grok, session after #1865.
 * Attacks current HEAD (373e176). Named commits were 8ea4c35 / 082ddfa;
 * item 15 was refixed at 8b5ae78. Does not edit src/ or tests/.
 */
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { MailboxStore } = require('./dist/mailbox.js');
const { PLAN_SCHEMA, buildDefaultSystem } = require('./dist/brain/brains/agent.js');
const { buildGrokArgs } = require('./dist/brain/providers.js');
const { cliBusClient } = require('./dist/brain/bus-client.js');

const REPO = __dirname;
const GUARD = path.join(REPO, 'scripts', 'claim-guard-cli.js');
const results = [];

function rec(item, name, status, detail) {
  const row = { item, name, status, detail: String(detail).slice(0, 1200) };
  results.push(row);
  console.log(`[${status}] item ${item} / ${name}: ${row.detail}`);
}

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

function dirSymlink(link, target) {
  try {
    execFileSync('cmd.exe', ['/c', 'mklink', '/D', link, target], { stdio: 'pipe' });
    return true;
  } catch {
    try {
      fs.symlinkSync(target, link, 'dir');
      return true;
    } catch {
      return false;
    }
  }
}

function fileSymlink(link, target) {
  try {
    execFileSync('cmd.exe', ['/c', 'mklink', link, target], { stdio: 'pipe' });
    return true;
  } catch {
    try {
      fs.symlinkSync(target, link, 'file');
      return true;
    } catch {
      return false;
    }
  }
}

function runGuard(repo, busRoot, env = {}) {
  try {
    const stdout = execFileSync(process.execPath, [GUARD, '--repo', repo, '--seat', 'claude', '--root', busRoot], {
      cwd: repo,
      encoding: 'utf8',
      stdio: 'pipe',
      env: { ...process.env, ...env }
    });
    return { code: 0, out: stdout };
  } catch (error) {
    return { code: error.status ?? 1, out: `${error.stdout || ''}${error.stderr || ''}` };
  }
}

function errMsg(error) {
  return error && error.message ? error.message : String(error);
}

function inboxDir(root) {
  return path.join(root, '.ai-bus', 'runtime', 'mailbox', 'inbox');
}

function readInboxMessage(root, seq) {
  const dir = inboxDir(root);
  if (!fs.existsSync(dir)) return undefined;
  for (const name of fs.readdirSync(dir)) {
    const message = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
    if (message.seq === seq) return message;
  }
  return undefined;
}

async function claimWorkspace() {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'pab-r3b-13-'));
  const workspace = path.join(dir, 'ws');
  await fsp.mkdir(path.join(workspace, 'src'), { recursive: true });
  await fsp.writeFile(path.join(workspace, 'src', 'bus.ts'), 'x');
  await fsp.writeFile(path.join(workspace, 'README.md'), 'root file');
  const busRoot = path.join(dir, 'bus');
  await fsp.mkdir(busRoot, { recursive: true });
  const store = new MailboxStore(busRoot);
  await store.ensureInitialized(['claude', 'codex', 'grok'], 500);
  return {
    dir, workspace, busRoot, store,
    cleanup: () => fsp.rm(dir, { recursive: true, force: true, maxRetries: 8 }).catch(() => {})
  };
}

async function fixtureRepo() {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'pab-r3b-15-'));
  const repo = path.join(dir, 'repo');
  await fsp.mkdir(path.join(repo, 'src'), { recursive: true });
  git(repo, 'init', '-q');
  git(repo, 'config', 'user.email', 'gate@example.com');
  git(repo, 'config', 'user.name', 'gate');
  await fsp.writeFile(path.join(repo, '.gitignore'), 'node_modules/\n');
  await fsp.writeFile(path.join(repo, 'tsconfig.json'), JSON.stringify({
    compilerOptions: { strict: true, noEmit: true, skipLibCheck: true, types: [] },
    include: ['src']
  }, null, 2));
  await fsp.writeFile(path.join(repo, 'src', 'ok.ts'), 'export const fine: number = 1;\n');
  await fsp.writeFile(path.join(repo, 'src', 'index.ts'), 'export const good: number = 1;\n');
  const linked = junction(path.join(repo, 'node_modules'), path.join(REPO, 'node_modules'));
  const busRoot = path.join(dir, 'bus');
  const mailboxDir = path.join(busRoot, '.ai-bus', 'runtime', 'mailbox');
  await fsp.mkdir(mailboxDir, { recursive: true });
  await fsp.writeFile(
    path.join(mailboxDir, 'state.json'),
    JSON.stringify({ claims: { claude: [{ path: 'src' }, { path: 'tsconfig.json' }, { path: 'pkg' }] } })
  );
  return {
    dir, repo, busRoot, linked,
    cleanup: () => fsp.rm(dir, { recursive: true, force: true, maxRetries: 8 }).catch(() => {})
  };
}

async function stageBrokenThenRestoreWorktree(repo) {
  await fsp.writeFile(path.join(repo, 'src', 'index.ts'), 'export const broken: number = "no";\n');
  git(repo, 'add', '-A');
  await fsp.writeFile(path.join(repo, 'src', 'index.ts'), 'export const good: number = 1;\n');
}

async function mailboxPair() {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'pab-r3b-mb-'));
  const store = new MailboxStore(dir);
  await store.ensureInitialized(['claude', 'codex', 'grok'], 500);
  return { dir, store, cleanup: () => fsp.rm(dir, { recursive: true, force: true, maxRetries: 8 }).catch(() => {}) };
}

// ---------------------------------------------------------------------------
// ITEM 13
// ---------------------------------------------------------------------------
async function attack13() {
  {
    const fx = await claimWorkspace();
    try {
      if (process.platform !== 'win32' || !dirSymlink(path.join(fx.workspace, 'above'), fx.dir)) {
        rec(13, 'symlink-to-parent', 'SKIP', 'directory symlink unavailable');
      } else {
        try {
          await fx.store.claim({ agent: 'codex', paths: ['above'], why: 'symlink parent', repoRoot: fx.workspace });
          rec(13, 'symlink-to-parent', 'FAIL', 'accepted a dir-symlink to the root parent');
        } catch (error) {
          rec(13, 'symlink-to-parent', /whole repositor|too broad/i.test(errMsg(error)) ? 'PASS' : 'FAIL', errMsg(error));
        }
        try {
          await fx.store.claim({ agent: 'grok', paths: ['src/bus.ts'], why: 'still open', repoRoot: fx.workspace });
          rec(13, 'symlink-does-not-lock', 'PASS', 'other seat still claims');
        } catch (error) {
          rec(13, 'symlink-does-not-lock', 'FAIL', errMsg(error));
        }
      }
    } finally { await fx.cleanup(); }
  }

  {
    const fx = await claimWorkspace();
    try {
      const alias = path.join(fx.dir, 'alias-root');
      if (!junction(alias, fx.workspace)) {
        rec(13, 'root-is-junction', 'SKIP', 'junction unavailable');
      } else {
        try {
          await fx.store.claim({ agent: 'codex', paths: ['src/bus.ts'], why: 'through linked root', repoRoot: alias });
          rec(13, 'root-is-junction-child', 'PASS', 'child claim through linked root works');
        } catch (error) {
          rec(13, 'root-is-junction-child', 'FAIL', errMsg(error));
        }
        try {
          await fx.store.claim({ agent: 'codex', paths: ['.'], why: 'dot through link', repoRoot: alias });
          rec(13, 'root-is-junction-dot', 'FAIL', 'accepted . through linked root');
        } catch (error) {
          rec(13, 'root-is-junction-dot', /whole repositor|too broad/i.test(errMsg(error)) ? 'PASS' : 'FAIL', errMsg(error));
        }
      }
    } finally { await fx.cleanup(); }
  }

  {
    const fx = await claimWorkspace();
    try {
      await fx.store.claim({ agent: 'codex', paths: ['SRC/bus.ts'], why: 'windows case', repoRoot: fx.workspace });
      rec(13, 'windows-case', 'PASS', 'SRC/bus.ts resolved under src');
    } catch (error) {
      rec(13, 'windows-case', 'FAIL', errMsg(error));
    } finally { await fx.cleanup(); }
  }

  {
    const fx = await claimWorkspace();
    try {
      const all = path.join(fx.workspace, 'src', 'all');
      if (!junction(all, fx.workspace)) {
        rec(13, 'under-root-blocks-tree', 'SKIP', 'junction unavailable');
      } else {
        try {
          await fx.store.claim({ agent: 'codex', paths: ['src'], why: 'parent of outbound junction', repoRoot: fx.workspace });
          rec(13, 'claim-src-with-outbound-junction', 'PASS', 'claiming src accepted');
        } catch (error) {
          rec(13, 'claim-src-with-outbound-junction', 'FAIL', errMsg(error));
        }
        try {
          await fx.store.claim({ agent: 'grok', paths: ['README.md'], why: 'sibling of claimed src', repoRoot: fx.workspace });
          rec(13, 'src-claim-does-not-block-readme', 'PASS', 'README still claimable');
        } catch (error) {
          rec(13, 'src-claim-does-not-block-readme', 'FAIL', errMsg(error));
        }
        try {
          await fx.store.claim({ agent: 'claude', paths: ['src/all'], why: 'junction equals root', repoRoot: fx.workspace });
          rec(13, 'junction-equals-root', 'FAIL', 'accepted src/all which realpaths to the root');
        } catch (error) {
          rec(13, 'junction-equals-root', /whole repositor|too broad/i.test(errMsg(error)) ? 'PASS' : 'FAIL', errMsg(error));
        }
      }
    } finally { await fx.cleanup(); }
  }

  {
    const fx = await claimWorkspace();
    try {
      const leak = path.join(fx.workspace, 'src', 'leak.ts');
      const outside = path.join(fx.dir, 'outside.ts');
      await fsp.writeFile(outside, 'export const x = 1;\n');
      if (!fileSymlink(leak, outside)) {
        rec(13, 'file-symlink-outside', 'SKIP', 'file symlink unavailable');
      } else {
        try {
          await fx.store.claim({ agent: 'codex', paths: ['src/leak.ts'], why: 'file symlink out', repoRoot: fx.workspace });
          rec(13, 'file-symlink-outside', 'FAIL', 'accepted file symlink whose realpath is outside the root');
        } catch (error) {
          rec(13, 'file-symlink-outside', /whole repositor|too broad/i.test(errMsg(error)) ? 'PASS' : 'FAIL', errMsg(error));
        }
      }
    } finally { await fx.cleanup(); }
  }

  {
    const fx = await claimWorkspace();
    try {
      await fx.store.claim({ agent: 'codex', paths: ['src/bus.ts'], why: 'ordinary', repoRoot: fx.workspace });
      rec(13, 'green-ordinary', 'PASS', 'ordinary below-root claim');
    } catch (error) {
      rec(13, 'green-ordinary', 'FAIL', errMsg(error));
    } finally { await fx.cleanup(); }
  }

  {
    const fx = await claimWorkspace();
    try {
      await fx.store.claim({
        agent: 'codex',
        paths: ['src/bus.ts'],
        why: 'missing root',
        repoRoot: path.join(fx.workspace, 'does-not-exist')
      });
      rec(13, 'missing-root', 'FAIL', 'accepted a claim against a missing repoRoot');
    } catch (error) {
      rec(13, 'missing-root', /does not exist/i.test(errMsg(error)) ? 'PASS' : 'FAIL', errMsg(error));
    } finally { await fx.cleanup(); }
  }

  {
    const fx = await claimWorkspace();
    try {
      const sibling = path.join(fx.dir, `${path.basename(fx.workspace)}-evil`);
      await fsp.mkdir(sibling, { recursive: true });
      await fsp.writeFile(path.join(sibling, 'x.ts'), 'x');
      const link = path.join(fx.workspace, 'src', 'prefix-sib');
      if (!junction(link, sibling)) {
        rec(13, 'prefix-sibling-outside', 'SKIP', 'junction unavailable');
      } else {
        try {
          await fx.store.claim({ agent: 'codex', paths: ['src/prefix-sib'], why: 'prefix sibling', repoRoot: fx.workspace });
          rec(13, 'prefix-sibling-outside', 'FAIL', 'accepted junction to a path that is not under the root');
        } catch (error) {
          rec(13, 'prefix-sibling-outside', /whole repositor|too broad/i.test(errMsg(error)) ? 'PASS' : 'FAIL', errMsg(error));
        }
      }
    } finally { await fx.cleanup(); }
  }
}

// ---------------------------------------------------------------------------
// ITEM 10
// ---------------------------------------------------------------------------
async function seedWork(store, to = 'grok') {
  const source = await store.send({
    from: 'claude',
    to,
    kind: 'task',
    subject: 'do the work',
    body: 'PERMISSION: you may edit src/foo.ts. GATES: tests pass.'
  });
  await store.openRecovery(to, source.seq, 'started');
  return source;
}

async function attack10() {
  {
    const fx = await mailboxPair();
    try {
      const source = await seedWork(fx.store);
      await fx.store.reassignBaton({ to: 'codex', reason: 'failover', force: true });
      const pred = await fx.store.recallAssignment('grok', source.seq);
      const succ = await fx.store.recallAssignment('codex', source.seq);
      const open = await fx.store.openRecoveryFor('codex');
      if (!succ || pred || !open || open.inheritedFrom !== 'grok') {
        rec(10, 'inheritedFrom-not-authority', 'FAIL',
          `pred=${Boolean(pred)} succ=${Boolean(succ)} inheritedFrom=${open && open.inheritedFrom}`);
      } else {
        rec(10, 'inheritedFrom-not-authority', 'PASS',
          'successor recalls; predecessor denied; inheritedFrom is metadata only');
      }
    } finally { await fx.cleanup(); }
  }

  {
    const fx = await mailboxPair();
    try {
      const one = await seedWork(fx.store);
      const two = await fx.store.send({
        from: 'claude', to: 'grok', kind: 'task', subject: 'other', body: 'other brief'
      });
      const leaked = await fx.store.recallAssignment('grok', two.seq);
      rec(10, 'other-workId-no-checkpoint', leaked ? 'FAIL' : 'PASS',
        leaked ? 'open #1 granted #2' : 'open #1 does not grant #2');

      await fx.store.reassignBaton({ to: 'codex', reason: 'move #1', force: true });
      rec(10, 'other-workId-after-move',
        (await fx.store.recallAssignment('grok', one.seq)) || (await fx.store.recallAssignment('grok', two.seq))
          ? 'FAIL' : 'PASS',
        'after move grok#1 and grok#2 stay undefined');

      await fx.store.openRecovery('grok', two.seq, 'other work');
      const resurrected = await fx.store.recallAssignment('grok', one.seq);
      const twoOk = await fx.store.recallAssignment('grok', two.seq);
      rec(10, 'open-other-does-not-resurrect-moved',
        resurrected ? 'FAIL' : (twoOk ? 'PASS' : 'FAIL'),
        `open #2 resurrected #1? #1=${Boolean(resurrected)} #2=${Boolean(twoOk)}`);
    } finally { await fx.cleanup(); }
  }

  {
    const fx = await mailboxPair();
    try {
      const source = await seedWork(fx.store);
      await fx.store.reassignBaton({ to: 'codex', reason: 'hop1', force: true });
      await fx.store.reassignBaton({ to: 'claude', reason: 'hop2', force: true });
      const g = Boolean(await fx.store.recallAssignment('grok', source.seq));
      const x = Boolean(await fx.store.recallAssignment('codex', source.seq));
      const c = Boolean(await fx.store.recallAssignment('claude', source.seq));
      rec(10, 'reassign-twice-forward', (!g && !x && c) ? 'PASS' : 'FAIL',
        `after grok->codex->claude: grok=${g} codex=${x} claude=${c}`);
    } finally { await fx.cleanup(); }
  }

  {
    const fx = await mailboxPair();
    try {
      const source = await seedWork(fx.store);
      await fx.store.reassignBaton({ to: 'codex', reason: 'hop1', force: true });
      await fx.store.reassignBaton({ to: 'grok', reason: 'hop2', force: true });
      const g = Boolean(await fx.store.recallAssignment('grok', source.seq));
      const x = Boolean(await fx.store.recallAssignment('codex', source.seq));
      rec(10, 'reassign-twice-back', (g && !x) ? 'PASS' : 'FAIL',
        `after grok->codex->grok: grok=${g} codex=${x}`);
    } finally { await fx.cleanup(); }
  }

  {
    const fx = await mailboxPair();
    try {
      const source = await seedWork(fx.store);
      await fx.store.reassignBaton({ to: 'codex', reason: 'move', force: true });
      try {
        await fx.store.openRecovery('grok', source.seq, 'steal');
        rec(10, 'predecessor-reopen-while-held', 'FAIL', 'predecessor reopened while successor holds');
      } catch (error) {
        rec(10, 'predecessor-reopen-while-held', /held by/i.test(errMsg(error)) ? 'PASS' : 'FAIL', errMsg(error));
      }
    } finally { await fx.cleanup(); }
  }

  {
    const fx = await mailboxPair();
    try {
      const source = await seedWork(fx.store);
      await fx.store.reassignBaton({ to: 'codex', reason: 'move', force: true });
      await fx.store.closeRecovery('codex', source.seq, 'done');
      const reopened = await fx.store.openRecovery('grok', source.seq, 'pick up');
      const brief = reopened ? await fx.store.recallAssignment('grok', source.seq) : undefined;
      rec(10, 'addressee-reopen-after-successor-close', 'NOTE',
        brief
          ? 'after successor closes, original addressee can openRecovery and recall — address is a condition for OPENING once unheld'
          : 'addressee could not pick up unheld work');
    } finally { await fx.cleanup(); }
  }

  {
    const src = fs.readFileSync(path.join(REPO, 'src', 'brain', 'bus-client.ts'), 'utf8');
    const dist = fs.readFileSync(path.join(REPO, 'dist', 'brain', 'bus-client.js'), 'utf8');
    const cli = fs.readFileSync(path.join(REPO, 'src', 'brain', 'cli.ts'), 'utf8');
    const hasSrc = /recallAssignment/.test(src);
    const hasDist = /recallAssignment/.test(dist);
    const usesCli = /cliBusClient\(/.test(cli);
    rec(10, 'production-cliBusClient-has-recall', (hasSrc || hasDist) ? 'PASS' : 'FAIL',
      `src=${hasSrc} dist=${hasDist} cliUsesCliBusClient=${usesCli}. Runner only recalls if bus.recallAssignment is defined.`);

    const client = cliBusClient({ root: path.join(os.tmpdir(), 'pab-r3b-missing') });
    rec(10, 'cliBusClient-instance-lacks-recall',
      typeof client.recallAssignment === 'function' ? 'PASS' : 'FAIL',
      `typeof client.recallAssignment = ${typeof client.recallAssignment}`);
  }

  {
    const fx = await mailboxPair();
    try {
      const source = await seedWork(fx.store);
      const a = await fx.store.recallAssignment('grok', source.seq);
      const b = await fx.store.recallAssignment('grok', source.seq);
      rec(10, 'green-holder-recalls', (a && b && a.includes('PERMISSION')) ? 'PASS' : 'FAIL',
        a ? 'holder recalled twice' : 'holder could not recall');
    } finally { await fx.cleanup(); }
  }
}

// ---------------------------------------------------------------------------
// ITEM 18
// ---------------------------------------------------------------------------
async function attack18() {
  rec(18, 'schema-has-supersedes',
    PLAN_SCHEMA?.properties?.actions?.items?.properties?.supersedes?.type === 'number' ? 'PASS' : 'FAIL',
    `supersedes type=${PLAN_SCHEMA?.properties?.actions?.items?.properties?.supersedes?.type}`);

  const prompt = buildDefaultSystem();
  rec(18, 'prompt-describes-atomic',
    /send may also carry supersedes/i.test(prompt) ? 'PASS' : 'FAIL',
    'system prompt names atomic retract');

  const args = buildGrokArgs('hello', PLAN_SCHEMA);
  const schemaIdx = args.indexOf('--json-schema');
  let emitted = false;
  if (schemaIdx >= 0 && args[schemaIdx + 1]) {
    const parsed = JSON.parse(args[schemaIdx + 1]);
    emitted = parsed?.properties?.actions?.items?.properties?.supersedes?.type === 'number';
  }
  rec(18, 'schema-reaches-buildGrokArgs', emitted ? 'PASS' : 'FAIL',
    emitted ? 'buildGrokArgs emits --json-schema with supersedes:{type:number}' : `args=${JSON.stringify(args).slice(0, 300)}`);

  {
    const fx = await mailboxPair();
    try {
      const original = await fx.store.send({
        from: 'claude', to: 'grok', kind: 'task', subject: 'orig', body: 'do A'
      });
      try {
        const sent = await fx.store.send({
          from: 'claude', to: 'codex', kind: 'task', subject: 'steal', body: 'do B',
          supersedes: original.seq
        });
        rec(18, 'atomic-cross-recipient', 'FAIL', `sent #${sent.seq} and retracted grok's mail`);
      } catch (error) {
        const inbox = await fx.store.inbox('grok');
        rec(18, 'atomic-cross-recipient',
          inbox.length === 1 && inbox[0].seq === original.seq ? 'PASS' : 'FAIL',
          `${errMsg(error)}; grok inbox still has original=${inbox.some((m) => m.seq === original.seq)}`);
      }
    } finally { await fx.cleanup(); }
  }

  {
    const fx = await mailboxPair();
    try {
      const original = await fx.store.send({
        from: 'claude', to: 'grok', kind: 'task', subject: 'orig', body: 'do A'
      });
      const replacement = await fx.store.send({
        from: 'claude', to: 'codex', kind: 'task', subject: 'other', body: 'do B'
      });
      try {
        await fx.store.supersedeMessage(original.seq, replacement.seq, 'cross', 'claude');
        rec(18, 'twostep-cross-recipient', 'FAIL', 'two-step allowed cross-recipient');
      } catch (error) {
        rec(18, 'twostep-cross-recipient', /addressed to/i.test(errMsg(error)) ? 'PASS' : 'FAIL', errMsg(error));
      }
    } finally { await fx.cleanup(); }
  }

  {
    const fx = await mailboxPair();
    try {
      const original = await fx.store.send({
        from: 'claude', to: 'grok', kind: 'task', subject: 'orig', body: 'do A'
      });
      await fx.store.read('grok');
      const sent = await fx.store.send({
        from: 'claude', to: 'grok', kind: 'task', subject: 'fix', body: 'do B',
        supersedes: original.seq
      });
      const reread = readInboxMessage(fx.dir, original.seq);
      rec(18, 'atomic-consumed-policy',
        sent.superseded === false && sent.supersedeOutcome === 'target-consumed' && reread && !reread.supersededBy
          ? 'PASS' : 'FAIL',
        `superseded=${sent.superseded} outcome=${sent.supersedeOutcome} target.supersededBy=${reread && reread.supersededBy}`);
    } finally { await fx.cleanup(); }
  }

  {
    const fx = await mailboxPair();
    try {
      const original = await fx.store.send({
        from: 'claude', to: 'grok', kind: 'task', subject: 'orig', body: 'do A'
      });
      const replacement = await fx.store.send({
        from: 'claude', to: 'grok', kind: 'task', subject: 'fix', body: 'do B'
      });
      await fx.store.read('grok');
      try {
        await fx.store.supersedeMessage(original.seq, replacement.seq, 'too late', 'claude');
        rec(18, 'twostep-consumed-policy', 'FAIL', 'two-step marked a read message');
      } catch (error) {
        rec(18, 'twostep-consumed-policy', /already read/i.test(errMsg(error)) ? 'PASS' : 'FAIL', errMsg(error));
      }
    } finally { await fx.cleanup(); }
  }

  {
    const fx = await mailboxPair();
    try {
      const original = await fx.store.send({
        from: 'claude', to: 'grok', kind: 'task', subject: 'orig', body: 'do A'
      });
      const sent = await fx.store.send({
        from: 'claude', to: 'grok', kind: 'task', subject: 'fix', body: 'do B',
        supersedes: original.seq, supersedeReason: 'corrected'
      });
      const target = readInboxMessage(fx.dir, original.seq);
      rec(18, 'atomic-writes-supersededAt',
        sent.superseded === true && target && target.supersededAt && target.supersededBy === sent.seq ? 'PASS' : 'FAIL',
        `supersededAt=${target && target.supersededAt} by=${target && target.supersededBy}`);
    } finally { await fx.cleanup(); }
  }

  {
    const fx = await mailboxPair();
    try {
      const original = await fx.store.send({
        from: 'claude', to: 'grok', kind: 'task', subject: 'orig', body: 'do A'
      });
      try {
        await fx.store.send({
          from: 'claude', to: 'grok', kind: 'task', subject: 'fix', body: 'do B',
          supersedes: original.seq, supersedeReason: '   '
        });
        const target = readInboxMessage(fx.dir, original.seq);
        rec(18, 'atomic-whitespace-reason', 'NOTE',
          `atomic defaulted empty reason to ${JSON.stringify(target && target.supersedeReason)}`);
      } catch (error) {
        rec(18, 'atomic-whitespace-reason', 'PASS', errMsg(error));
      }
    } finally { await fx.cleanup(); }
  }

  {
    const fx = await mailboxPair();
    try {
      const original = await fx.store.send({
        from: 'claude', to: 'grok', kind: 'task', subject: 'orig', body: 'do A'
      });
      const replacement = await fx.store.send({
        from: 'claude', to: 'grok', kind: 'task', subject: 'fix', body: 'do B'
      });
      try {
        await fx.store.supersedeMessage(original.seq, replacement.seq, '   ', 'claude');
        rec(18, 'twostep-empty-reason', 'FAIL', 'two-step accepted whitespace reason');
      } catch (error) {
        rec(18, 'twostep-empty-reason', /must not be empty/i.test(errMsg(error)) ? 'PASS' : 'FAIL', errMsg(error));
      }
    } finally { await fx.cleanup(); }
  }

  rec(18, 'consumed-shape-disagreement', 'NOTE',
    'atomic returns the correction (superseded=false, target-consumed); two-step throws. Same policy, different call outcome.');
}

// ---------------------------------------------------------------------------
// ITEM 15
// ---------------------------------------------------------------------------
async function attack15() {
  {
    const fx = await fixtureRepo();
    try {
      if (!fx.linked) { rec(15, 'negative-control', 'SKIP', 'no node_modules junction'); }
      else {
        await stageBrokenThenRestoreWorktree(fx.repo);
        const result = runGuard(fx.repo, fx.busRoot);
        rec(15, 'negative-control-staged-error',
          result.code === 1 && /TS2322|does not compile/i.test(result.out) ? 'PASS' : 'FAIL',
          `exit=${result.code} ${result.out}`);
      }
    } finally { await fx.cleanup(); }
  }

  {
    const fx = await fixtureRepo();
    try {
      if (!fx.linked) { rec(15, 'absolute-include-worktree', 'SKIP', 'no node_modules'); }
      else {
        await stageBrokenThenRestoreWorktree(fx.repo);
        const abs = path.resolve(fx.repo, 'src').replace(/\\/g, '/');
        await fsp.writeFile(path.join(fx.repo, 'tsconfig.json'), JSON.stringify({
          compilerOptions: { strict: true, noEmit: true, skipLibCheck: true, types: [] },
          include: [abs]
        }, null, 2));
        git(fx.repo, 'add', 'tsconfig.json');
        const result = runGuard(fx.repo, fx.busRoot);
        rec(15, 'absolute-include-worktree',
          result.code === 1 && /OUTSIDE the staged tree/i.test(result.out) ? 'PASS' : (result.code === 0 ? 'FAIL' : 'NOTE'),
          `exit=${result.code} ${result.out}`);
      }
    } finally { await fx.cleanup(); }
  }

  {
    const fx = await fixtureRepo();
    try {
      if (!fx.linked) { rec(15, 'extends-worktree-only', 'SKIP', 'no node_modules'); }
      else {
        await stageBrokenThenRestoreWorktree(fx.repo);
        const base = path.join(fx.repo, 'tsconfig.worktree-only.json');
        await fsp.writeFile(base, JSON.stringify({
          compilerOptions: { strict: true, noEmit: true, skipLibCheck: true, types: [] },
          include: ['src/ok.ts']
        }, null, 2));
        await fsp.writeFile(path.join(fx.repo, 'tsconfig.json'), JSON.stringify({
          extends: path.resolve(base).replace(/\\/g, '/')
        }, null, 2));
        git(fx.repo, 'add', 'tsconfig.json');
        const result = runGuard(fx.repo, fx.busRoot);
        rec(15, 'extends-worktree-only',
          result.code === 1 && /OUTSIDE the staged tree|extends/i.test(result.out) ? 'PASS' : (result.code === 0 ? 'FAIL' : 'NOTE'),
          `exit=${result.code} ${result.out}`);
      }
    } finally { await fx.cleanup(); }
  }

  {
    const fx = await fixtureRepo();
    try {
      if (!fx.linked) { rec(15, 'string-include', 'SKIP', 'no node_modules'); }
      else {
        await stageBrokenThenRestoreWorktree(fx.repo);
        const abs = path.resolve(fx.repo, 'src').replace(/\\/g, '/');
        await fsp.writeFile(path.join(fx.repo, 'tsconfig.json'), JSON.stringify({
          compilerOptions: { strict: true, noEmit: true, skipLibCheck: true, types: [] },
          include: abs
        }, null, 2));
        git(fx.repo, 'add', 'tsconfig.json');
        const result = runGuard(fx.repo, fx.busRoot);
        rec(15, 'string-include-absolute',
          result.code === 0 ? 'FAIL' : (result.code === 1 ? 'PASS' : 'NOTE'),
          `walker skips non-array include. exit=${result.code} ${result.out}`);
      }
    } finally { await fx.cleanup(); }
  }

  {
    const fx = await fixtureRepo();
    try {
      if (!fx.linked) { rec(15, 'glob-dotdot', 'SKIP', 'no node_modules'); }
      else {
        await stageBrokenThenRestoreWorktree(fx.repo);
        const outside = path.relative(fx.repo, path.join(fx.dir, 'outside-src')).replace(/\\/g, '/');
        await fsp.mkdir(path.join(fx.dir, 'outside-src'), { recursive: true });
        await fsp.writeFile(path.join(fx.dir, 'outside-src', 'good.ts'), 'export const good: number = 1;\n');
        await fsp.writeFile(path.join(fx.repo, 'tsconfig.json'), JSON.stringify({
          compilerOptions: { strict: true, noEmit: true, skipLibCheck: true, types: [] },
          include: [`./**/../${outside}`]
        }, null, 2));
        git(fx.repo, 'add', 'tsconfig.json');
        const result = runGuard(fx.repo, fx.busRoot);
        rec(15, 'glob-hides-dotdot',
          result.code === 0 ? 'FAIL' : ( /OUTSIDE/i.test(result.out) ? 'PASS' : 'NOTE'),
          `literal prefix of glob is './'. exit=${result.code} ${result.out}`);
      }
    } finally { await fx.cleanup(); }
  }

  {
    const fx = await fixtureRepo();
    try {
      if (!fx.linked) { rec(15, 'reference-escape', 'SKIP', 'no node_modules'); }
      else {
        await stageBrokenThenRestoreWorktree(fx.repo);
        const pkg = path.join(fx.repo, 'pkg');
        await fsp.mkdir(pkg, { recursive: true });
        const abs = path.resolve(fx.repo, 'src').replace(/\\/g, '/');
        await fsp.writeFile(path.join(pkg, 'tsconfig.json'), JSON.stringify({
          compilerOptions: { strict: true, noEmit: true, skipLibCheck: true, types: [], composite: true },
          include: [abs]
        }, null, 2));
        await fsp.writeFile(path.join(fx.repo, 'tsconfig.json'), JSON.stringify({
          compilerOptions: { strict: true, noEmit: true, skipLibCheck: true, types: [] },
          files: [],
          references: [{ path: './pkg' }]
        }, null, 2));
        git(fx.repo, 'add', '-A');
        const result = runGuard(fx.repo, fx.busRoot);
        rec(15, 'reference-project-escape',
          result.code === 0 ? 'FAIL' : (/OUTSIDE/i.test(result.out) ? 'PASS' : 'NOTE'),
          `walker checks references[].path only, does not walk the referenced tsconfig. exit=${result.code} ${result.out}`);
      }
    } finally { await fx.cleanup(); }
  }

  {
    const fx = await fixtureRepo();
    try {
      if (!fx.linked) { rec(15, 'bare-extends', 'SKIP', 'no node_modules'); }
      else {
        await stageBrokenThenRestoreWorktree(fx.repo);
        const nm = path.join(fx.repo, 'local_modules', 'leak-config');
        await fsp.mkdir(nm, { recursive: true });
        const abs = path.resolve(fx.repo, 'src').replace(/\\/g, '/');
        await fsp.writeFile(path.join(nm, 'package.json'), JSON.stringify({ name: 'leak-config', version: '1.0.0' }));
        await fsp.writeFile(path.join(nm, 'tsconfig.json'), JSON.stringify({
          compilerOptions: { strict: true, noEmit: true, skipLibCheck: true, types: [] },
          include: [abs]
        }, null, 2));
        // Put leak-config on NODE_PATH equivalent by nesting under a real node_modules
        // that tsc will see. The guard junctions REPO node_modules; we also need tsc.
        // Stage an extends that is a relative path through a STAGED package, AND a
        // bare specifier if we can inject one beside the junction.
        // Bare specifier requires the package to live in scratch/node_modules after
        // the guard creates its junction. The junction points at REPO node_modules,
        // so we cannot inject there. Use relative extends through a staged copy of
        // the package? That would be walked. The hole is specifically the bare skip.
        //
        // Recreate fixture node_modules as a REAL directory containing:
        //   typescript -> junction to real typescript
        //   .bin/tsc.cmd copy or junction
        //   leak-config/
        await fsp.rm(path.join(fx.repo, 'node_modules'), { recursive: true, force: true });
        await fsp.mkdir(path.join(fx.repo, 'node_modules'), { recursive: true });
        const okJunc = junction(path.join(fx.repo, 'node_modules', 'typescript'),
          path.join(REPO, 'node_modules', 'typescript'));
        const okBin = junction(path.join(fx.repo, 'node_modules', '.bin'),
          path.join(REPO, 'node_modules', '.bin'));
        await fsp.cp(nm, path.join(fx.repo, 'node_modules', 'leak-config'), { recursive: true });
        await fsp.writeFile(path.join(fx.repo, 'tsconfig.json'), JSON.stringify({
          extends: 'leak-config/tsconfig.json'
        }, null, 2));
        git(fx.repo, 'add', 'tsconfig.json');
        const result = runGuard(fx.repo, fx.busRoot);
        rec(15, 'bare-extends-package-include-worktree',
          result.code === 0 ? 'FAIL' : (/OUTSIDE|extends/i.test(result.out) ? 'PASS' : 'NOTE'),
          `bare extends is not walked. tsc/bin linked=${okJunc && okBin}. exit=${result.code} ${result.out}`);
      }
    } finally { await fx.cleanup(); }
  }

  {
    const fx = await fixtureRepo();
    try {
      if (!fx.linked) { rec(15, 'triple-slash', 'SKIP', 'no node_modules'); }
      else {
        await fsp.writeFile(path.join(fx.repo, 'src', 'index.ts'), 'export const broken: number = "no";\n');
        git(fx.repo, 'add', '-A');
        const abs = path.resolve(fx.repo, 'src', 'ok.ts').replace(/\\/g, '/');
        await fsp.writeFile(path.join(fx.repo, 'src', 'index.ts'),
          `/// <reference path="${abs}" />\nexport const broken: number = "no";\n`);
        // Keep the type error in the staged file; the question is whether a
        // reference lets tsc prefer the worktree. Restore worktree to good.
        git(fx.repo, 'add', 'src/index.ts');
        await fsp.writeFile(path.join(fx.repo, 'src', 'index.ts'), 'export const good: number = 1;\n');
        const result = runGuard(fx.repo, fx.busRoot);
        rec(15, 'triple-slash-reference',
          result.code === 1 && /does not compile|TS2322/i.test(result.out) ? 'PASS'
            : (result.code === 0 ? 'NOTE' : 'NOTE'),
          `triple-slash to worktree. exit=${result.code} ${result.out}`);
      }
    } finally { await fx.cleanup(); }
  }

  {
    const fx = await fixtureRepo();
    try {
      if (!fx.linked) { rec(15, 'hatch', 'SKIP', 'no node_modules'); }
      else {
        await stageBrokenThenRestoreWorktree(fx.repo);
        const result = runGuard(fx.repo, fx.busRoot, { BUS_ALLOW_BROKEN_BUILD: '1' });
        rec(15, 'hatch',
          result.code === 0 && /BUS_ALLOW_BROKEN_BUILD=1/i.test(result.out) ? 'PASS' : 'FAIL',
          `exit=${result.code} ${result.out}`);
      }
    } finally { await fx.cleanup(); }
  }

  {
    const fx = await fixtureRepo();
    try {
      if (!fx.linked) { rec(15, 'green', 'SKIP', 'no node_modules'); }
      else {
        git(fx.repo, 'add', '-A');
        const result = runGuard(fx.repo, fx.busRoot);
        rec(15, 'green-honest-commit',
          result.code === 0 && /compile OK \(staged index\)/i.test(result.out) ? 'PASS' : 'FAIL',
          `exit=${result.code} ${result.out}`);
      }
    } finally { await fx.cleanup(); }
  }

  {
    const fx = await fixtureRepo();
    try {
      if (!fx.linked) { rec(15, 'noCheck', 'SKIP', 'no node_modules'); }
      else {
        await stageBrokenThenRestoreWorktree(fx.repo);
        await fsp.writeFile(path.join(fx.repo, 'tsconfig.json'), JSON.stringify({
          compilerOptions: { strict: true, noEmit: true, skipLibCheck: true, types: [], noCheck: true },
          include: ['src']
        }, null, 2));
        git(fx.repo, 'add', 'tsconfig.json');
        const result = runGuard(fx.repo, fx.busRoot);
        rec(15, 'staged-noCheck', 'NOTE',
          `index disabled checking via noCheck. exit=${result.code} ${result.out}`);
      }
    } finally { await fx.cleanup(); }
  }
}

async function main() {
  const head = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: REPO, encoding: 'utf8' }).trim();
  console.log(`HEAD ${head}`);
  await attack13();
  await attack10();
  await attack18();
  await attack15();
  const out = path.join(REPO, 'tmp-audit-r3b-grok-out.json');
  fs.writeFileSync(out, JSON.stringify({ head, results }, null, 2));
  const fail = results.filter((r) => r.status === 'FAIL');
  const pass = results.filter((r) => r.status === 'PASS');
  const note = results.filter((r) => r.status === 'NOTE');
  const skip = results.filter((r) => r.status === 'SKIP');
  console.log(`\nSUMMARY pass=${pass.length} fail=${fail.length} note=${note.length} skip=${skip.length}`);
  for (const row of fail) console.log(`  FAIL ${row.item}/${row.name}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
