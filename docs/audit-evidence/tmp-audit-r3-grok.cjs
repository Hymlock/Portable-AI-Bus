'use strict';
/**
 * AUDIT round 3 — independent grok instrument.
 * Attacks the positive rules at 8ea4c35 / 082ddfa. Does not edit src/ or tests/.
 * Item 2 is left alone.
 */
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { MailboxStore } = require('./dist/mailbox.js');
const { PLAN_SCHEMA, buildDefaultSystem } = require('./dist/brain/brains/agent.js');
const { buildGrokArgs } = require('./dist/brain/providers.js');

const REPO = __dirname;
const GUARD = path.join(REPO, 'scripts', 'claim-guard-cli.js');
const results = [];

function rec(item, name, status, detail) {
  results.push({ item, name, status, detail: String(detail) });
  console.log(`[${status}] item ${item} / ${name}: ${detail}`);
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

async function claimWorkspace() {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'pab-r3g-13-'));
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
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'pab-r3g-15-'));
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

function errMsg(error) {
  return error && error.message ? error.message : String(error);
}

// ---------------------------------------------------------------------------
// ITEM 13
// ---------------------------------------------------------------------------
async function attack13() {
  // 13a: directory symlink (not junction) to parent
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
          const ok = /whole repositor|too broad/i.test(errMsg(error));
          rec(13, 'symlink-to-parent', ok ? 'PASS' : 'FAIL', ok ? `refused: ${errMsg(error)}` : `wrong refuse: ${errMsg(error)}`);
        }
        const still = await fx.store.claim({ agent: 'claude', paths: ['src/bus.ts'], why: 'still free', repoRoot: fx.workspace });
        rec(13, 'symlink-to-parent-does-not-lock', still ? 'PASS' : 'FAIL', still ? 'other seat still claims' : 'tree locked');
      }
    } finally {
      await fx.cleanup();
    }
  }

  // 13b: repoRoot is itself a junction
  {
    const fx = await claimWorkspace();
    try {
      const linkedRoot = path.join(fx.dir, 'ws-link');
      if (!junction(linkedRoot, fx.workspace)) {
        rec(13, 'root-is-junction', 'SKIP', 'could not junction the workspace');
      } else {
        const okClaim = await fx.store.claim({ agent: 'claude', paths: ['src/bus.ts'], why: 'through linked root', repoRoot: linkedRoot });
        rec(13, 'root-is-junction-child-ok', okClaim ? 'PASS' : 'FAIL', okClaim ? 'child claim through linked root works' : 'child claim through linked root failed');
        await fx.store.release('claude');
        try {
          await fx.store.claim({ agent: 'claude', paths: ['.'], why: 'root through link', repoRoot: linkedRoot });
          rec(13, 'root-is-junction-dot', 'FAIL', 'accepted "." through a linked root');
        } catch (error) {
          rec(13, 'root-is-junction-dot', /whole repositor|too broad|workspace-relative|Claim path/i.test(errMsg(error)) ? 'PASS' : 'FAIL', errMsg(error));
        }
      }
    } finally {
      await fx.cleanup();
    }
  }

  // 13c: Windows case
  {
    const fx = await claimWorkspace();
    try {
      const held = await fx.store.claim({ agent: 'claude', paths: ['SRC/bus.ts'], why: 'case fold', repoRoot: fx.workspace });
      rec(13, 'windows-case', held ? 'PASS' : 'FAIL', held ? 'SRC/bus.ts resolved under src' : 'case-different claim refused');
    } catch (error) {
      rec(13, 'windows-case', 'FAIL', errMsg(error));
    } finally {
      await fx.cleanup();
    }
  }

  // 13d: path under a root that still blocks the tree (src/all -> workspace)
  {
    const fx = await claimWorkspace();
    try {
      if (!junction(path.join(fx.workspace, 'src', 'all'), fx.workspace)) {
        rec(13, 'under-root-blocks-tree', 'SKIP', 'could not junction src/all to workspace');
      } else {
        const held = await fx.store.claim({ agent: 'codex', paths: ['src'], why: 'parent of outbound junction', repoRoot: fx.workspace });
        rec(13, 'claim-src-with-outbound-junction', held ? 'PASS' : 'FAIL', held ? 'claiming src accepted' : 'claiming src refused');
        try {
          const other = await fx.store.claim({ agent: 'claude', paths: ['README.md'], why: 'root file must stay free', repoRoot: fx.workspace });
          rec(13, 'src-claim-does-not-block-readme', other ? 'PASS' : 'FAIL', other ? 'README still claimable' : 'README blocked — walk escaped');
        } catch (error) {
          rec(13, 'src-claim-does-not-block-readme', 'FAIL', `README blocked: ${errMsg(error)}`);
        }
        try {
          await fx.store.claim({ agent: 'grok', paths: ['src/all'], why: 'junction equals root', repoRoot: fx.workspace });
          rec(13, 'claim-junction-equals-root', 'FAIL', 'accepted src/all whose realpath is the workspace');
        } catch (error) {
          rec(13, 'claim-junction-equals-root', /whole repositor|too broad/i.test(errMsg(error)) ? 'PASS' : 'FAIL', errMsg(error));
        }
      }
    } finally {
      await fx.cleanup();
    }
  }

  // 13e: file symlink pointing outside the tree
  {
    const fx = await claimWorkspace();
    try {
      const outside = path.join(fx.dir, 'secret.ts');
      await fsp.writeFile(outside, 'secret');
      if (!fileSymlink(path.join(fx.workspace, 'src', 'leak.ts'), outside)) {
        rec(13, 'file-symlink-outside', 'SKIP', 'file symlink unavailable');
      } else {
        try {
          await fx.store.claim({ agent: 'codex', paths: ['src/leak.ts'], why: 'file symlink out', repoRoot: fx.workspace });
          rec(13, 'file-symlink-outside', 'FAIL', 'accepted a file symlink whose realpath is outside every claim root');
        } catch (error) {
          rec(13, 'file-symlink-outside', /whole repositor|too broad/i.test(errMsg(error)) ? 'PASS' : 'FAIL', errMsg(error));
        }
      }
    } finally {
      await fx.cleanup();
    }
  }

  // 13f: green control
  {
    const fx = await claimWorkspace();
    try {
      const a = await fx.store.claim({ agent: 'claude', paths: ['src'], why: 'dir below', repoRoot: fx.workspace });
      await fx.store.release('claude');
      const b = await fx.store.claim({ agent: 'claude', paths: ['src/bus.ts'], why: 'file below', repoRoot: fx.workspace });
      rec(13, 'green-ordinary-claims', a && b ? 'PASS' : 'FAIL', 'ordinary below-root claims');
    } catch (error) {
      rec(13, 'green-ordinary-claims', 'FAIL', errMsg(error));
    } finally {
      await fx.cleanup();
    }
  }

  // 13g: missing claim root still refuses before resolution
  {
    const fx = await claimWorkspace();
    try {
      await fx.store.claim({
        agent: 'codex', paths: ['src/bus.ts'], why: 'bad root',
        repoRoot: path.join(fx.workspace, 'does-not-exist')
      });
      rec(13, 'missing-root', 'FAIL', 'accepted a claim against a missing repoRoot');
    } catch (error) {
      rec(13, 'missing-root', /claim root does not exist/i.test(errMsg(error)) ? 'PASS' : 'FAIL', errMsg(error));
    } finally {
      await fx.cleanup();
    }
  }
}

