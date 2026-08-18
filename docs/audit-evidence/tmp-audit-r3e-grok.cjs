'use strict';
/**
 * Independent AUDIT instrument (grok), this session.
 * Brief named 8ea4c35 / 082ddfa. HEAD is later. I read src/, attack dist/ + scripts/.
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
  const row = { item, name, status, detail: String(detail).slice(0, 2200) };
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
  try {
    const stdout = execFileSync(process.execPath, [GUARD, '--repo', repo, '--seat', 'claude', '--root', busRoot], {
      cwd: repo,
      encoding: 'utf8',
      stdio: 'pipe',
      env: { ...process.env, ...env, BUS_ALLOW_BROKEN_BUILD: env.BUS_ALLOW_BROKEN_BUILD }
    });
    return { code: 0, out: stdout };
  } catch (error) {
    return { code: error.status ?? 1, out: `${error.stdout || ''}${error.stderr || ''}` };
  }
}

async function claimFixture() {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'pab-r3e-13-'));
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
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'pab-r3e-10-'));
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

async function compileFixture() {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'pab-r3e-15-'));
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
  git(repo, 'add', '-A');
  await fsp.writeFile(path.join(repo, 'src', 'index.ts'), 'export const good: number = 1;\n');
}

async function plantBareLeak(repo, includeTarget, pkgName = 'leak-config') {
  const pkg = path.join(repo, 'node_modules', pkgName);
  await fsp.mkdir(pkg, { recursive: true });
  await fsp.writeFile(path.join(pkg, 'package.json'), JSON.stringify({
    name: pkgName,
    version: '1.0.0'
  }));
  await fsp.writeFile(path.join(pkg, 'tsconfig.json'), JSON.stringify({
    compilerOptions: { strict: true, noEmit: true, skipLibCheck: true, types: [] },
    include: [includeTarget.replace(/\\/g, '/')]
  }, null, 2));
}

async function inboxBySeq(root, seq) {
  const inbox = path.join(root, '.ai-bus', 'runtime', 'mailbox', 'inbox');
  const files = await fsp.readdir(inbox);
  const padded = String(seq).padStart(6, '0');
  const name = files.find((n) => n.startsWith(`${padded}-`));
  if (!name) throw new Error(`no inbox file for #${seq}: ${files.join(',')}`);
  return JSON.parse(await fsp.readFile(path.join(inbox, name), 'utf8'));
}

async function main() {
  rec('meta', 'head', 'NOTE', execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: REPO, encoding: 'utf8' }).trim());
  rec('meta', 'named-commits', 'NOTE', 'brief named 8ea4c35/082ddfa; HEAD later includes 8b5ae78 item15 rewrite and 8312282 item2');

  // ========================================================================
  // ITEM 13
  // ========================================================================
  {
    const fx = await claimFixture();
    try {
      if (!dirSymlink(path.join(fx.workspace, 'above'), fx.dir)) {
        rec(13, 'symlink-to-parent', 'SKIP', 'directory symlink unavailable');
      } else {
        try {
          await fx.store.claim({ agent: 'codex', paths: ['above'], why: 'symlink parent', repoRoot: fx.workspace });
          rec(13, 'symlink-to-parent', 'FAIL', 'accepted a dir-symlink to the root parent');
        } catch (error) {
          rec(13, 'symlink-to-parent', /whole repositor|too broad/i.test(errMsg(error)) ? 'PASS' : 'FAIL', errMsg(error));
        }
        try {
          await fx.store.claim({ agent: 'claude', paths: ['src/bus.ts'], why: 'still free', repoRoot: fx.workspace });
          rec(13, 'symlink-does-not-lock', 'PASS', 'other seat still claims src/bus.ts');
        } catch (error) {
          rec(13, 'symlink-does-not-lock', 'FAIL', errMsg(error));
        }
      }
    } finally { await fx.cleanup(); }
  }

  {
    const fx = await claimFixture();
    try {
      const linkRoot = path.join(fx.dir, 'ws-link');
      if (!junction(linkRoot, fx.workspace)) {
        rec(13, 'root-is-link', 'SKIP', 'junction unavailable');
      } else {
        try {
          const held = await fx.store.claim({ agent: 'claude', paths: ['src/bus.ts'], why: 'through linked root', repoRoot: linkRoot });
          rec(13, 'root-is-link-child', held && held.length ? 'PASS' : 'FAIL', JSON.stringify(held.map((c) => c.path)));
        } catch (error) {
          rec(13, 'root-is-link-child', 'FAIL', errMsg(error));
        }
        try {
          await fx.store.claim({ agent: 'codex', paths: ['.'], why: 'dot through linked root', repoRoot: linkRoot });
          rec(13, 'root-is-link-dot', 'FAIL', 'accepted . through a linked root');
        } catch (error) {
          rec(13, 'root-is-link-dot', /whole repositor|too broad/i.test(errMsg(error)) ? 'PASS' : 'FAIL', errMsg(error));
        }
      }
    } finally { await fx.cleanup(); }
  }

  {
    const fx = await claimFixture();
    try {
      const held = await fx.store.claim({ agent: 'claude', paths: ['SRC/bus.ts'], why: 'windows case', repoRoot: fx.workspace });
      rec(13, 'windows-case', held && held.length ? 'PASS' : 'FAIL', 'SRC/bus.ts against folder src');
    } catch (error) {
      rec(13, 'windows-case', 'FAIL', errMsg(error));
    } finally { await fx.cleanup(); }
  }

  {
    const fx = await claimFixture();
    try {
      if (!junction(path.join(fx.workspace, 'src', 'all'), fx.workspace)) {
        rec(13, 'under-root-still-blocks', 'SKIP', 'junction unavailable');
      } else {
        try {
          await fx.store.claim({ agent: 'codex', paths: ['src'], why: 'parent of outbound junction', repoRoot: fx.workspace });
          rec(13, 'claim-src-with-outbound-junction', 'PASS', 'claiming src accepted');
        } catch (error) {
          rec(13, 'claim-src-with-outbound-junction', 'FAIL', errMsg(error));
        }
        try {
          await fx.store.claim({ agent: 'claude', paths: ['README.md'], why: 'sibling of src', repoRoot: fx.workspace });
          rec(13, 'src-claim-does-not-block-readme', 'PASS', 'README still claimable');
        } catch (error) {
          rec(13, 'src-claim-does-not-block-readme', 'FAIL', `README blocked: ${errMsg(error)}`);
        }
        try {
          await fx.store.claim({ agent: 'codex', paths: ['src/all'], why: 'junction equals root', repoRoot: fx.workspace });
          rec(13, 'junction-equals-root', 'FAIL', 'accepted src/all whose realpath is the workspace');
        } catch (error) {
          rec(13, 'junction-equals-root', /whole repositor|too broad/i.test(errMsg(error)) ? 'PASS' : 'FAIL', errMsg(error));
        }
      }
    } finally { await fx.cleanup(); }
  }

  {
    const fx = await claimFixture();
    try {
      await fsp.writeFile(path.join(fx.dir, 'outside.md'), 'secret');
      const alias = path.join(fx.workspace, 'alias.md');
      if (!fileSymlink(alias, path.join(fx.dir, 'outside.md'))) {
        rec(13, 'file-symlink-outside', 'SKIP', 'file symlink unavailable');
      } else {
        try {
          await fx.store.claim({ agent: 'codex', paths: ['alias.md'], why: 'file symlink out', repoRoot: fx.workspace });
          rec(13, 'file-symlink-outside', 'FAIL', 'accepted a file symlink whose realpath is outside every claim root');
        } catch (error) {
          rec(13, 'file-symlink-outside', /whole repositor|too broad|does not exist|missing/i.test(errMsg(error)) ? 'PASS' : 'FAIL', errMsg(error));
        }
      }
    } finally { await fx.cleanup(); }
  }

  {
    const fx = await claimFixture();
    try {
      const held = await fx.store.claim({ agent: 'claude', paths: ['src/../src/bus.ts'], why: 'dotdot', repoRoot: fx.workspace });
      rec(13, 'dotdot-normalizes-under-root', held && held.length ? 'PASS' : 'FAIL', JSON.stringify(held.map((c) => c.path)));
    } catch (error) {
      rec(13, 'dotdot-normalizes-under-root', 'FAIL', errMsg(error));
    } finally { await fx.cleanup(); }
  }

  {
    const fx = await claimFixture();
    try {
      await fx.store.claim({ agent: 'claude', paths: ['src/bus.ts'], why: 'missing root', repoRoot: path.join(fx.dir, 'no-such-root') });
      rec(13, 'missing-claim-root', 'FAIL', 'accepted a claim against a root that does not exist');
    } catch (error) {
      rec(13, 'missing-claim-root', /claim root does not exist/i.test(errMsg(error)) ? 'PASS' : 'FAIL', errMsg(error));
    } finally { await fx.cleanup(); }
  }

  // ========================================================================
  // ITEM 10
  // ========================================================================
  {
    const fx = await recallFixture();
    try {
      const moved = await fx.store.reassignBaton({ to: 'codex', reason: 'grok went dark', force: true });
      const pred = await fx.store.recallAssignment('grok', fx.source.seq);
      const succ = await fx.store.recallAssignment('codex', fx.source.seq);
      const raw = await inboxBySeq(fx.dir, fx.source.seq);
      const inherited = (raw.recoveryCheckpoints || []).some((c) => c.seat === 'codex' && c.inheritedFrom === 'grok' && c.status === 'open');
      rec(10, 'inheritedFrom-not-authority',
        inherited && !pred && !!succ ? 'PASS' : 'FAIL',
        `inheritedFrom written=${inherited} pred=${Boolean(pred)} succ=${Boolean(succ)} workId=${moved.inheritedWorkId}`);
    } catch (error) {
      rec(10, 'inheritedFrom-not-authority', 'FAIL', errMsg(error));
    } finally { await fx.cleanup(); }
  }

  {
    const fx = await recallFixture();
    try {
      const two = await fx.store.send({ from: 'claude', to: 'grok', kind: 'task', subject: 'other', body: 'B' });
      const leaked = await fx.store.recallAssignment('grok', two.seq);
      rec(10, 'other-workId-no-checkpoint', leaked === undefined ? 'PASS' : 'FAIL',
        leaked === undefined ? 'open #1 does not grant #2' : 'leaked other work');

      await fx.store.reassignBaton({ to: 'codex', reason: 'move', force: true });
      const afterMove1 = await fx.store.recallAssignment('grok', fx.source.seq);
      const afterMove2 = await fx.store.recallAssignment('grok', two.seq);
      rec(10, 'other-workId-after-move', !afterMove1 && !afterMove2 ? 'PASS' : 'FAIL',
        `after move grok#1=${Boolean(afterMove1)} grok#2=${Boolean(afterMove2)}`);

      await fx.store.openRecovery('grok', two.seq, 'different assignment');
      const resurrected = await fx.store.recallAssignment('grok', fx.source.seq);
      const twoOk = await fx.store.recallAssignment('grok', two.seq);
      rec(10, 'open-other-does-not-resurrect-moved', !resurrected && !!twoOk ? 'PASS' : 'FAIL',
        `open #2 resurrected #1? #1=${Boolean(resurrected)} #2=${Boolean(twoOk)}`);
    } catch (error) {
      rec(10, 'other-workId', 'FAIL', errMsg(error));
    } finally { await fx.cleanup(); }
  }

  {
    const fx = await recallFixture();
    try {
      await fx.store.reassignBaton({ to: 'codex', reason: '1', force: true });
      await fx.store.reassignBaton({ to: 'claude', reason: '2', force: true });
      const g = Boolean(await fx.store.recallAssignment('grok', fx.source.seq));
      const x = Boolean(await fx.store.recallAssignment('codex', fx.source.seq));
      const c = Boolean(await fx.store.recallAssignment('claude', fx.source.seq));
      rec(10, 'reassign-twice-forward', !g && !x && c ? 'PASS' : 'FAIL',
        `grok->codex->claude: grok=${g} codex=${x} claude=${c}`);
    } catch (error) {
      rec(10, 'reassign-twice-forward', 'FAIL', errMsg(error));
    } finally { await fx.cleanup(); }
  }

  {
    const fx = await recallFixture();
    try {
      await fx.store.reassignBaton({ to: 'codex', reason: '1', force: true });
      await fx.store.reassignBaton({ to: 'grok', reason: '2', force: true });
      const g = Boolean(await fx.store.recallAssignment('grok', fx.source.seq));
      const x = Boolean(await fx.store.recallAssignment('codex', fx.source.seq));
      rec(10, 'reassign-twice-back', g && !x ? 'PASS' : 'FAIL',
        `grok->codex->grok: grok=${g} codex=${x}`);
    } catch (error) {
      rec(10, 'reassign-twice-back', 'FAIL', errMsg(error));
    } finally { await fx.cleanup(); }
  }

  {
    const fx = await recallFixture();
    try {
      await fx.store.reassignBaton({ to: 'codex', reason: 'move', force: true });
      try {
        await fx.store.openRecovery('grok', fx.source.seq, 'reopen');
        rec(10, 'predecessor-reopen-while-held', 'FAIL', 'predecessor reopened while successor holds');
      } catch (error) {
        rec(10, 'predecessor-reopen-while-held', /held by/i.test(errMsg(error)) ? 'PASS' : 'FAIL', errMsg(error));
      }
    } finally { await fx.cleanup(); }
  }

  {
    const fx = await recallFixture();
    try {
      const corr = await fx.store.send({
        from: 'claude', to: 'grok', kind: 'task', subject: 'corrected', body: 'new brief',
        supersedes: fx.source.seq, supersedeReason: 'stale'
      });
      const recalled = await fx.store.recallAssignment('grok', fx.source.seq);
      rec(10, 'superseded-source-not-recalled',
        corr.superseded === true && recalled === undefined ? 'PASS' : 'FAIL',
        `atomic.superseded=${corr.superseded} recall=${recalled === undefined ? 'undefined' : 'LEAKED'}`);
    } catch (error) {
      rec(10, 'superseded-source-not-recalled', 'FAIL', errMsg(error));
    } finally { await fx.cleanup(); }
  }

  {
    const src = fs.readFileSync(path.join(REPO, 'src', 'brain', 'bus-client.ts'), 'utf8');
    const dist = fs.readFileSync(path.join(REPO, 'dist', 'brain', 'bus-client.js'), 'utf8');
    const cli = fs.readFileSync(path.join(REPO, 'src', 'brain', 'cli.ts'), 'utf8');
    const runner = fs.readFileSync(path.join(REPO, 'src', 'brain', 'runner.ts'), 'utf8');
    const wired = /recallAssignment/.test(src) || /recallAssignment/.test(dist);
    rec(10, 'production-cliBusClient-source',
      wired ? 'PASS' : 'FAIL',
      `bus-client mentions recallAssignment src=${/recallAssignment/.test(src)} dist=${/recallAssignment/.test(dist)} cliUsesCliBusClient=${/cliBusClient\(/.test(cli)} runnerGuards=${/if \(bus\.recallAssignment\)/.test(runner)}`);
    const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'pab-r3e-10cli-'));
    try {
      const client = cliBusClient({ root: tmp });
      rec(10, 'production-cliBusClient-instance',
        typeof client.recallAssignment === 'function' ? 'PASS' : 'FAIL',
        `typeof client.recallAssignment = ${typeof client.recallAssignment}`);
    } finally {
      await fsp.rm(tmp, { recursive: true, force: true }).catch(() => {});
    }
  }

  // ========================================================================
  // ITEM 18
  // ========================================================================
  {
    const props = PLAN_SCHEMA?.properties?.actions?.items?.properties;
    rec(18, 'schema-has-supersedes',
      props && props.supersedes && props.supersedeReason ? 'PASS' : 'FAIL',
      `supersedes=${JSON.stringify(props?.supersedes)}`);
    const prompt = buildDefaultSystem('claude');
    rec(18, 'prompt-describes-atomic',
      /supersedes/i.test(prompt) ? 'PASS' : 'FAIL',
      /supersedes/i.test(prompt) ? 'system prompt send line mentions supersedes' : 'prompt missing supersedes');
    const args = buildGrokArgs('hello', PLAN_SCHEMA);
    const schemaIdx = args.indexOf('--json-schema');
    const payload = schemaIdx >= 0 ? args[schemaIdx + 1] : '';
    rec(18, 'schema-reaches-grok-cli',
      schemaIdx >= 0 && payload.includes('"supersedes"') ? 'PASS' : 'FAIL',
      schemaIdx >= 0 ? payload.slice(0, 400) : 'no --json-schema in buildGrokArgs');
  }

  {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'pab-r3e-18-'));
    try {
      const store = new MailboxStore(dir);
      await store.ensureInitialized(['claude', 'grok', 'codex'], 500);
      const original = await store.send({ from: 'claude', to: 'grok', kind: 'task', subject: 'orig', body: 'A' });

      let atomicThrew = false;
      let atomicMsg;
      try {
        atomicMsg = await store.send({
          from: 'claude', to: 'codex', kind: 'task', subject: 'wrong seat', body: 'B',
          supersedes: original.seq, supersedeReason: 'cross'
        });
      } catch (error) {
        atomicThrew = /sent to grok, not codex|same recipient/i.test(errMsg(error));
        if (!atomicThrew) rec(18, 'atomic-cross-recipient', 'FAIL', errMsg(error));
      }
      const still = await inboxBySeq(dir, original.seq);
      rec(18, 'atomic-cross-recipient',
        atomicThrew && !atomicMsg && still.supersededBy === undefined ? 'PASS' : 'FAIL',
        `threw=${atomicThrew} sent=${Boolean(atomicMsg)} original.supersededBy=${still.supersededBy}`);

      const replacement = await store.send({ from: 'claude', to: 'codex', kind: 'task', subject: 'other seat', body: 'C' });
      try {
        await store.supersedeMessage(original.seq, replacement.seq, 'cross two-step', 'claude');
        rec(18, 'twostep-cross-recipient', 'FAIL', 'two-step retracted a cross-recipient target');
      } catch (error) {
        rec(18, 'twostep-cross-recipient', /addressed to/i.test(errMsg(error)) ? 'PASS' : 'FAIL', errMsg(error));
      }
    } finally {
      await fsp.rm(dir, { recursive: true, force: true, maxRetries: 8 }).catch(() => {});
    }
  }

  {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'pab-r3e-18c-'));
    try {
      const store = new MailboxStore(dir);
      await store.ensureInitialized(['claude', 'grok'], 500);
      const original = await store.send({ from: 'claude', to: 'grok', kind: 'task', subject: 'orig', body: 'A' });
      await store.read('grok');
      const corr = await store.send({
        from: 'claude', to: 'grok', kind: 'task', subject: 'late', body: 'B',
        supersedes: original.seq, supersedeReason: 'too late'
      });
      const afterAtomic = await inboxBySeq(dir, original.seq);
      rec(18, 'atomic-consumed-no-mark',
        corr.superseded === false && corr.supersedeOutcome === 'target-consumed' && afterAtomic.supersededBy === undefined
          ? 'PASS' : 'FAIL',
        `superseded=${corr.superseded} outcome=${corr.supersedeOutcome} marked=${afterAtomic.supersededBy}`);

      const later = await store.send({ from: 'claude', to: 'grok', kind: 'task', subject: 'later', body: 'C' });
      try {
        await store.supersedeMessage(original.seq, later.seq, 'too late two-step', 'claude');
        rec(18, 'twostep-consumed-refuses', 'FAIL', 'two-step marked a read message');
      } catch (error) {
        rec(18, 'twostep-consumed-refuses', /already read/i.test(errMsg(error)) ? 'PASS' : 'FAIL', errMsg(error));
      }
    } finally {
      await fsp.rm(dir, { recursive: true, force: true, maxRetries: 8 }).catch(() => {});
    }
  }

  {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'pab-r3e-18t-'));
    try {
      const store = new MailboxStore(dir);
      await store.ensureInitialized(['claude', 'grok'], 500);
      const original = await store.send({ from: 'claude', to: 'grok', kind: 'task', subject: 'orig', body: 'A' });
      const corr = await store.send({
        from: 'claude', to: 'grok', kind: 'task', subject: 'fix', body: 'B',
        supersedes: original.seq, supersedeReason: 'rewrite'
      });
      const marked = await inboxBySeq(dir, original.seq);
      rec(18, 'atomic-writes-supersededAt',
        corr.superseded === true && typeof marked.supersededAt === 'string' && marked.supersededBy === corr.seq
          ? 'PASS' : 'FAIL',
        `supersededAt=${marked.supersededAt} by=${marked.supersededBy}`);
    } finally {
      await fsp.rm(dir, { recursive: true, force: true, maxRetries: 8 }).catch(() => {});
    }
  }

  {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'pab-r3e-18e-'));
    try {
      const store = new MailboxStore(dir);
      await store.ensureInitialized(['claude', 'grok'], 500);
      const original = await store.send({ from: 'claude', to: 'grok', kind: 'task', subject: 'orig', body: 'A' });
      const corr = await store.send({
        from: 'claude', to: 'grok', kind: 'task', subject: 'fix', body: 'B',
        supersedes: original.seq, supersedeReason: '   '
      });
      const marked = await inboxBySeq(dir, original.seq);
      rec(18, 'atomic-empty-reason-defaults',
        corr.superseded === true && typeof marked.supersedeReason === 'string' && marked.supersedeReason.length > 0
          ? 'NOTE' : 'FAIL',
        `reason=${JSON.stringify(marked.supersedeReason)}`);
      const two = await store.send({ from: 'claude', to: 'grok', kind: 'task', subject: 'two', body: 'C' });
      const three = await store.send({ from: 'claude', to: 'grok', kind: 'task', subject: 'three', body: 'D' });
      try {
        await store.supersedeMessage(two.seq, three.seq, '   ', 'claude');
        rec(18, 'twostep-empty-reason-refuses', 'NOTE', 'two-step accepted whitespace reason');
      } catch (error) {
        rec(18, 'twostep-empty-reason-refuses', 'NOTE', errMsg(error));
      }
    } finally {
      await fsp.rm(dir, { recursive: true, force: true, maxRetries: 8 }).catch(() => {});
    }
  }

  // ========================================================================
  // ITEM 15
  // ========================================================================
  {
    const fx = await compileFixture();
    try {
      if (!fx.linked) {
        rec(15, 'fixture-typescript', 'FAIL', 'could not junction this repo typescript into the fixture');
      } else {
        const honest = runGuard(fx.repo, fx.busRoot);
        rec(15, 'honest-commit-green', honest.code === 0 && /compile OK \(staged index\)/.test(honest.out) ? 'PASS' : 'FAIL',
          `code=${honest.code} ${honest.out.slice(0, 400)}`);

        await fsp.writeFile(path.join(fx.repo, 'src', 'index.ts'), 'export const broken: number = "no";\n');
        git(fx.repo, 'add', '-A');
        const red = runGuard(fx.repo, fx.busRoot);
        rec(15, 'staged-type-error-red', red.code === 1 && /TS2322/.test(red.out) ? 'PASS' : 'FAIL',
          `code=${red.code} ${red.out.slice(0, 600)}`);
        git(fx.repo, 'checkout', '--', 'src/index.ts');
      }
    } finally { await fx.cleanup(); }
  }

  {
    const fx = await compileFixture();
    try {
      await stageBrokenThenRestoreWorktree(fx.repo);
      const abs = path.resolve(fx.repo, 'src').replace(/\\/g, '/');
      await fsp.writeFile(path.join(fx.repo, 'tsconfig.json'), JSON.stringify({
        compilerOptions: { strict: true, noEmit: true, skipLibCheck: true, types: [] },
        include: [abs]
      }, null, 2));
      git(fx.repo, 'add', 'tsconfig.json');
      const r = runGuard(fx.repo, fx.busRoot);
      rec(15, 'absolute-include-refused', r.code === 1 && /OUTSIDE the staged tree|include:/i.test(r.out) ? 'PASS' : 'FAIL',
        `code=${r.code} ${r.out.slice(0, 700)}`);
    } finally { await fx.cleanup(); }
  }

  {
    const fx = await compileFixture();
    try {
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
      const r = runGuard(fx.repo, fx.busRoot);
      rec(15, 'worktree-only-extends-refused', r.code === 1 && /extends/i.test(r.out) ? 'PASS' : 'FAIL',
        `code=${r.code} ${r.out.slice(0, 700)}`);
    } finally { await fx.cleanup(); }
  }

  {
    const fx = await compileFixture();
    try {
      await stageBrokenThenRestoreWorktree(fx.repo);
      await fsp.writeFile(path.join(fx.repo, 'tsconfig.json'), JSON.stringify({
        compilerOptions: {
          strict: true, noEmit: true, skipLibCheck: true, types: [],
          baseUrl: '.',
          paths: { '@w/*': [path.resolve(fx.repo, 'src', '*').replace(/\\/g, '/')] }
        },
        include: ['src']
      }, null, 2));
      git(fx.repo, 'add', 'tsconfig.json');
      const r = runGuard(fx.repo, fx.busRoot);
      rec(15, 'paths-escape-refused', r.code === 1 && /paths/i.test(r.out) ? 'PASS' : 'FAIL',
        `code=${r.code} ${r.out.slice(0, 700)}`);
    } finally { await fx.cleanup(); }
  }

  {
    const fx = await compileFixture();
    try {
      await fsp.writeFile(path.join(fx.repo, 'src', 'index.ts'), 'export const broken: number = "no";\n');
      git(fx.repo, 'add', '-A');
      const r = runGuard(fx.repo, fx.busRoot, { BUS_ALLOW_BROKEN_BUILD: '1' });
      rec(15, 'hatch-skips-loudly', r.code === 0 && /BUS_ALLOW_BROKEN_BUILD=1/.test(r.out) ? 'PASS' : 'FAIL',
        `code=${r.code} ${r.out.slice(0, 400)}`);
    } finally { await fx.cleanup(); }
  }

  {
    const fx = await compileFixture();
    try {
      await stageBrokenThenRestoreWorktree(fx.repo);
      await plantBareLeak(fx.repo, path.resolve(fx.repo, 'src'));
      await fsp.writeFile(path.join(fx.repo, 'tsconfig.json'), JSON.stringify({
        extends: 'leak-config/tsconfig.json'
      }, null, 2));
      git(fx.repo, 'add', 'tsconfig.json');
      const r = runGuard(fx.repo, fx.busRoot);
      rec(15, 'bare-extends-package', r.code === 0 ? 'FAIL' : 'PASS',
        `code=${r.code} ${r.out.slice(0, 800)}`);
    } finally { await fx.cleanup(); }
  }

  {
    const fx = await compileFixture();
    try {
      await stageBrokenThenRestoreWorktree(fx.repo);
      await plantBareLeak(fx.repo, path.resolve(fx.repo, 'src'));
      await fsp.writeFile(path.join(fx.repo, 'tsconfig.json'), JSON.stringify({
        extends: ['leak-config/tsconfig.json']
      }, null, 2));
      git(fx.repo, 'add', 'tsconfig.json');
      const r = runGuard(fx.repo, fx.busRoot);
      rec(15, 'bare-extends-array', r.code === 0 ? 'FAIL' : 'PASS',
        `code=${r.code} ${r.out.slice(0, 800)}`);
    } finally { await fx.cleanup(); }
  }

  {
    const fx = await compileFixture();
    try {
      await stageBrokenThenRestoreWorktree(fx.repo);
      await plantBareLeak(fx.repo, path.resolve(fx.repo, 'src'));
      await fsp.writeFile(path.join(fx.repo, 'tsconfig.json'), JSON.stringify({
        extends: './node_modules/leak-config/tsconfig.json'
      }, null, 2));
      git(fx.repo, 'add', 'tsconfig.json');
      const r = runGuard(fx.repo, fx.busRoot);
      rec(15, 'relative-extends-same-package-refused', r.code === 1 && /include:|OUTSIDE/i.test(r.out) ? 'PASS' : 'FAIL',
        `code=${r.code} ${r.out.slice(0, 800)}`);
    } finally { await fx.cleanup(); }
  }

  {
    const fx = await compileFixture();
    try {
      await stageBrokenThenRestoreWorktree(fx.repo);
      await plantBareLeak(fx.repo, path.resolve(fx.repo, 'src'), 'leak-config');
      await fsp.writeFile(path.join(fx.repo, 'tsconfig.json'), JSON.stringify({
        extends: 'leak-config'
      }, null, 2));
      git(fx.repo, 'add', 'tsconfig.json');
      const r = runGuard(fx.repo, fx.busRoot);
      rec(15, 'bare-extends-package-name-only', r.code === 0 ? 'FAIL' : 'PASS',
        `code=${r.code} ${r.out.slice(0, 800)}`);
    } finally { await fx.cleanup(); }
  }

  {
    const fx = await compileFixture();
    try {
      await stageBrokenThenRestoreWorktree(fx.repo);
      const worktreeIndex = path.resolve(fx.repo, 'src', 'index.ts').replace(/\\/g, '/');
      await fsp.writeFile(path.join(fx.repo, 'src', 'ok.ts'), `/// <reference path="${worktreeIndex}" />\nexport const fine: number = 1;\n`);
      await fsp.writeFile(path.join(fx.repo, 'tsconfig.json'), JSON.stringify({
        compilerOptions: { strict: true, noEmit: true, skipLibCheck: true, types: [] },
        include: ['src/ok.ts']
      }, null, 2));
      git(fx.repo, 'add', '-A');
      const r = runGuard(fx.repo, fx.busRoot);
      rec(15, 'triple-slash-to-worktree', r.code === 0 ? 'FAIL' : 'PASS',
        `code=${r.code} ${r.out.slice(0, 800)}`);
    } finally { await fx.cleanup(); }
  }

  const fails = results.filter((r) => r.status === 'FAIL');
  const passes = results.filter((r) => r.status === 'PASS');
  rec('meta', 'summary', fails.length ? 'FAIL' : 'PASS',
    `${passes.length} PASS, ${fails.length} FAIL, ${results.filter((r) => r.status === 'SKIP').length} SKIP, ${results.filter((r) => r.status === 'NOTE').length} NOTE`);

  const outPath = path.join(REPO, 'tmp-audit-r3e-grok-out.json');
  fs.writeFileSync(outPath, JSON.stringify({ head: results[0], results, fails }, null, 2));
  console.log(`wrote ${outPath}`);
  process.exit(fails.length ? 2 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
