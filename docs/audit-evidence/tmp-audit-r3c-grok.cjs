'use strict';
/**
 * Independent AUDIT instrument (grok). Repo-root probe only. Does not edit src/ or tests/.
 * Attacks current HEAD. Named commits were 8ea4c35 / 082ddfa; item 15 was later
 * rewritten at 8b5ae78. Item 2 is left alone.
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
  const row = { item, name, status, detail: String(detail).slice(0, 1500) };
  results.push(row);
  console.log(`[${status}] item ${item} / ${name}: ${row.detail}`);
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

async function claimFixture() {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'pab-r3c-13-'));
  const workspace = path.join(dir, 'ws');
  await fsp.mkdir(path.join(workspace, 'src'), { recursive: true });
  await fsp.writeFile(path.join(workspace, 'src', 'bus.ts'), 'x');
  await fsp.writeFile(path.join(workspace, 'README.md'), 'r');
  const busRoot = path.join(dir, 'bus');
  await fsp.mkdir(busRoot, { recursive: true });
  const store = new MailboxStore(busRoot);
  await store.ensureInitialized(['claude', 'codex'], 500);
  return {
    dir, workspace, busRoot, store,
    cleanup: () => fsp.rm(dir, { recursive: true, force: true, maxRetries: 8 }).catch(() => {})
  };
}

async function recallFixture() {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'pab-r3c-10-'));
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

async function fixtureRepo() {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'pab-r3c-15-'));
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
  await fsp.mkdir(path.join(busRoot, '.ai-bus', 'runtime', 'mailbox'), { recursive: true });
  await fsp.writeFile(
    path.join(busRoot, '.ai-bus', 'runtime', 'mailbox', 'state.json'),
    JSON.stringify({ claims: { claude: [{ path: 'src' }, { path: 'tsconfig.json' }] } })
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

async function main() {
  rec('meta', 'head', 'NOTE', execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO, encoding: 'utf8' }).trim());

  // ========================================================================
  // ITEM 13 — named attacks
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
          rec(13, 'symlink-does-not-lock', 'PASS', 'other seat still claims');
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
          rec(13, 'root-is-link-child', held && held.length ? 'PASS' : 'FAIL', 'child claim through linked root');
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
          rec(13, 'src-claim-does-not-block-readme', 'PASS', 'README still claimable — walk stayed under src');
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

  // ========================================================================
  // ITEM 10 — named attacks + production caller
  // ========================================================================
  {
    const fx = await recallFixture();
    try {
      const moved = await fx.store.reassignBaton({ to: 'codex', reason: 'grok went dark', force: true });
      const pred = await fx.store.recallAssignment('grok', fx.source.seq);
      const succ = await fx.store.recallAssignment('codex', fx.source.seq);
      const raw = JSON.parse(await fsp.readFile(
        path.join(fx.dir, '.ai-bus', 'runtime', 'mailbox', 'inbox',
          (await fsp.readdir(path.join(fx.dir, '.ai-bus', 'runtime', 'mailbox', 'inbox')))
            .find((n) => n.includes(`-${fx.source.seq}-`) || n.startsWith(String(fx.source.seq).padStart(6, '0')))),
        'utf8'
      ));
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
    const src = fs.readFileSync(path.join(REPO, 'src', 'brain', 'bus-client.ts'), 'utf8');
    const dist = fs.readFileSync(path.join(REPO, 'dist', 'brain', 'bus-client.js'), 'utf8');
    const cli = fs.readFileSync(path.join(REPO, 'src', 'brain', 'cli.ts'), 'utf8');
    const runner = fs.readFileSync(path.join(REPO, 'src', 'brain', 'runner.ts'), 'utf8');
    const wired = /recallAssignment/.test(src) || /recallAssignment/.test(dist);
    const usesCli = /cliBusClient\(/.test(cli);
    const optional = /if \(bus\.recallAssignment\)/.test(runner);
    rec(10, 'production-cliBusClient-source',
      wired ? 'PASS' : 'FAIL',
      `bus-client mentions recallAssignment src=${/recallAssignment/.test(src)} dist=${/recallAssignment/.test(dist)} cliUsesCliBusClient=${usesCli} runnerGuards=${optional}`);
    const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'pab-r3c-10cli-'));
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
      /send may also carry supersedes/i.test(prompt) && /ONE step|one step/i.test(prompt) ? 'PASS' : 'FAIL',
      'system prompt names atomic retract');
    const args = buildGrokArgs('hello', PLAN_SCHEMA);
    const schemaArg = args.includes('--json-schema') ? args[args.indexOf('--json-schema') + 1] : '';
    rec(18, 'schema-reaches-buildGrokArgs',
      args.includes('--json-schema') && /"supersedes"\s*:\s*\{\s*"type"\s*:\s*"number"/.test(schemaArg) ? 'PASS' : 'FAIL',
      `flags=${args.filter((a) => a.startsWith('--')).join(',')} schemaHasSupersedes=${/"supersedes"/.test(schemaArg)}`);
  }

  {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'pab-r3c-18-'));
    try {
      const store = new MailboxStore(dir);
      await store.ensureInitialized(['claude', 'grok', 'codex'], 500);
      const original = await store.send({ from: 'claude', to: 'grok', kind: 'task', subject: 'do X', body: 'X' });
      try {
        await store.send({ from: 'claude', to: 'codex', kind: 'task', subject: 'Y', body: 'Y', supersedes: original.seq });
        rec(18, 'atomic-cross-recipient', 'FAIL', 'atomic sent a cross-recipient retract');
      } catch (error) {
        const inbox = await store.inbox('grok');
        rec(18, 'atomic-cross-recipient',
          /sent to grok, not codex/i.test(errMsg(error)) && inbox.length === 1 && inbox[0].seq === original.seq ? 'PASS' : 'FAIL',
          errMsg(error));
      }
      const replacement = await store.send({ from: 'claude', to: 'codex', kind: 'task', subject: 'Y', body: 'Y' });
      try {
        await store.supersedeMessage(original.seq, replacement.seq, 'redirect', 'claude');
        rec(18, 'twostep-cross-recipient', 'FAIL', 'two-step allowed cross-recipient');
      } catch (error) {
        rec(18, 'twostep-cross-recipient', /addressed to/i.test(errMsg(error)) ? 'PASS' : 'FAIL', errMsg(error));
      }
    } finally {
      await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  }

  {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'pab-r3c-18c-'));
    try {
      const store = new MailboxStore(dir);
      await store.ensureInitialized(['claude', 'grok'], 500);
      const original = await store.send({ from: 'claude', to: 'grok', kind: 'task', subject: 'do X', body: 'X' });
      await store.acknowledge('grok', [original.seq]);
      const atomic = await store.send({
        from: 'claude', to: 'grok', kind: 'task', subject: 'Y', body: 'Y', supersedes: original.seq
      });
      rec(18, 'atomic-consumed-policy',
        atomic.superseded === false && atomic.supersedeOutcome === 'target-consumed' && original.supersededBy === undefined ? 'PASS' : 'FAIL',
        `superseded=${atomic.superseded} outcome=${atomic.supersedeOutcome}`);
      const later = await store.send({ from: 'claude', to: 'grok', kind: 'task', subject: 'Z', body: 'Z' });
      try {
        await store.supersedeMessage(original.seq, later.seq, 'too late', 'claude');
        rec(18, 'twostep-consumed-policy', 'FAIL', 'two-step marked a read message');
      } catch (error) {
        rec(18, 'twostep-consumed-policy', /already read/i.test(errMsg(error)) ? 'PASS' : 'FAIL', errMsg(error));
      }
    } finally {
      await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  }

  {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'pab-r3c-18t-'));
    try {
      const store = new MailboxStore(dir);
      await store.ensureInitialized(['claude', 'grok'], 500);
      const original = await store.send({ from: 'claude', to: 'grok', kind: 'task', subject: 'stale', body: 'old' });
      const correction = await store.send({
        from: 'claude', to: 'grok', kind: 'task', subject: 'fresh', body: 'new',
        supersedes: original.seq, supersedeReason: 'settled already'
      });
      const inboxDir = path.join(dir, '.ai-bus', 'runtime', 'mailbox', 'inbox');
      const name = (await fsp.readdir(inboxDir)).find((n) => n.includes(`-${original.seq}-`) || n.startsWith(String(original.seq).padStart(6, '0')));
      const raw = JSON.parse(await fsp.readFile(path.join(inboxDir, name), 'utf8'));
      rec(18, 'atomic-writes-supersededAt',
        correction.superseded === true && raw.supersededBy === correction.seq && !!raw.supersededAt ? 'PASS' : 'FAIL',
        `supersededAt=${raw.supersededAt} by=${raw.supersededBy}`);
    } finally {
      await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  }

  {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'pab-r3c-18r-'));
    try {
      const store = new MailboxStore(dir);
      await store.ensureInitialized(['claude', 'grok'], 500);
      const original = await store.send({ from: 'claude', to: 'grok', kind: 'task', subject: 'A', body: 'A' });
      const atomic = await store.send({
        from: 'claude', to: 'grok', kind: 'task', subject: 'B', body: 'B',
        supersedes: original.seq, supersedeReason: '   '
      });
      rec(18, 'atomic-whitespace-reason',
        atomic.superseded === true ? 'NOTE' : 'FAIL',
        'atomic defaults whitespace reason and still retracts');
      const second = await store.send({ from: 'claude', to: 'grok', kind: 'task', subject: 'C', body: 'C' });
      const third = await store.send({ from: 'claude', to: 'grok', kind: 'task', subject: 'D', body: 'D' });
      try {
        await store.supersedeMessage(second.seq, third.seq, '   ', 'claude');
        rec(18, 'twostep-empty-reason', 'FAIL', 'two-step accepted whitespace reason');
      } catch (error) {
        rec(18, 'twostep-empty-reason', /must not be empty/i.test(errMsg(error)) ? 'NOTE' : 'FAIL', errMsg(error));
      }
    } finally {
      await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  }

  // ========================================================================
  // ITEM 15 — can a commit that does not compile still land?
  // ========================================================================
  {
    const fx = await fixtureRepo();
    try {
      if (!fx.linked) rec(15, 'negative-control', 'SKIP', 'no node_modules junction');
      else {
        await fsp.writeFile(path.join(fx.repo, 'src', 'index.ts'), 'export const broken: number = "no";\n');
        git(fx.repo, 'add', '-A');
        const result = runGuard(fx.repo, fx.busRoot);
        rec(15, 'negative-control',
          result.code === 1 && /TS2322|does not compile/i.test(result.out) ? 'PASS' : 'FAIL',
          `exit=${result.code} ${result.out}`);
      }
    } finally { await fx.cleanup(); }
  }

  {
    const fx = await fixtureRepo();
    try {
      if (!fx.linked) rec(15, 'absolute-include', 'SKIP', 'no node_modules');
      else {
        await stageBrokenThenRestoreWorktree(fx.repo);
        await fsp.writeFile(path.join(fx.repo, 'tsconfig.json'), JSON.stringify({
          compilerOptions: { strict: true, noEmit: true, skipLibCheck: true, types: [] },
          include: [path.join(fx.repo, 'src').replace(/\\/g, '/')]
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
      if (!fx.linked) rec(15, 'extends-worktree-only', 'SKIP', 'no node_modules');
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

  // Attack: bare extends of a local package whose include is the WORKTREE src.
  // The walker skips non-relative extends. tsc then compiles the good worktree copy.
  {
    const fx = await fixtureRepo();
    try {
      if (!fx.linked) rec(15, 'bare-extends', 'SKIP', 'no node_modules');
      else {
        await stageBrokenThenRestoreWorktree(fx.repo);
        await fsp.rm(path.join(fx.repo, 'node_modules'), { recursive: true, force: true });
        await fsp.mkdir(path.join(fx.repo, 'node_modules', 'leak-config'), { recursive: true });
        const okTs = junction(path.join(fx.repo, 'node_modules', 'typescript'),
          path.join(REPO, 'node_modules', 'typescript'));
        const okBin = junction(path.join(fx.repo, 'node_modules', '.bin'),
          path.join(REPO, 'node_modules', '.bin'));
        const abs = path.resolve(fx.repo, 'src').replace(/\\/g, '/');
        await fsp.writeFile(path.join(fx.repo, 'node_modules', 'leak-config', 'package.json'),
          JSON.stringify({ name: 'leak-config', version: '1.0.0' }));
        await fsp.writeFile(path.join(fx.repo, 'node_modules', 'leak-config', 'tsconfig.json'), JSON.stringify({
          compilerOptions: { strict: true, noEmit: true, skipLibCheck: true, types: [] },
          include: [abs]
        }, null, 2));
        await fsp.writeFile(path.join(fx.repo, 'tsconfig.json'), JSON.stringify({
          extends: 'leak-config/tsconfig.json'
        }, null, 2));
        git(fx.repo, 'add', 'tsconfig.json');
        const result = runGuard(fx.repo, fx.busRoot);
        rec(15, 'bare-extends-package-include-worktree',
          result.code === 0 ? 'FAIL' : (/OUTSIDE|extends/i.test(result.out) ? 'PASS' : 'NOTE'),
          `linked ts=${okTs} bin=${okBin}. exit=${result.code} ${result.out}`);
      }
    } finally { await fx.cleanup(); }
  }

  // Control for the same attack: worktree ALSO broken. If tsc reads the worktree, this must go red.
  {
    const fx = await fixtureRepo();
    try {
      if (!fx.linked) rec(15, 'bare-extends-control', 'SKIP', 'no node_modules');
      else {
        await fsp.writeFile(path.join(fx.repo, 'src', 'index.ts'), 'export const broken: number = "no";\n');
        git(fx.repo, 'add', '-A');
        await fsp.rm(path.join(fx.repo, 'node_modules'), { recursive: true, force: true });
        await fsp.mkdir(path.join(fx.repo, 'node_modules', 'leak-config'), { recursive: true });
        junction(path.join(fx.repo, 'node_modules', 'typescript'), path.join(REPO, 'node_modules', 'typescript'));
        junction(path.join(fx.repo, 'node_modules', '.bin'), path.join(REPO, 'node_modules', '.bin'));
        const abs = path.resolve(fx.repo, 'src').replace(/\\/g, '/');
        await fsp.writeFile(path.join(fx.repo, 'node_modules', 'leak-config', 'package.json'),
          JSON.stringify({ name: 'leak-config', version: '1.0.0' }));
        await fsp.writeFile(path.join(fx.repo, 'node_modules', 'leak-config', 'tsconfig.json'), JSON.stringify({
          compilerOptions: { strict: true, noEmit: true, skipLibCheck: true, types: [] },
          include: [abs]
        }, null, 2));
        await fsp.writeFile(path.join(fx.repo, 'tsconfig.json'), JSON.stringify({
          extends: 'leak-config/tsconfig.json'
        }, null, 2));
        git(fx.repo, 'add', 'tsconfig.json');
        const result = runGuard(fx.repo, fx.busRoot);
        rec(15, 'bare-extends-worktree-also-broken',
          result.code === 1 ? 'NOTE' : 'NOTE',
          `if this is red and the previous is green, tsc compiled the worktree. exit=${result.code} ${result.out}`);
      }
    } finally { await fx.cleanup(); }
  }

  // Project references: walker checks references[].path (inside scratch) and does not walk
  // the referenced tsconfig. Distinguish empty-program (files:[]) from worktree compile.
  {
    const fx = await fixtureRepo();
    try {
      if (!fx.linked) rec(15, 'reference-escape', 'SKIP', 'no node_modules');
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
          result.code === 0 ? 'NOTE' : (/OUTSIDE/i.test(result.out) ? 'PASS' : 'NOTE'),
          `exit=${result.code} ${result.out}`);
      }
    } finally { await fx.cleanup(); }
  }

  {
    const fx = await fixtureRepo();
    try {
      if (!fx.linked) rec(15, 'reference-empty-program', 'SKIP', 'no node_modules');
      else {
        // Do NOT restore the worktree: src is broken on disk too.
        await fsp.writeFile(path.join(fx.repo, 'src', 'index.ts'), 'export const broken: number = "no";\n');
        git(fx.repo, 'add', '-A');
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
        rec(15, 'reference-empty-program-worktree-broken',
          result.code === 0 ? 'NOTE' : 'NOTE',
          `if this is also green, tsc -p did not build the referenced project (declared narrow files:[]). exit=${result.code} ${result.out}`);
      }
    } finally { await fx.cleanup(); }
  }

  {
    const fx = await fixtureRepo();
    try {
      if (!fx.linked) rec(15, 'hatch', 'SKIP', 'no node_modules');
      else {
        await fsp.writeFile(path.join(fx.repo, 'src', 'index.ts'), 'export const broken: number = "no";\n');
        git(fx.repo, 'add', '-A');
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
      if (!fx.linked) rec(15, 'green', 'SKIP', 'no node_modules');
      else {
        git(fx.repo, 'add', '-A');
        const result = runGuard(fx.repo, fx.busRoot);
        rec(15, 'green-honest-commit',
          result.code === 0 && /compile OK \(staged index\)/i.test(result.out) ? 'PASS' : 'FAIL',
          `exit=${result.code} ${result.out}`);
      }
    } finally { await fx.cleanup(); }
  }

  const fail = results.filter((r) => r.status === 'FAIL');
  const pass = results.filter((r) => r.status === 'PASS');
  const note = results.filter((r) => r.status === 'NOTE');
  const out = { head: results[0]?.detail, pass: pass.length, fail: fail.length, note: note.length, results };
  await fsp.writeFile(path.join(REPO, 'tmp-audit-r3c-grok-out.json'), JSON.stringify(out, null, 2));
  console.log(`\nSUMMARY pass=${pass.length} fail=${fail.length} note=${note.length}`);
  for (const row of fail) console.log(`  FAIL ${row.item}/${row.name}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