// ---------------------------------------------------------------------------
// ITEM 10
// ---------------------------------------------------------------------------
async function recallFixture() {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'pab-r3g-10-'));
  const store = new MailboxStore(dir);
  await store.ensureInitialized(['claude', 'grok', 'codex'], 500);
  const source = await store.send({
    from: 'claude', to: 'grok', kind: 'task',
    subject: 'ITEM 2 consolidation', body: 'PATHS: src/evidence.ts\nGATES: invalidate must not orphan.'
  });
  await store.openRecovery('grok', source.seq, 'started');
  return { dir, store, source, cleanup: () => fsp.rm(dir, { recursive: true, force: true, maxRetries: 8 }).catch(() => {}) };
}

async function attack10() {
  // 10a: inheritedFrom is metadata, not authority
  {
    const fx = await recallFixture();
    try {
      const moved = await fx.store.reassignBaton({ to: 'codex', reason: 'grok went dark', force: true });
      const pred = await fx.store.recallAssignment('grok', fx.source.seq);
      const succ = await fx.store.recallAssignment('codex', fx.source.seq);
      const file = await findMessageFile(fx.dir, fx.source.seq);
      const raw = JSON.parse(await fsp.readFile(file, 'utf8'));
      const inherited = (raw.recoveryCheckpoints || []).some((c) => c.seat === 'codex' && c.inheritedFrom === 'grok' && c.status === 'open');
      if (!inherited) {
        rec(10, 'inheritedFrom-present', 'FAIL', `reassign did not write inheritedFrom (inheritedWorkId=${moved.inheritedWorkId})`);
      } else if (pred !== undefined) {
        rec(10, 'inheritedFrom-predecessor-recall', 'FAIL', 'predecessor still recalled via inheritedFrom metadata');
      } else if (!succ || !/PATHS: src\/evidence\.ts/.test(succ)) {
        rec(10, 'inheritedFrom-successor-recall', 'FAIL', `successor brief missing: ${succ}`);
      } else {
        rec(10, 'inheritedFrom-not-authority', 'PASS', 'successor recalls; predecessor denied; inheritedFrom is metadata only');
      }
    } catch (error) {
      rec(10, 'inheritedFrom-not-authority', 'FAIL', errMsg(error));
    } finally {
      await fx.cleanup();
    }
  }

  // 10b: checkpoint on a DIFFERENT workId
  {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'pab-r3g-10b-'));
    const store = new MailboxStore(dir);
    try {
      await store.ensureInitialized(['claude', 'grok', 'codex'], 500);
      const one = await store.send({ from: 'claude', to: 'grok', kind: 'task', subject: 'work one', body: 'ONE' });
      const two = await store.send({ from: 'claude', to: 'grok', kind: 'task', subject: 'work two', body: 'TWO' });
      await store.openRecovery('grok', one.seq, 'on one');
      const recallTwo = await store.recallAssignment('grok', two.seq);
      rec(10, 'other-workId-no-checkpoint', recallTwo === undefined ? 'PASS' : 'FAIL',
        recallTwo === undefined ? 'open #1 does not grant #2' : `recalled #2 with only #1 open: ${recallTwo}`);
      await store.reassignBaton({ to: 'codex', reason: 'move one', force: true });
      const grokOne = await store.recallAssignment('grok', one.seq);
      const grokTwo = await store.recallAssignment('grok', two.seq);
      rec(10, 'other-workId-after-move', grokOne === undefined && grokTwo === undefined ? 'PASS' : 'FAIL',
        `after move grok#1=${grokOne && 'brief'} grok#2=${grokTwo && 'brief'}`);
      await store.openRecovery('grok', two.seq, 'now on two');
      const grokOneAfter = await store.recallAssignment('grok', one.seq);
      const grokTwoAfter = await store.recallAssignment('grok', two.seq);
      rec(10, 'open-other-does-not-resurrect-moved', grokOneAfter === undefined && !!grokTwoAfter ? 'PASS' : 'FAIL',
        `open #2 resurrected #1? #1=${grokOneAfter && 'brief'} #2=${grokTwoAfter && 'brief'}`);
    } catch (error) {
      rec(10, 'other-workId', 'FAIL', errMsg(error));
    } finally {
      await fsp.rm(dir, { recursive: true, force: true, maxRetries: 8 }).catch(() => {});
    }
  }

  // 10c: reassignBaton twice
  {
    const fx = await recallFixture();
    try {
      await fx.store.reassignBaton({ to: 'codex', reason: 'hop1', force: true });
      await fx.store.reassignBaton({ to: 'claude', reason: 'hop2', force: true });
      const g = await fx.store.recallAssignment('grok', fx.source.seq);
      const x = await fx.store.recallAssignment('codex', fx.source.seq);
      const c = await fx.store.recallAssignment('claude', fx.source.seq);
      rec(10, 'reassign-twice-forward', g === undefined && x === undefined && !!c ? 'PASS' : 'FAIL',
        `after grok->codex->claude: grok=${!!g} codex=${!!x} claude=${!!c}`);
    } catch (error) {
      rec(10, 'reassign-twice-forward', 'FAIL', errMsg(error));
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
      rec(10, 'reassign-twice-back', !!g && x === undefined ? 'PASS' : 'FAIL',
        `after grok->codex->grok: grok=${!!g} codex=${!!x}`);
    } catch (error) {
      rec(10, 'reassign-twice-back', 'FAIL', errMsg(error));
    } finally {
      await fx.cleanup();
    }
  }

  // 10d: predecessor cannot reopen while successor holds
  {
    const fx = await recallFixture();
    try {
      await fx.store.reassignBaton({ to: 'codex', reason: 'dark', force: true });
      try {
        await fx.store.openRecovery('grok', fx.source.seq, 'reopen');
        rec(10, 'predecessor-reopen-while-held', 'FAIL', 'predecessor reopened while successor holds');
      } catch (error) {
        rec(10, 'predecessor-reopen-while-held', /held by codex/i.test(errMsg(error)) ? 'PASS' : 'FAIL', errMsg(error));
      }
    } catch (error) {
      rec(10, 'predecessor-reopen-while-held', 'FAIL', errMsg(error));
    } finally {
      await fx.cleanup();
    }
  }

  // 10e: NOTE — after successor CLOSES, original addressee can reopen
  {
    const fx = await recallFixture();
    try {
      await fx.store.reassignBaton({ to: 'codex', reason: 'dark', force: true });
      await fx.store.closeRecovery('codex', fx.source.seq, 'done');
      const reopened = await fx.store.openRecovery('grok', fx.source.seq, 'back as addressee');
      const brief = await fx.store.recallAssignment('grok', fx.source.seq);
      rec(10, 'addressee-reopen-after-successor-close',
        reopened && brief ? 'NOTE' : 'FAIL',
        'after successor closes, original addressee can openRecovery and recall — address is a necessary condition for OPENING once unheld; recall still requires the new checkpoint');
    } catch (error) {
      rec(10, 'addressee-reopen-after-successor-close', 'NOTE', `could not reopen: ${errMsg(error)}`);
    } finally {
      await fx.cleanup();
    }
  }

  // 10f: a third seat that was never the addressee cannot open after close
  {
    const fx = await recallFixture();
    try {
      await fx.store.reassignBaton({ to: 'codex', reason: 'dark', force: true });
      await fx.store.closeRecovery('codex', fx.source.seq, 'done');
      try {
        await fx.store.openRecovery('claude', fx.source.seq, 'never mine');
        rec(10, 'stranger-cannot-open-unheld', 'FAIL', 'claude opened work addressed to grok after it became unheld');
      } catch (error) {
        rec(10, 'stranger-cannot-open-unheld', /addressed to grok/i.test(errMsg(error)) ? 'PASS' : 'FAIL', errMsg(error));
      }
    } catch (error) {
      rec(10, 'stranger-cannot-open-unheld', 'FAIL', errMsg(error));
    } finally {
      await fx.cleanup();
    }
  }

  // 10g: green — holder recalls across wakes
  {
    const fx = await recallFixture();
    try {
      const a = await fx.store.recallAssignment('grok', fx.source.seq);
      const b = await fx.store.recallAssignment('grok', fx.source.seq);
      rec(10, 'green-holder-recalls', a && b && /GATES: invalidate must not orphan/.test(a) ? 'PASS' : 'FAIL',
        a ? 'holder recalled twice' : 'holder lost the brief');
    } catch (error) {
      rec(10, 'green-holder-recalls', 'FAIL', errMsg(error));
    } finally {
      await fx.cleanup();
    }
  }
}

