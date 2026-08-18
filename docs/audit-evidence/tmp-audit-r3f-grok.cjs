'use strict';
/**
 * Independent AUDIT instrument (grok), this session.
 * Brief named 8ea4c35 / 082ddfa. HEAD is later (373e176). I read src/, attack dist/ + scripts/.
 * Do not edit src/ or tests/. Item 2 left alone.
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
  const row = { item, name, status, detail: String(detail).slice(0, 2500) };
  results.push(row);
  console.log(`[${status}] item ${item} / ${name}: ${row.detail.split('\n')[0]}`);
}

function errMsg(error) {
  return error && error.message ? error.message : String(error);
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
  const merged = { ...process.env, ...env };
  if (!Object.prototype.hasOwnProperty.call(env, 'BUS_ALLOW_BROKEN_BUILD')) {
    delete merged.BUS_ALLOW_BROKEN_BUILD;
  }
  try {
    const stdout = execFileSync(process.execPath, [GUARD, '--repo', repo, '--seat', 'claude', '--root', busRoot], {
      cwd: repo,
      encoding: 'utf8',
      stdio: 'pipe',
      env: merged
    });
    return { code: 0, out: stdout };
  } catch (error) {
    return { code: error.status ?? 1, out: `${error.stdout || ''}${error.stderr || ''}` };
  }
}

async function claimFixture() {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'pab-r3f-13-'));
  const workspace = path.join(dir, 'ws');
  await fsp.mkdir(path.join(workspace, 'src'), { recursive: true });
  await fsp.writeFile(path.join(workspace, 'src', 'bus.ts'), 'x');
  await fsp.writeFile(path.join(workspace, 'README.md'), 'r');
  const busRoot = path.join(dir, 'bus');
  await fsp.mkdir(busRoot, { recursive: true });
  const store = new MailboxStore(busRoot);
  await store.ensureInitialized(['claude', 'codex', 'grok'], 500);
  return {
    dir, workspace, busRoot, store,
    cleanup: () => fsp.rm(dir, { recursive: true, force: true, maxRetries: 8 }).catch(() => {})
  };
}

async function recallFixture() {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'pab-r3f-10-'));
  const store = new MailboxStore(dir);
  await store.ensureInitialized(['claude', 'grok', 'codex'], 500);
  const source = await store.send({
    from: 'claude', to: 'grok', kind: 'task',
    subject: 'ITEM 2 consolidation',
    body: 'PATHS: src/evidence.ts\nGATES: invalidate must not orphan.\nPERMISSION: proceed without a claim.'
  });
  await store.openRecovery('grok', source.seq, 'started');
  return {
    dir, store, source,
    cleanup: () => fsp.rm(dir, { recursive: true, force: true, maxRetries: 8 }).catch(() => {})
  };
}

async function compileFixture(suffix = '') {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), `pab-r3f-15${suffix}-`));
  const repo = path.join(dir, 'repo');
  await fsp.mkdir(path.join(repo, 'src'), { recursive: true });
  await fsp.mkdir(path.join(repo, 'node_modules'), { recursive: true });
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
  const linkedTs = junction(path.join(repo, 'node_modules', 'typescript'), path.join(REPO, 'node_modules', 'typescript'));
  const linkedBin = junction(path.join(repo, 'node_modules', '.bin'), path.join(REPO, 'node_modules', '.bin'));
  const busRoot = path.join(dir, 'bus');
  await fsp.mkdir(path.join(busRoot, '.ai-bus', 'runtime', 'mailbox'), { recursive: true });
  await fsp.writeFile(
    path.join(busRoot, '.ai-bus', 'runtime', 'mailbox', 'state.json'),
    JSON.stringify({ claims: { claude: [{ path: 'src' }, { path: 'tsconfig.json' }] } })
  );
  git(repo, 'add', '-A');
  git(repo, 'commit', '-qm', 'seed');
  return {
    dir, repo, busRoot, linked: linkedTs && linkedBin,
    cleanup: () => fsp.rm(dir, { recursive: true, force: true, maxRetries: 8 }).catch(() => {})
  };
}

async function stageBrokenThenRestoreWorktree(repo) {
  await fsp.writeFile(path.join(repo, 'src', 'index.ts'), 'export const broken: number = "no";\n');
  git(repo, 'add', 'src/index.ts');
  await fsp.writeFile(path.join(repo, 'src', 'index.ts'), 'export const good: number = 1;\n');
}

async function plantLeakConfig(repo, extra = {}) {
  const pkg = path.join(repo, 'node_modules', 'leak-config');
  await fsp.mkdir(pkg, { recursive: true });
  await fsp.writeFile(path.join(pkg, 'package.json'), JSON.stringify({
    name: 'leak-config',
    version: '1.0.0'
  }));
  await fsp.writeFile(path.join(pkg, 'tsconfig.json'), JSON.stringify({
    compilerOptions: { strict: true, noEmit: true, skipLibCheck: true, types: [] },
    include: [path.join(repo, 'src').replace(/\\/g, '/')],
    ...extra
  }, null, 2));
}

async function item13() {
  // symlink rather than junction: path above the root
  {
    const fx = await claimFixture();
    try {
      await fx.store.claim({ agent: 'codex', paths: ['src/bus.ts'], repoRoot: fx.workspace, why: 'hold a file' });
      const above = path.join(fx.workspace, 'above');
      const made = dirSymlink(above, path.dirname(fx.workspace));
      if (!made) {
        rec(13, 'symlink-above-root', 'SKIP', 'could not create directory symlink (privilege?)');
      } else {
        try {
          await fx.store.claim({ agent: 'claude', paths: ['above'], repoRoot: fx.workspace, why: 'symlink above' });
          rec(13, 'symlink-above-root', 'FAIL', 'accepted a directory symlink to the parent of the claim root');
        } catch (error) {
          rec(13, 'symlink-above-root', /whole.repository|too broad|does not exist/i.test(errMsg(error)) ? 'PASS' : 'FAIL', errMsg(error));
        }
        const still = (await fx.store.claims()).codex ?? [];
        rec(13, 'symlink-above-does-not-steal', still.some((c) => c.path.includes('bus.ts')) ? 'PASS' : 'FAIL',
          JSON.stringify(still.map((c) => c.path)));
      }
    } catch (error) {
      rec(13, 'symlink-above-root', 'FAIL', errMsg(error));
    } finally {
      await fx.cleanup();
    }
  }

  // a root that is itself a link
  {
    const fx = await claimFixture();
    try {
      const linkRoot = path.join(fx.dir, 'ws-link');
      const made = junction(linkRoot, fx.workspace) || dirSymlink(linkRoot, fx.workspace);
      if (!made) {
        rec(13, 'root-is-link-file', 'SKIP', 'could not link the workspace');
      } else {
        const held = await fx.store.claim({ agent: 'claude', paths: ['src/bus.ts'], repoRoot: linkRoot, why: 'through link root' });
        rec(13, 'root-is-link-file', held.some((c) => c.path.replace(/\\/g, '/').endsWith('src/bus.ts') || c.path.includes('bus.ts')) ? 'PASS' : 'FAIL',
          JSON.stringify(held.map((c) => ({ path: c.path, root: c.root }))));
        try {
          await fx.store.claim({ agent: 'grok', paths: ['.'], repoRoot: linkRoot, why: 'dot through link root' });
          rec(13, 'root-is-link-dot', 'FAIL', 'accepted "." through a linked root');
        } catch (error) {
          rec(13, 'root-is-link-dot', /whole.repository|too broad/i.test(errMsg(error)) ? 'PASS' : 'FAIL', errMsg(error));
        }
      }
    } catch (error) {
      rec(13, 'root-is-link-file', 'FAIL', errMsg(error));
    } finally {
      await fx.cleanup();
    }
  }

  // case differences on Windows
  {
    const fx = await claimFixture();
    try {
      const held = await fx.store.claim({ agent: 'claude', paths: ['SRC/bus.ts'], repoRoot: fx.workspace, why: 'case' });
      rec(13, 'windows-case', held.some((c) => /bus\.ts/i.test(c.path)) ? 'PASS' : 'FAIL',
        JSON.stringify(held.map((c) => c.path)));
    } catch (error) {
      rec(13, 'windows-case', 'FAIL', errMsg(error));
    } finally {
      await fx.cleanup();
    }
  }

  // path that resolves under a root but whose child junction points at the tree
  {
    const fx = await claimFixture();
    try {
      const portal = path.join(fx.workspace, 'src', 'all');
      const made = junction(portal, fx.workspace);
      if (!made) {
        rec(13, 'child-junction-blocks-tree', 'SKIP', 'could not create src/all junction');
      } else {
        const held = await fx.store.claim({ agent: 'claude', paths: ['src'], repoRoot: fx.workspace, why: 'src with portal child' });
        rec(13, 'claim-src-with-portal-child', held.some((c) => c.path === 'src') ? 'PASS' : 'FAIL',
          JSON.stringify(held.map((c) => c.path)));
        try {
          const other = await fx.store.claim({ agent: 'codex', paths: ['README.md'], repoRoot: fx.workspace, why: 'sibling of src' });
          rec(13, 'child-junction-blocks-tree', other.some((c) => /README/i.test(c.path)) ? 'PASS' : 'FAIL',
            'README claim succeeded — src/all portal did not leak overlap');
        } catch (error) {
          rec(13, 'child-junction-blocks-tree', 'FAIL', `README blocked after claiming src: ${errMsg(error)}`);
        }
        try {
          await fx.store.claim({ agent: 'grok', paths: ['src/all'], repoRoot: fx.workspace, why: 'the portal itself' });
          rec(13, 'claim-portal-equals-root', 'FAIL', 'accepted src/all whose realpath equals the workspace root');
        } catch (error) {
          rec(13, 'claim-portal-equals-root', /whole.repository|too broad/i.test(errMsg(error)) ? 'PASS' : 'FAIL', errMsg(error));
        }
      }
    } catch (error) {
      rec(13, 'child-junction-blocks-tree', 'FAIL', errMsg(error));
    } finally {
      await fx.cleanup();
    }
  }

  // file symlink that escapes
  {
    const fx = await claimFixture();
    try {
      const outside = path.join(fx.dir, 'outside.md');
      await fsp.writeFile(outside, 'out');
      const alias = path.join(fx.workspace, 'alias.md');
      const made = fileSymlink(alias, outside);
      if (!made) {
        rec(13, 'file-symlink-escape', 'SKIP', 'could not create file symlink');
      } else {
        try {
          await fx.store.claim({ agent: 'claude', paths: ['alias.md'], repoRoot: fx.workspace, why: 'file symlink out' });
          rec(13, 'file-symlink-escape', 'FAIL', 'accepted a file symlink whose realpath is outside every claim root');
        } catch (error) {
          rec(13, 'file-symlink-escape', /whole.repository|too broad|does not exist/i.test(errMsg(error)) ? 'PASS' : 'FAIL', errMsg(error));
        }
      }
    } catch (error) {
      rec(13, 'file-symlink-escape', 'FAIL', errMsg(error));
    } finally {
      await fx.cleanup();
    }
  }

  // lexical .. normalises; nonexistent root refuses naming the root
  {
    const fx = await claimFixture();
    try {
      const held = await fx.store.claim({
        agent: 'claude',
        paths: ['src/../src/bus.ts'],
        repoRoot: fx.workspace,
        why: 'normalise'
      });
      rec(13, 'dotdot-normalises', held.some((c) => /bus\.ts/i.test(c.path)) ? 'PASS' : 'FAIL',
        JSON.stringify(held.map((c) => c.path)));
    } catch (error) {
      rec(13, 'dotdot-normalises', 'FAIL', errMsg(error));
    }
    try {
      await fx.store.claim({
        agent: 'grok',
        paths: ['src/bus.ts'],
        repoRoot: path.join(fx.dir, 'missing-root'),
        why: 'missing'
      });
      rec(13, 'missing-root-refuses', 'FAIL', 'accepted a claim against a root that does not exist');
    } catch (error) {
      rec(13, 'missing-root-refuses', /claim root does not exist/i.test(errMsg(error)) ? 'PASS' : 'FAIL', errMsg(error));
    }
    await fx.cleanup();
  }
}

async function item10() {
  // inheritedFrom is metadata, not authority
  {
    const fx = await recallFixture();
    try {
      const moved = await fx.store.reassignBaton({ to: 'codex', reason: 'handoff', force: true });
      rec(10, 'reassign-moves', moved.inheritedWorkId === fx.source.seq ? 'PASS' : 'FAIL', JSON.stringify(moved));
      const pred = await fx.store.recallAssignment('grok', fx.source.seq);
      const succ = await fx.store.recallAssignment('codex', fx.source.seq);
      rec(10, 'inheritedFrom-not-authority', pred === undefined && typeof succ === 'string' && succ.includes('ITEM 2') ? 'PASS' : 'FAIL',
        `pred=${pred === undefined ? 'undef' : 'LEAK'} succ=${succ ? 'brief' : 'undef'}`);
    } catch (error) {
      rec(10, 'inheritedFrom-not-authority', 'FAIL', errMsg(error));
    } finally {
      await fx.cleanup();
    }
  }

  // checkpoint on a different workId
  {
    const fx = await recallFixture();
    try {
      const two = await fx.store.send({
        from: 'claude', to: 'grok', kind: 'task',
        subject: 'other work', body: 'SECRET BRIEF TWO'
      });
      const leaked = await fx.store.recallAssignment('grok', two.seq);
      rec(10, 'other-workId-no-checkpoint', leaked === undefined ? 'PASS' : 'FAIL',
        leaked === undefined ? 'open #1 does not grant #2' : leaked);
      await fx.store.reassignBaton({ to: 'codex', reason: 'move 1', force: true });
      await fx.store.openRecovery('grok', two.seq, 'now on two');
      const resurrected = await fx.store.recallAssignment('grok', fx.source.seq);
      const twoOk = await fx.store.recallAssignment('grok', two.seq);
      rec(10, 'other-workId-does-not-resurrect', resurrected === undefined && typeof twoOk === 'string' ? 'PASS' : 'FAIL',
        `one=${resurrected === undefined ? 'undef' : 'LEAK'} two=${twoOk ? 'brief' : 'undef'}`);
    } catch (error) {
      rec(10, 'other-workId', 'FAIL', errMsg(error));
    } finally {
      await fx.cleanup();
    }
  }

  // reassignBaton twice
  {
    const fx = await recallFixture();
    try {
      await fx.store.reassignBaton({ to: 'codex', reason: 'hop1', force: true });
      await fx.store.reassignBaton({ to: 'claude', reason: 'hop2', force: true });
      const g = await fx.store.recallAssignment('grok', fx.source.seq);
      const x = await fx.store.recallAssignment('codex', fx.source.seq);
      const c = await fx.store.recallAssignment('claude', fx.source.seq);
      rec(10, 'reassign-twice-third-holds', g === undefined && x === undefined && typeof c === 'string' ? 'PASS' : 'FAIL',
        `g=${!!g} x=${!!x} c=${!!c}`);
    } catch (error) {
      rec(10, 'reassign-twice-third-holds', 'FAIL', errMsg(error));
    } finally {
      await fx.cleanup();
    }
  }

  {
    const fx = await recallFixture();
    try {
      await fx.store.reassignBaton({ to: 'codex', reason: 'away', force: true });
      await fx.store.reassignBaton({ to: 'grok', reason: 'back', force: true });
      const g = await fx.store.recallAssignment('grok', fx.source.seq);
      const x = await fx.store.recallAssignment('codex', fx.source.seq);
      rec(10, 'reassign-twice-back-to-first', typeof g === 'string' && x === undefined ? 'PASS' : 'FAIL',
        `g=${!!g} x=${!!x}`);
    } catch (error) {
      rec(10, 'reassign-twice-back-to-first', 'FAIL', errMsg(error));
    } finally {
      await fx.cleanup();
    }
  }

  // predecessor cannot reopen while successor holds
  {
    const fx = await recallFixture();
    try {
      await fx.store.reassignBaton({ to: 'codex', reason: 'move', force: true });
      let refused = false;
      let msg = '';
      try {
        await fx.store.openRecovery('grok', fx.source.seq, 'steal');
      } catch (error) {
        refused = true;
        msg = errMsg(error);
      }
      const brief = refused ? await fx.store.recallAssignment('grok', fx.source.seq) : 'opened';
      rec(10, 'predecessor-cannot-reopen', refused && brief === undefined && /held by codex/i.test(msg) ? 'PASS' : 'FAIL',
        `refused=${refused} msg=${msg} brief=${brief === undefined ? 'undef' : brief}`);
    } catch (error) {
      rec(10, 'predecessor-cannot-reopen', 'FAIL', errMsg(error));
    } finally {
      await fx.cleanup();
    }
  }

  // superseded source is not recalled
  {
    const fx = await recallFixture();
    try {
      const replacement = await fx.store.send({
        from: 'claude', to: 'grok', kind: 'task',
        subject: 'replacement', body: 'NEW BRIEF',
        supersedes: fx.source.seq, supersedeReason: 'retract'
      });
      const recalled = await fx.store.recallAssignment('grok', fx.source.seq);
      rec(10, 'superseded-source-not-recalled',
        replacement.superseded === true && recalled === undefined ? 'PASS' : 'FAIL',
        `superseded=${replacement.superseded} recalled=${recalled === undefined ? 'undef' : recalled}`);
    } catch (error) {
      rec(10, 'superseded-source-not-recalled', 'FAIL', errMsg(error));
    } finally {
      await fx.cleanup();
    }
  }

  // production never recalls
  {
    const src = fs.readFileSync(path.join(REPO, 'src', 'brain', 'bus-client.ts'), 'utf8');
    const dist = fs.readFileSync(path.join(REPO, 'dist', 'brain', 'bus-client.js'), 'utf8');
    const cli = fs.readFileSync(path.join(REPO, 'src', 'brain', 'cli.ts'), 'utf8');
    const runner = fs.readFileSync(path.join(REPO, 'src', 'brain', 'runner.ts'), 'utf8');
    const srcHas = /recallAssignment/.test(src);
    const distHas = /recallAssignment/.test(dist);
    const usesCli = /cliBusClient\(/.test(cli);
    const optional = /if \(bus\.recallAssignment\)/.test(runner);
    rec(10, 'production-cliBusClient-source',
      !srcHas && !distHas && usesCli && optional ? 'FAIL' : (srcHas || distHas ? 'PASS' : 'FAIL'),
      `srcHas=${srcHas} distHas=${distHas} cliUsesCliBusClient=${usesCli} runnerGuards=${optional}`);
    const tmp = path.join(os.tmpdir(), 'pab-r3f-missing-client');
    fs.mkdirSync(tmp, { recursive: true });
    const client = cliBusClient({ root: tmp });
    rec(10, 'production-cliBusClient-instance',
      typeof client.recallAssignment === 'function' ? 'PASS' : 'FAIL',
      `typeof client.recallAssignment = ${typeof client.recallAssignment}`);
  }
}

async function item18() {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'pab-r3f-18-'));
  const store = new MailboxStore(dir);
  await store.ensureInitialized(['claude', 'grok', 'codex'], 500);
  try {
    const original = await store.send({
      from: 'claude', to: 'grok', kind: 'task',
      subject: 'original brief', body: 'DO THE THING'
    });

    // cross-recipient: both verbs refuse; original stays
    let atomicCross = '';
    try {
      await store.send({
        from: 'claude', to: 'codex', kind: 'task',
        subject: 'stolen', body: 'NO',
        supersedes: original.seq, supersedeReason: 'cross'
      });
      rec(18, 'atomic-cross-recipient', 'FAIL', 'atomic send retracted across recipients');
    } catch (error) {
      atomicCross = errMsg(error);
      rec(18, 'atomic-cross-recipient', /sent to grok, not codex|Nothing was sent/i.test(atomicCross) ? 'PASS' : 'FAIL', atomicCross);
    }
    const stillThere = await store.recallAssignment('grok', original.seq).catch(() => 'err');
    // original is unread and has no checkpoint — recall is undefined; check inbox instead
    const inbox = await store.inbox('grok');
    rec(18, 'atomic-cross-leaves-original',
      inbox.some((m) => m.seq === original.seq && m.supersededBy === undefined) ? 'PASS' : 'FAIL',
      `inbox seqs=${inbox.map((m) => `${m.seq}:${m.supersededBy ?? '-'}`).join(',')}`);

    const replacement = await store.send({
      from: 'claude', to: 'codex', kind: 'task', subject: 'other', body: 'other'
    });
    try {
      await store.supersedeMessage(original.seq, replacement.seq, 'claude', 'cross two-step');
      rec(18, 'twostep-cross-recipient', 'FAIL', 'two-step retracted across recipients');
    } catch (error) {
      rec(18, 'twostep-cross-recipient', /addressed to/i.test(errMsg(error)) ? 'PASS' : 'FAIL', errMsg(error));
    }

    // consumed target
    const consumed = await store.send({
      from: 'claude', to: 'grok', kind: 'task', subject: 'read-me', body: 'secret'
    });
    await store.acknowledge('grok', [consumed.seq]);
    const atomicConsumed = await store.send({
      from: 'claude', to: 'grok', kind: 'task',
      subject: 'too late', body: 'correction',
      supersedes: consumed.seq, supersedeReason: 'late'
    });
    rec(18, 'atomic-consumed-no-mark',
      atomicConsumed.superseded === false && atomicConsumed.supersedeOutcome === 'target-consumed' ? 'PASS' : 'FAIL',
      JSON.stringify({ superseded: atomicConsumed.superseded, outcome: atomicConsumed.supersedeOutcome }));
    const reread = await store.readJson
      ? null
      : null;
    const consumedFile = path.join(dir, '.ai-bus', 'runtime', 'mailbox', 'inbox');
    const files = fs.readdirSync(consumedFile).filter((name) => name.includes(`-${consumed.seq}-`) || name.startsWith(`${String(consumed.seq).padStart(4, '0')}`));
    // find the consumed message on disk
    let consumedOnDisk = null;
    for (const name of fs.readdirSync(consumedFile)) {
      const parsed = JSON.parse(fs.readFileSync(path.join(consumedFile, name), 'utf8'));
      if (parsed.seq === consumed.seq) consumedOnDisk = parsed;
    }
    rec(18, 'atomic-consumed-not-marked',
      consumedOnDisk && consumedOnDisk.supersededBy === undefined ? 'PASS' : 'FAIL',
      JSON.stringify(consumedOnDisk && { seq: consumedOnDisk.seq, supersededBy: consumedOnDisk.supersededBy, read: consumedOnDisk.read }));

    const later = await store.send({ from: 'claude', to: 'grok', kind: 'task', subject: 'later', body: 'later' });
    try {
      await store.supersedeMessage(consumed.seq, later.seq, 'claude', 'two-step late');
      rec(18, 'twostep-consumed', 'FAIL', 'two-step marked a read message');
    } catch (error) {
      rec(18, 'twostep-consumed', /already read/i.test(errMsg(error)) ? 'PASS' : 'FAIL', errMsg(error));
    }

    // atomic writes supersededAt
    const live = await store.send({ from: 'claude', to: 'grok', kind: 'task', subject: 'live', body: 'live' });
    const corr = await store.send({
      from: 'claude', to: 'grok', kind: 'task', subject: 'corr', body: 'corr',
      supersedes: live.seq, supersedeReason: 'fix'
    });
    let liveOnDisk = null;
    for (const name of fs.readdirSync(consumedFile)) {
      const parsed = JSON.parse(fs.readFileSync(path.join(consumedFile, name), 'utf8'));
      if (parsed.seq === live.seq) liveOnDisk = parsed;
    }
    rec(18, 'atomic-writes-supersededAt',
      corr.superseded === true && liveOnDisk && typeof liveOnDisk.supersededAt === 'string' && liveOnDisk.supersededAt.length > 0 ? 'PASS' : 'FAIL',
      JSON.stringify(liveOnDisk && { supersededBy: liveOnDisk.supersededBy, supersededAt: liveOnDisk.supersededAt }));

    // empty reason disagreement
    const needReason = await store.send({ from: 'claude', to: 'grok', kind: 'task', subject: 'need-r', body: 'x' });
    const after = await store.send({ from: 'claude', to: 'grok', kind: 'task', subject: 'after', body: 'y' });
    try {
      await store.supersedeMessage(needReason.seq, after.seq, 'claude', '   ');
      rec(18, 'twostep-empty-reason', 'FAIL', 'two-step accepted whitespace reason');
    } catch (error) {
      rec(18, 'twostep-empty-reason', /reason must not be empty/i.test(errMsg(error)) ? 'PASS' : 'NOTE', errMsg(error));
    }
    const wsTarget = await store.send({ from: 'claude', to: 'grok', kind: 'task', subject: 'ws', body: 'ws' });
    const wsAtomic = await store.send({
      from: 'claude', to: 'grok', kind: 'task', subject: 'ws-fix', body: 'ws-fix',
      supersedes: wsTarget.seq, supersedeReason: '   '
    });
    let wsOnDisk = null;
    for (const name of fs.readdirSync(consumedFile)) {
      const parsed = JSON.parse(fs.readFileSync(path.join(consumedFile, name), 'utf8'));
      if (parsed.seq === wsTarget.seq) wsOnDisk = parsed;
    }
    rec(18, 'atomic-whitespace-reason-defaults',
      wsAtomic.superseded === true && wsOnDisk && /superseded by #/.test(wsOnDisk.supersedeReason || '') ? 'NOTE' : 'NOTE',
      `atomic retracted with reason=${wsOnDisk && wsOnDisk.supersedeReason}`);

    // PLAN_SCHEMA reaches a real provider-arg builder
    const args = buildGrokArgs('hello', PLAN_SCHEMA);
    const joined = args.join('\n');
    const schemaIdx = args.indexOf('--json-schema');
    const schemaText = schemaIdx >= 0 ? args[schemaIdx + 1] : '';
    rec(18, 'schema-reaches-buildGrokArgs',
      schemaIdx >= 0 && schemaText.includes('"supersedes"') ? 'PASS' : 'FAIL',
      `args has --json-schema=${schemaIdx >= 0} supersedes-in-payload=${schemaText.includes('"supersedes"')}`);
    const prompt = buildDefaultSystem();
    rec(18, 'prompt-send-line-names-supersedes',
      /supersedes/.test(prompt) ? 'PASS' : 'FAIL',
      prompt.includes('supersedes') ? 'system prompt send line describes the atomic verb' : 'prompt missing supersedes');
  } catch (error) {
    rec(18, 'fixture', 'FAIL', errMsg(error));
  } finally {
    await fsp.rm(dir, { recursive: true, force: true, maxRetries: 8 }).catch(() => {});
  }
}

async function item15() {
  // negative control: staged type error, worktree restored
  {
    const fx = await compileFixture('neg');
    try {
      if (!fx.linked) {
        rec(15, 'negative-control-staged-error', 'SKIP', 'could not junction typescript into the fixture');
      } else {
        await stageBrokenThenRestoreWorktree(fx.repo);
        const result = runGuard(fx.repo, fx.busRoot);
        rec(15, 'negative-control-staged-error',
          result.code !== 0 && /TS2322/.test(result.out) ? 'PASS' : 'FAIL',
          `code=${result.code} out=${result.out.slice(0, 800)}`);
      }
    } catch (error) {
      rec(15, 'negative-control-staged-error', 'FAIL', errMsg(error));
    } finally {
      await fx.cleanup();
    }
  }

  // absolute include into the worktree
  {
    const fx = await compileFixture('absinc');
    try {
      await stageBrokenThenRestoreWorktree(fx.repo);
      await fsp.writeFile(path.join(fx.repo, 'tsconfig.json'), JSON.stringify({
        compilerOptions: { strict: true, noEmit: true, skipLibCheck: true, types: [] },
        include: [path.join(fx.repo, 'src').replace(/\\/g, '/')]
      }, null, 2));
      git(fx.repo, 'add', 'tsconfig.json');
      const result = runGuard(fx.repo, fx.busRoot);
      rec(15, 'absolute-include-refused',
        result.code !== 0 && /OUTSIDE the staged tree|points the compiler OUTSIDE/i.test(result.out) ? 'PASS' : 'FAIL',
        `code=${result.code} out=${result.out.slice(0, 800)}`);
    } catch (error) {
      rec(15, 'absolute-include-refused', 'FAIL', errMsg(error));
    } finally {
      await fx.cleanup();
    }
  }

  // extends untracked worktree-only base
  {
    const fx = await compileFixture('extbase');
    try {
      await stageBrokenThenRestoreWorktree(fx.repo);
      await fsp.writeFile(path.join(fx.repo, 'base.tsconfig.json'), JSON.stringify({
        compilerOptions: { strict: true, noEmit: true, skipLibCheck: true, types: [] },
        include: ['src']
      }));
      await fsp.writeFile(path.join(fx.repo, 'tsconfig.json'), JSON.stringify({
        extends: './base.tsconfig.json',
        compilerOptions: { strict: true }
      }));
      git(fx.repo, 'add', 'tsconfig.json');
      const result = runGuard(fx.repo, fx.busRoot);
      rec(15, 'untracked-extends-base-refused',
        result.code !== 0 && /extends \(missing from the index\)|OUTSIDE/i.test(result.out) ? 'PASS' : 'FAIL',
        `code=${result.code} out=${result.out.slice(0, 800)}`);
    } catch (error) {
      rec(15, 'untracked-extends-base-refused', 'FAIL', errMsg(error));
    } finally {
      await fx.cleanup();
    }
  }

  // hatch
  {
    const fx = await compileFixture('hatch');
    try {
      await stageBrokenThenRestoreWorktree(fx.repo);
      const result = runGuard(fx.repo, fx.busRoot, { BUS_ALLOW_BROKEN_BUILD: '1' });
      rec(15, 'hatch-loud',
        result.code === 0 && /BUS_ALLOW_BROKEN_BUILD=1/.test(result.out) ? 'PASS' : 'FAIL',
        `code=${result.code} out=${result.out.slice(0, 400)}`);
    } catch (error) {
      rec(15, 'hatch-loud', 'FAIL', errMsg(error));
    } finally {
      await fx.cleanup();
    }
  }

  // honest green
  {
    const fx = await compileFixture('green');
    try {
      if (!fx.linked) {
        rec(15, 'honest-green', 'SKIP', 'no typescript junction');
      } else {
        await fsp.writeFile(path.join(fx.repo, 'src', 'index.ts'), 'export const good: number = 2;\n');
        git(fx.repo, 'add', 'src/index.ts');
        const result = runGuard(fx.repo, fx.busRoot);
        rec(15, 'honest-green',
          result.code === 0 && /compile OK \(staged index\)/.test(result.out) ? 'PASS' : 'FAIL',
          `code=${result.code} out=${result.out.slice(0, 600)}`);
      }
    } catch (error) {
      rec(15, 'honest-green', 'FAIL', errMsg(error));
    } finally {
      await fx.cleanup();
    }
  }

  // BARE EXTENDS of a local package whose include is the worktree
  {
    const fx = await compileFixture('bare');
    try {
      if (!fx.linked) {
        rec(15, 'bare-extends-package-include-worktree', 'SKIP', 'no typescript junction');
      } else {
        await plantLeakConfig(fx.repo);
        await stageBrokenThenRestoreWorktree(fx.repo);
        await fsp.writeFile(path.join(fx.repo, 'tsconfig.json'), JSON.stringify({
          extends: 'leak-config/tsconfig.json',
          compilerOptions: { strict: true, noEmit: true, skipLibCheck: true, types: [] }
        }, null, 2));
        git(fx.repo, 'add', 'tsconfig.json');
        const result = runGuard(fx.repo, fx.busRoot);
        rec(15, 'bare-extends-package-include-worktree',
          result.code === 0 && /compile OK/.test(result.out) ? 'FAIL' : (result.code !== 0 ? 'PASS' : 'FAIL'),
          `code=${result.code} out=${result.out.slice(0, 900)}`);
      }
    } catch (error) {
      rec(15, 'bare-extends-package-include-worktree', 'FAIL', errMsg(error));
    } finally {
      await fx.cleanup();
    }
  }

  // same hole, array form
  {
    const fx = await compileFixture('arr');
    try {
      if (!fx.linked) {
        rec(15, 'bare-extends-array-form', 'SKIP', 'no typescript junction');
      } else {
        await plantLeakConfig(fx.repo);
        await stageBrokenThenRestoreWorktree(fx.repo);
        await fsp.writeFile(path.join(fx.repo, 'tsconfig.json'), JSON.stringify({
          extends: ['leak-config/tsconfig.json'],
          compilerOptions: { strict: true, noEmit: true, skipLibCheck: true, types: [] }
        }, null, 2));
        git(fx.repo, 'add', 'tsconfig.json');
        const result = runGuard(fx.repo, fx.busRoot);
        rec(15, 'bare-extends-array-form',
          result.code === 0 && /compile OK/.test(result.out) ? 'FAIL' : (result.code !== 0 ? 'PASS' : 'FAIL'),
          `code=${result.code} out=${result.out.slice(0, 900)}`);
      }
    } catch (error) {
      rec(15, 'bare-extends-array-form', 'FAIL', errMsg(error));
    } finally {
      await fx.cleanup();
    }
  }

  // package-name-only extends
  {
    const fx = await compileFixture('pkg');
    try {
      if (!fx.linked) {
        rec(15, 'bare-extends-package-name-only', 'SKIP', 'no typescript junction');
      } else {
        await plantLeakConfig(fx.repo);
        await stageBrokenThenRestoreWorktree(fx.repo);
        await fsp.writeFile(path.join(fx.repo, 'tsconfig.json'), JSON.stringify({
          extends: 'leak-config',
          compilerOptions: { strict: true, noEmit: true, skipLibCheck: true, types: [] }
        }, null, 2));
        git(fx.repo, 'add', 'tsconfig.json');
        const result = runGuard(fx.repo, fx.busRoot);
        rec(15, 'bare-extends-package-name-only',
          result.code === 0 && /compile OK/.test(result.out) ? 'FAIL' : (result.code !== 0 ? 'PASS' : 'FAIL'),
          `code=${result.code} out=${result.out.slice(0, 900)}`);
      }
    } catch (error) {
      rec(15, 'bare-extends-package-name-only', 'FAIL', errMsg(error));
    } finally {
      await fx.cleanup();
    }
  }

  // contrast: relative extends of the same package IS walked
  {
    const fx = await compileFixture('rel');
    try {
      await plantLeakConfig(fx.repo);
      await stageBrokenThenRestoreWorktree(fx.repo);
      await fsp.writeFile(path.join(fx.repo, 'tsconfig.json'), JSON.stringify({
        extends: './node_modules/leak-config/tsconfig.json',
        compilerOptions: { strict: true, noEmit: true, skipLibCheck: true, types: [] }
      }, null, 2));
      git(fx.repo, 'add', 'tsconfig.json');
      const result = runGuard(fx.repo, fx.busRoot);
      rec(15, 'relative-extends-same-package-refused',
        result.code !== 0 && /include:|OUTSIDE/i.test(result.out) ? 'PASS' : 'FAIL',
        `code=${result.code} out=${result.out.slice(0, 900)}`);
    } catch (error) {
      rec(15, 'relative-extends-same-package-refused', 'FAIL', errMsg(error));
    } finally {
      await fx.cleanup();
    }
  }

  // CONTROL: bare extends, worktree ALSO broken — tsc names the WORKTREE path
  {
    const fx = await compileFixture('ctrl');
    try {
      if (!fx.linked) {
        rec(15, 'bare-extends-control-names-worktree', 'SKIP', 'no typescript junction');
      } else {
        await plantLeakConfig(fx.repo);
        await fsp.writeFile(path.join(fx.repo, 'src', 'index.ts'), 'export const broken: number = "no";\n');
        git(fx.repo, 'add', 'src/index.ts');
        // leave worktree broken too
        await fsp.writeFile(path.join(fx.repo, 'tsconfig.json'), JSON.stringify({
          extends: 'leak-config/tsconfig.json',
          compilerOptions: { strict: true, noEmit: true, skipLibCheck: true, types: [] }
        }, null, 2));
        git(fx.repo, 'add', 'tsconfig.json');
        const result = runGuard(fx.repo, fx.busRoot);
        const namesWorktree = result.out.includes(fx.repo.replace(/\\/g, '\\')) || result.out.includes(fx.repo)
          || result.out.replace(/\//g, '\\').includes(fx.repo);
        rec(15, 'bare-extends-control-names-worktree',
          result.code !== 0 && /TS2322/.test(result.out) && namesWorktree ? 'PASS' : 'FAIL',
          `code=${result.code} namesWorktree=${namesWorktree} out=${result.out.slice(0, 900)}`);
      }
    } catch (error) {
      rec(15, 'bare-extends-control-names-worktree', 'FAIL', errMsg(error));
    } finally {
      await fx.cleanup();
    }
  }

  // NEW: junction portal inside node_modules, include lexically inside scratch
  {
    const fx = await compileFixture('portal');
    try {
      if (!fx.linked) {
        rec(15, 'node_modules-junction-portal', 'SKIP', 'no typescript junction');
      } else {
        const portal = path.join(fx.repo, 'node_modules', 'leak-src');
        const made = junction(portal, path.join(fx.repo, 'src'));
        if (!made) {
          rec(15, 'node_modules-junction-portal', 'SKIP', 'could not junction leak-src -> src');
        } else {
          await stageBrokenThenRestoreWorktree(fx.repo);
          await fsp.writeFile(path.join(fx.repo, 'tsconfig.json'), JSON.stringify({
            compilerOptions: { strict: true, noEmit: true, skipLibCheck: true, types: [] },
            include: ['node_modules/leak-src']
          }, null, 2));
          git(fx.repo, 'add', 'tsconfig.json');
          const result = runGuard(fx.repo, fx.busRoot);
          rec(15, 'node_modules-junction-portal',
            result.code === 0 && /compile OK/.test(result.out) ? 'FAIL' : (result.code !== 0 ? 'PASS' : 'FAIL'),
            `code=${result.code} out=${result.out.slice(0, 900)}`);
        }
      }
    } catch (error) {
      rec(15, 'node_modules-junction-portal', 'FAIL', errMsg(error));
    } finally {
      await fx.cleanup();
    }
  }

  // compilerOptions.paths at the worktree — should already be refused
  {
    const fx = await compileFixture('paths');
    try {
      await stageBrokenThenRestoreWorktree(fx.repo);
      await fsp.writeFile(path.join(fx.repo, 'tsconfig.json'), JSON.stringify({
        compilerOptions: {
          strict: true, noEmit: true, skipLibCheck: true, types: [],
          baseUrl: '.',
          paths: { '@src/*': [path.join(fx.repo, 'src', '*').replace(/\\/g, '/')] }
        },
        include: ['src']
      }, null, 2));
      git(fx.repo, 'add', 'tsconfig.json');
      const result = runGuard(fx.repo, fx.busRoot);
      rec(15, 'paths-absolute-worktree-refused',
        result.code !== 0 && /OUTSIDE|paths/i.test(result.out) ? 'PASS' : 'FAIL',
        `code=${result.code} out=${result.out.slice(0, 800)}`);
    } catch (error) {
      rec(15, 'paths-absolute-worktree-refused', 'FAIL', errMsg(error));
    } finally {
      await fx.cleanup();
    }
  }
}

async function main() {
  rec('meta', 'HEAD', 'NOTE', execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO, encoding: 'utf8' }).trim());
  rec('meta', 'named-commits', 'NOTE', '8ea4c35 082ddfa; later 8b5ae78 rewrote item 15');
  await item13();
  await item10();
  await item18();
  await item15();
  const outPath = path.join(REPO, 'tmp-audit-r3f-grok-out.json');
  fs.writeFileSync(outPath, JSON.stringify({ results }, null, 2));
  const fails = results.filter((r) => r.status === 'FAIL');
  const passes = results.filter((r) => r.status === 'PASS');
  console.log(`\n${passes.length} PASS / ${fails.length} FAIL / ${results.length} rows`);
  console.log(`wrote ${outPath}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