async function findMessageFile(root, seq) {
  const dir = path.join(root, '.ai-bus', 'runtime', 'mailbox', 'inbox');
  const names = await fsp.readdir(dir);
  const match = names.find((name) => name.startsWith(`${String(seq).padStart(6, '0')}-`) || name.includes(`${seq}-`));
  if (!match) throw new Error(`no message file for #${seq}`);
  return path.join(dir, match);
}

// ---------------------------------------------------------------------------
// ITEM 18
// ---------------------------------------------------------------------------
async function attack18() {
  // 18a: schema + prompt
  {
    const props = PLAN_SCHEMA?.properties?.actions?.items?.properties;
    rec(18, 'schema-has-supersedes', props && props.supersedes && props.supersedeReason ? 'PASS' : 'FAIL',
      props && props.supersedes ? `supersedes type=${props.supersedes.type}` : 'PLAN_SCHEMA missing supersedes');
    const text = buildDefaultSystem('claude');
    rec(18, 'prompt-describes-atomic', /supersedes/.test(text) && /one step|ONE step/i.test(text) ? 'PASS' : 'FAIL',
      /supersedes/.test(text) ? 'system prompt names atomic retract' : 'system prompt omits supersedes');
  }

  // 18b: schema reaches a real provider-args builder
  {
    const args = buildGrokArgs('hello', PLAN_SCHEMA);
    const idx = args.indexOf('--json-schema');
    let parsed;
    try {
      parsed = idx >= 0 ? JSON.parse(args[idx + 1]) : null;
    } catch {
      parsed = null;
    }
    const reached = parsed && parsed.properties && parsed.properties.actions
      && parsed.properties.actions.items && parsed.properties.actions.items.properties
      && parsed.properties.actions.items.properties.supersedes
      && parsed.properties.actions.items.properties.supersedes.type === 'number';
    rec(18, 'schema-reaches-buildGrokArgs', reached ? 'PASS' : 'FAIL',
      reached ? 'buildGrokArgs emits --json-schema with supersedes:{type:number}' : `args=${JSON.stringify(args).slice(0, 200)}`);
  }

  // 18c: both verbs refuse cross-recipient
  {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'pab-r3g-18c-'));
    const store = new MailboxStore(dir);
    try {
      await store.ensureInitialized(['claude', 'grok', 'codex'], 500);
      const toGrok = await store.send({ from: 'claude', to: 'grok', kind: 'task', subject: 'do X', body: 'X' });
      let atomicThrew = false;
      let atomicMsg = '';
      try {
        await store.send({ from: 'claude', to: 'codex', kind: 'task', subject: 'replacement', body: 'Y', supersedes: toGrok.seq });
      } catch (error) {
        atomicThrew = true;
        atomicMsg = errMsg(error);
      }
      const inbox = await store.inbox('grok');
      const atomicOk = atomicThrew && /sent to grok, not codex/.test(atomicMsg) && inbox.length === 1 && inbox[0].seq === toGrok.seq;
      rec(18, 'atomic-cross-recipient', atomicOk ? 'PASS' : 'FAIL',
        atomicOk ? 'atomic refused and sent nothing' : `threw=${atomicThrew} inbox=${inbox.length} ${atomicMsg}`);

      const replacement = await store.send({ from: 'claude', to: 'codex', kind: 'task', subject: 'other', body: 'Z' });
      try {
        await store.supersedeMessage(toGrok.seq, replacement.seq, 'redirect', 'claude');
        rec(18, 'twostep-cross-recipient', 'FAIL', 'two-step allowed a cross-recipient retract');
      } catch (error) {
        rec(18, 'twostep-cross-recipient', /addressed to/.test(errMsg(error)) ? 'PASS' : 'FAIL', errMsg(error));
      }
    } catch (error) {
      rec(18, 'cross-recipient', 'FAIL', errMsg(error));
    } finally {
      await fsp.rm(dir, { recursive: true, force: true, maxRetries: 8 }).catch(() => {});
    }
  }

  // 18d: consumed target — policy vs shape
  {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'pab-r3g-18d-'));
    const store = new MailboxStore(dir);
    try {
      await store.ensureInitialized(['claude', 'grok'], 500);
      const original = await store.send({ from: 'claude', to: 'grok', kind: 'task', subject: 'do X', body: 'X' });
      await store.acknowledge('grok', [original.seq]);
      const atomic = await store.send({
        from: 'claude', to: 'grok', kind: 'task', subject: 'do Y', body: 'Y',
        supersedes: original.seq, supersedeReason: 'too late'
      });
      const raw = JSON.parse(await fsp.readFile(await findMessageFile(dir, original.seq), 'utf8'));
      const policyOk = atomic.superseded === false && atomic.supersedeOutcome === 'target-consumed' && raw.supersededBy === undefined;
      rec(18, 'atomic-consumed-policy', policyOk ? 'PASS' : 'FAIL',
        policyOk ? 'atomic delivers correction, does not mark target' : JSON.stringify({ superseded: atomic.superseded, outcome: atomic.supersedeOutcome, targetBy: raw.supersededBy }));

      const later = await store.send({ from: 'claude', to: 'grok', kind: 'task', subject: 'do Z', body: 'Z' });
      try {
        await store.supersedeMessage(original.seq, later.seq, 'changed my mind', 'claude');
        rec(18, 'twostep-consumed-policy', 'FAIL', 'two-step marked a read message');
      } catch (error) {
        rec(18, 'twostep-consumed-policy', /already read it/.test(errMsg(error)) ? 'PASS' : 'FAIL', errMsg(error));
      }
      rec(18, 'consumed-shape-disagreement', 'NOTE',
        'atomic returns the correction (superseded=false, target-consumed); two-step throws. Same policy, different call outcome.');
    } catch (error) {
      rec(18, 'consumed-target', 'FAIL', errMsg(error));
    } finally {
      await fsp.rm(dir, { recursive: true, force: true, maxRetries: 8 }).catch(() => {});
    }
  }

  // 18e: atomic writes supersededAt
  {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'pab-r3g-18e-'));
    const store = new MailboxStore(dir);
    try {
      await store.ensureInitialized(['claude', 'grok'], 500);
      const original = await store.send({ from: 'claude', to: 'grok', kind: 'task', subject: 'stale', body: 'old' });
      const correction = await store.send({
        from: 'claude', to: 'grok', kind: 'task', subject: 'fresh', body: 'new',
        supersedes: original.seq, supersedeReason: 'settled already'
      });
      const raw = JSON.parse(await fsp.readFile(await findMessageFile(dir, original.seq), 'utf8'));
      rec(18, 'atomic-writes-supersededAt',
        correction.superseded === true && raw.supersededBy === correction.seq && !!raw.supersededAt && raw.supersedeReason === 'settled already' ? 'PASS' : 'FAIL',
        `supersededAt=${raw.supersededAt} by=${raw.supersededBy}`);
    } catch (error) {
      rec(18, 'atomic-writes-supersededAt', 'FAIL', errMsg(error));
    } finally {
      await fsp.rm(dir, { recursive: true, force: true, maxRetries: 8 }).catch(() => {});
    }
  }

  // 18f: empty reason disagreement
  {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'pab-r3g-18f-'));
    const store = new MailboxStore(dir);
    try {
      await store.ensureInitialized(['claude', 'grok'], 500);
      const a = await store.send({ from: 'claude', to: 'grok', kind: 'task', subject: 'A', body: 'A' });
      const b = await store.send({ from: 'claude', to: 'grok', kind: 'task', subject: 'B', body: 'B' });
      try {
        await store.supersedeMessage(a.seq, b.seq, '   ', 'claude');
        rec(18, 'twostep-empty-reason', 'FAIL', 'two-step accepted whitespace reason');
      } catch (error) {
        rec(18, 'twostep-empty-reason', /reason must not be empty/.test(errMsg(error)) ? 'PASS' : 'FAIL', errMsg(error));
      }
      const c = await store.send({ from: 'claude', to: 'grok', kind: 'task', subject: 'C', body: 'C' });
      const d = await store.send({
        from: 'claude', to: 'grok', kind: 'task', subject: 'D', body: 'D',
        supersedes: c.seq, supersedeReason: '   '
      });
      const raw = JSON.parse(await fsp.readFile(await findMessageFile(dir, c.seq), 'utf8'));
      rec(18, 'atomic-whitespace-reason',
        d.superseded === true && /^superseded by #/.test(raw.supersedeReason || '') ? 'NOTE' : 'FAIL',
        `atomic defaulted empty reason to ${raw.supersedeReason}`);
    } catch (error) {
      rec(18, 'empty-reason', 'FAIL', errMsg(error));
    } finally {
      await fsp.rm(dir, { recursive: true, force: true, maxRetries: 8 }).catch(() => {});
    }
  }

  // 18g: retract unread mail that already has an open checkpoint
  {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'pab-r3g-18g-'));
    const store = new MailboxStore(dir);
    try {
      await store.ensureInitialized(['claude', 'grok'], 500);
      const original = await store.send({ from: 'claude', to: 'grok', kind: 'task', subject: 'live work', body: 'PATHS: src/x.ts' });
      await store.openRecovery('grok', original.seq, 'started without reading');
      const correction = await store.send({
        from: 'claude', to: 'grok', kind: 'task', subject: 'retract live', body: 'never mind',
        supersedes: original.seq, supersedeReason: 'withdraw'
      });
      const recalled = await store.recallAssignment('grok', original.seq);
      rec(18, 'atomic-retract-open-unread-checkpoint',
        correction.superseded === true && recalled === undefined ? 'NOTE' : 'FAIL',
        `unread+open checkpoint can still be atomically retracted; recall then returns undefined. superseded=${correction.superseded} recall=${recalled && 'brief'}`);
    } catch (error) {
      rec(18, 'atomic-retract-open-unread-checkpoint', 'FAIL', errMsg(error));
    } finally {
      await fsp.rm(dir, { recursive: true, force: true, maxRetries: 8 }).catch(() => {});
    }
  }
}

// ---------------------------------------------------------------------------
// ITEM 15
// ---------------------------------------------------------------------------
async function attack15() {
  // negative control: staged type error is refused
  {
    const fx = await fixtureRepo();
    try {
      if (!fx.linked) {
        rec(15, 'negative-control-staged-error', 'SKIP', 'no node_modules link');
      } else {
        await fsp.writeFile(path.join(fx.repo, 'src', 'index.ts'), 'export const broken: number = "no";\n');
        git(fx.repo, 'add', '-A');
        const result = runGuard(fx.repo, fx.busRoot);
        rec(15, 'negative-control-staged-error',
          result.code === 1 && /does not compile|TS2322/.test(result.out) ? 'PASS' : 'FAIL',
          `exit=${result.code} ${result.out.slice(0, 240)}`);
      }
    } finally {
      await fx.cleanup();
    }
  }

  // 15a: absolute include into the worktree
  {
    const fx = await fixtureRepo();
    try {
      if (!fx.linked) {
        rec(15, 'absolute-include-worktree', 'SKIP', 'no node_modules link');
      } else {
        const absSrc = path.resolve(fx.repo, 'src').replace(/\\/g, '/');
        await fsp.writeFile(path.join(fx.repo, 'src', 'index.ts'), 'export const broken: number = "no";\n');
        await fsp.writeFile(path.join(fx.repo, 'tsconfig.json'), JSON.stringify({
          compilerOptions: { strict: true, noEmit: true, skipLibCheck: true, types: [] },
          include: [absSrc]
        }, null, 2));
        git(fx.repo, 'add', '-A');
        await fsp.writeFile(path.join(fx.repo, 'src', 'index.ts'), 'export const good: number = 1;\n');
        const result = runGuard(fx.repo, fx.busRoot);
        if (result.code === 0 && /compile OK \(staged index\)/.test(result.out)) {
          rec(15, 'absolute-include-worktree', 'FAIL',
            `guard compiled the worktree via absolute include and printed staged-index OK. exit=0 ${result.out.trim()}`);
        } else if (result.code === 1) {
          rec(15, 'absolute-include-worktree', 'PASS', `refused: ${result.out.slice(0, 240)}`);
        } else {
          rec(15, 'absolute-include-worktree', 'FAIL', `unexpected exit=${result.code} ${result.out.slice(0, 240)}`);
        }
      }
    } finally {
      await fx.cleanup();
    }
  }

  // 15b: files: [absolute worktree path]
  {
    const fx = await fixtureRepo();
    try {
      if (!fx.linked) {
        rec(15, 'absolute-files-worktree', 'SKIP', 'no node_modules link');
      } else {
        const absIndex = path.resolve(fx.repo, 'src', 'index.ts').replace(/\\/g, '/');
        await fsp.writeFile(path.join(fx.repo, 'src', 'index.ts'), 'export const broken: number = "no";\n');
        await fsp.writeFile(path.join(fx.repo, 'tsconfig.json'), JSON.stringify({
          compilerOptions: { strict: true, noEmit: true, skipLibCheck: true, types: [] },
          files: [absIndex]
        }, null, 2));
        git(fx.repo, 'add', '-A');
        await fsp.writeFile(path.join(fx.repo, 'src', 'index.ts'), 'export const good: number = 1;\n');
        const result = runGuard(fx.repo, fx.busRoot);
        if (result.code === 0 && /compile OK/.test(result.out)) {
          rec(15, 'absolute-files-worktree', 'FAIL',
            `files:[abs worktree] compiled the restored worktree. exit=0 ${result.out.trim()}`);
        } else if (result.code === 1) {
          rec(15, 'absolute-files-worktree', 'PASS', `refused: ${result.out.slice(0, 240)}`);
        } else {
          rec(15, 'absolute-files-worktree', 'FAIL', `unexpected exit=${result.code} ${result.out.slice(0, 240)}`);
        }
      }
    } finally {
      await fx.cleanup();
    }
  }

  // 15c: extends a worktree-only config
  {
    const fx = await fixtureRepo();
    try {
      if (!fx.linked) {
        rec(15, 'extends-worktree-only', 'SKIP', 'no node_modules link');
      } else {
        const baseAbs = path.resolve(fx.repo, 'tsconfig.worktree-only.json').replace(/\\/g, '/');
        await fsp.writeFile(path.join(fx.repo, 'tsconfig.worktree-only.json'), JSON.stringify({
          compilerOptions: { strict: true, noEmit: true, skipLibCheck: true, types: [] },
          include: ['src/ok.ts']
        }, null, 2));
        await fsp.writeFile(path.join(fx.repo, 'src', 'index.ts'), 'export const broken: number = "no";\n');
        await fsp.writeFile(path.join(fx.repo, 'tsconfig.json'), JSON.stringify({ extends: baseAbs }, null, 2));
        git(fx.repo, 'add', 'src/index.ts', 'src/ok.ts', 'tsconfig.json');
        const result = runGuard(fx.repo, fx.busRoot);
        if (result.code === 0) {
          rec(15, 'extends-worktree-only', 'FAIL',
            `unstaged worktree base (include src/ok.ts only) let a broken index.ts land. exit=0 ${result.out.trim()}`);
        } else {
          rec(15, 'extends-worktree-only', 'PASS', `refused: ${result.out.slice(0, 240)}`);
        }
      }
    } finally {
      await fx.cleanup();
    }
  }

  // 15d: references a worktree project
  {
    const fx = await fixtureRepo();
    try {
      if (!fx.linked) {
        rec(15, 'references-worktree-project', 'SKIP', 'no node_modules link');
      } else {
        const absRef = path.resolve(fx.repo, 'tsconfig.wt-ref.json').replace(/\\/g, '/');
        await fsp.writeFile(path.join(fx.repo, 'tsconfig.wt-ref.json'), JSON.stringify({
          compilerOptions: { strict: true, noEmit: true, skipLibCheck: true, types: [], composite: true },
          include: ['src/ok.ts']
        }, null, 2));
        await fsp.writeFile(path.join(fx.repo, 'src', 'index.ts'), 'export const broken: number = "no";\n');
        await fsp.writeFile(path.join(fx.repo, 'tsconfig.json'), JSON.stringify({
          compilerOptions: { strict: true, noEmit: true, skipLibCheck: true, types: [], composite: true },
          files: [],
          references: [{ path: absRef }]
        }, null, 2));
        git(fx.repo, 'add', 'src/index.ts', 'src/ok.ts', 'tsconfig.json');
        const result = runGuard(fx.repo, fx.busRoot);
        if (result.code === 0) {
          rec(15, 'references-worktree-project', 'FAIL',
            `absolute references into the worktree compiled a subset / skipped the broken file. exit=0 ${result.out.trim()}`);
        } else {
          rec(15, 'references-worktree-project', 'NOTE', `tsc refused references: ${result.out.slice(0, 240)}`);
        }
      }
    } finally {
      await fx.cleanup();
    }
  }

  // 15e: noCheck in the STAGED tsconfig
  {
    const fx = await fixtureRepo();
    try {
      if (!fx.linked) {
        rec(15, 'staged-noCheck', 'SKIP', 'no node_modules link');
      } else {
        await fsp.writeFile(path.join(fx.repo, 'src', 'index.ts'), 'export const broken: number = "no";\n');
        await fsp.writeFile(path.join(fx.repo, 'tsconfig.json'), JSON.stringify({
          compilerOptions: { strict: true, noEmit: true, skipLibCheck: true, types: [], noCheck: true },
          include: ['src']
        }, null, 2));
        git(fx.repo, 'add', '-A');
        const result = runGuard(fx.repo, fx.busRoot);
        rec(15, 'staged-noCheck', result.code === 0 ? 'NOTE' : 'PASS',
          result.code === 0
            ? 'index disabled checking via noCheck; tsc trusts the staged config — different class'
            : `noCheck did not skip: ${result.out.slice(0, 200)}`);
      }
    } finally {
      await fx.cleanup();
    }
  }

  // 15f: hatch still works
  {
    const fx = await fixtureRepo();
    try {
      if (!fx.linked) {
        rec(15, 'hatch', 'SKIP', 'no node_modules link');
      } else {
        await fsp.writeFile(path.join(fx.repo, 'src', 'index.ts'), 'export const broken: number = "no";\n');
        git(fx.repo, 'add', '-A');
        const result = runGuard(fx.repo, fx.busRoot, { BUS_ALLOW_BROKEN_BUILD: '1' });
        rec(15, 'hatch', result.code === 0 && /SKIPPED/.test(result.out) ? 'PASS' : 'FAIL',
          `exit=${result.code} ${result.out.slice(0, 200)}`);
      }
    } finally {
      await fx.cleanup();
    }
  }

  // 15g: honest commit still passes
  {
    const fx = await fixtureRepo();
    try {
      if (!fx.linked) {
        rec(15, 'green-honest-commit', 'SKIP', 'no node_modules link');
      } else {
        git(fx.repo, 'add', '-A');
        const result = runGuard(fx.repo, fx.busRoot);
        rec(15, 'green-honest-commit', result.code === 0 && /compile OK \(staged index\)/.test(result.out) ? 'PASS' : 'FAIL',
          `exit=${result.code} ${result.out.slice(0, 200)}`);
      }
    } finally {
      await fx.cleanup();
    }
  }
}

async function main() {
  await attack13();
  await attack10();
  await attack18();
  await attack15();

  const outPath = path.join(REPO, 'tmp-audit-r3-grok-out.json');
  await fsp.writeFile(outPath, JSON.stringify({ headNote: 'independent r3', results }, null, 2));
  const counts = results.reduce((acc, row) => {
    acc[row.status] = (acc[row.status] || 0) + 1;
    return acc;
  }, {});
  console.log('\nSUMMARY', JSON.stringify(counts));
  for (const row of results) {
    if (row.status === 'FAIL') console.log(`  FAIL  item ${row.item} / ${row.name}: ${row.detail}`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
