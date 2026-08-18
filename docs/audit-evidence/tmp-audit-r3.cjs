'use strict';
/**
 * AUDIT round 3 probes. Own instrument. Does not edit src/ or tests/.
 * Attacks the positive rules at 8ea4c35 / 082ddfa.
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
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'pab-r3-13-'));
  const workspace = path.join(dir, 'ws');
  await fsp.mkdir(path.join(workspace, 'src'), { recursive: true });
  await fsp.writeFile(path.join(workspace, 'src', 'bus.ts'), 'x');
  await fsp.writeFile(path.join(workspace, 'README.md'), 'root file');
  const busRoot = path.join(dir, 'bus');
  await fsp.mkdir(busRoot, { recursive: true });
  const store = new MailboxStore(busRoot);
  await store.ensureInitialized(['claude', 'codex', 'grok'], 500);
  return { dir, workspace, busRoot, store, cleanup: () => fsp.rm(dir, { recursive: true, force: true, maxRetries: 8 }).catch(() => {}) };
}

async function fixtureRepo() {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'pab-r3-15-'));
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
  await fsp.writeFile(path.join(mailboxDir, 'state.json'),
    JSON.stringify({ claims: { claude: [{ path: 'src' }, { path: 'tsconfig.json' }] } }));
  return {
    dir, repo, busRoot, linked,
    cleanup: () => fsp.rm(dir, { recursive: true, force: true, maxRetries: 8 }).catch(() => {})
  };
}

// ---------------------------------------------------------------------------
// ITEM 13
// ---------------------------------------------------------------------------
async function item13() {
  // 13a. Directory symlink (not junction) to the parent.
  {
    const ctx = await claimWorkspace();
    try {
      if (process.platform !== 'win32' || !dirSymlink(path.join(ctx.workspace, 'above'), ctx.dir)) {
        rec(13, 'symlink-to-parent', 'SKIP', 'directory symlinks unavailable (need Developer Mode or admin)');
      } else {
        try {
          await ctx.store.claim({ agent: 'codex', paths: ['above'], why: 'symlink parent', repoRoot: ctx.workspace });
          rec(13, 'symlink-to-parent', 'FAIL', 'directory symlink to the parent was accepted — same lock as the junction');
        } catch (error) {
          rec(13, 'symlink-to-parent', /whole repositor|too broad/i.test(error.message) ? 'PASS' : 'FAIL', error.message);
        }
      }
    } finally {
      await ctx.cleanup();
    }
  }

  // 13b. Claim root is itself a junction. Ordinary child claim must still work.
  {
    const ctx = await claimWorkspace();
    try {
      const linkRoot = path.join(ctx.dir, 'ws-link');
      if (process.platform !== 'win32' || !junction(linkRoot, ctx.workspace)) {
        rec(13, 'root-is-junction-green', 'SKIP', 'junctions unavailable');
      } else {
        try {
          const held = await ctx.store.claim({
            agent: 'claude', paths: ['src/bus.ts'], why: 'through linked root', repoRoot: linkRoot
          });
          rec(13, 'root-is-junction-green', held && held.length ? 'PASS' : 'FAIL',
            held ? `claimed via linked root: ${JSON.stringify(held.map((c) => c.path))}` : 'empty hold');
        } catch (error) {
          rec(13, 'root-is-junction-green', 'FAIL', `linked root refused a child claim: ${error.message}`);
        }
      }
    } finally {
      await ctx.cleanup();
    }
  }

  // 13c. Claim root is a junction. A claim of the link's own name from a sibling root?
  // Claiming "." through the linked root must still refuse (equals the real workspace).
  {
    const ctx = await claimWorkspace();
    try {
      const linkRoot = path.join(ctx.dir, 'ws-link');
      if (process.platform !== 'win32' || !junction(linkRoot, ctx.workspace)) {
        rec(13, 'root-is-junction-dot', 'SKIP', 'junctions unavailable');
      } else {
        try {
          await ctx.store.claim({ agent: 'codex', paths: ['.'], why: 'dot via linked root', repoRoot: linkRoot });
          rec(13, 'root-is-junction-dot', 'FAIL', 'claiming "." through a linked root was accepted');
        } catch (error) {
          rec(13, 'root-is-junction-dot', /whole repositor|too broad/i.test(error.message) ? 'PASS' : 'FAIL', error.message);
        }
      }
    } finally {
      await ctx.cleanup();
    }
  }

  // 13d. Case difference on Windows: claim SRC/bus.ts when the folder is src.
  {
    const ctx = await claimWorkspace();
    try {
      const held = await ctx.store.claim({
        agent: 'claude', paths: ['SRC/bus.ts'], why: 'windows case', repoRoot: ctx.workspace
      });
      rec(13, 'windows-case-child', held && held.length ? 'PASS' : 'FAIL',
        `cased path resolved: ${JSON.stringify(held)}`);
    } catch (error) {
      rec(13, 'windows-case-child', 'FAIL', `case difference refused a real child: ${error.message}`);
    } finally {
      await ctx.cleanup();
    }
  }

  // 13e. Path under the root whose child is a junction OUT to the tree.
  // Claiming the parent (`src`) must NOT block README.md at the repo root (item 14 bound).
  {
    const ctx = await claimWorkspace();
    try {
      const escape = path.join(ctx.workspace, 'src', 'all');
      if (process.platform !== 'win32' || !junction(escape, ctx.workspace)) {
        rec(13, 'parent-of-outbound-junction', 'SKIP', 'junctions unavailable');
      } else {
        await ctx.store.claim({
          agent: 'codex', paths: ['src'], why: 'parent of outbound junction', repoRoot: ctx.workspace
        });
        try {
          const held = await ctx.store.claim({
            agent: 'claude', paths: ['README.md'], why: 'file at root, outside src', repoRoot: ctx.workspace
          });
          rec(13, 'parent-of-outbound-junction', held && held.length ? 'PASS' : 'FAIL',
            'src claimed; README.md at root still free (walk stayed under src)');
        } catch (error) {
          rec(13, 'parent-of-outbound-junction', 'FAIL',
            `claiming src (which contains a junction to the workspace) blocked the tree: ${error.message}`);
        }
      }
    } finally {
      await ctx.cleanup();
    }
  }

  // 13f. The junction itself (src/all -> workspace) must refuse — equals the root.
  {
    const ctx = await claimWorkspace();
    try {
      const escape = path.join(ctx.workspace, 'src', 'all');
      if (process.platform !== 'win32' || !junction(escape, ctx.workspace)) {
        rec(13, 'outbound-junction-itself', 'SKIP', 'junctions unavailable');
      } else {
        try {
          await ctx.store.claim({
            agent: 'codex', paths: ['src/all'], why: 'junction equals root', repoRoot: ctx.workspace
          });
          rec(13, 'outbound-junction-itself', 'FAIL', 'junction whose realpath IS the root was accepted');
        } catch (error) {
          rec(13, 'outbound-junction-itself', /whole repositor|too broad/i.test(error.message) ? 'PASS' : 'FAIL', error.message);
        }
      }
    } finally {
      await ctx.cleanup();
    }
  }
}

// ---------------------------------------------------------------------------
// ITEM 10
// ---------------------------------------------------------------------------
async function item10() {
  async function primed() {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'pab-r3-10-'));
    const store = new MailboxStore(dir);
    await store.ensureInitialized(['claude', 'grok', 'codex'], 500);
    const source = await store.send({
      from: 'claude', to: 'grok', kind: 'task',
      subject: 'ITEM 2 consolidation', body: 'PATHS: src/evidence.ts\nGATES: invalidate must not orphan.'
    });
    await store.openRecovery('grok', source.seq, 'started');
    return { dir, store, source, cleanup: () => fsp.rm(dir, { recursive: true, force: true, maxRetries: 8 }).catch(() => {}) };
  }

  // 10a. inheritedFrom: predecessor must not recall; successor must.
  {
    const ctx = await primed();
    try {
      const moved = await ctx.store.reassignBaton({ to: 'codex', reason: 'grok went dark', force: true });
      const pred = await ctx.store.recallAssignment('grok', ctx.source.seq);
      const succ = await ctx.store.recallAssignment('codex', ctx.source.seq);
      const file = path.join(ctx.dir, '.ai-bus', 'runtime', 'mailbox', 'inbox');
      const names = await fsp.readdir(file);
      const raw = JSON.parse(await fsp.readFile(path.join(file, names.find((n) => n.includes(`${ctx.source.seq}-`) || n.startsWith(String(ctx.source.seq).padStart(6, '0')))), 'utf8'));
      const inherited = (raw.recoveryCheckpoints || []).find((c) => c.seat === 'codex' && c.status === 'open');
      if (pred) {
        rec(10, 'inheritedFrom-predecessor', 'FAIL', `predecessor still recalled after inherit (inheritedFrom=${inherited && inherited.inheritedFrom})`);
      } else if (!succ) {
        rec(10, 'inheritedFrom-predecessor', 'FAIL', 'successor could not recall; inheritedFrom path is broken');
      } else if (!inherited || inherited.inheritedFrom !== 'grok') {
        rec(10, 'inheritedFrom-predecessor', 'FAIL', `expected inheritedFrom=grok on open row, got ${JSON.stringify(inherited)}`);
      } else {
        rec(10, 'inheritedFrom-predecessor', 'PASS', `predecessor denied; successor holds via inheritedFrom=${inherited.inheritedFrom}; baton moved work #${moved.inheritedWorkId}`);
      }
    } finally {
      await ctx.cleanup();
    }
  }

  // 10b. Checkpoint on a DIFFERENT workId does not grant recall of this one.
  {
    const ctx = await primed();
    try {
      const other = await ctx.store.send({
        from: 'claude', to: 'grok', kind: 'task', subject: 'unrelated', body: 'OTHER BRIEF that must not leak'
      });
      // grok holds work `source`. Asking to recall `other` must yield nothing.
      const leaked = await ctx.store.recallAssignment('grok', other.seq);
      if (leaked) {
        rec(10, 'different-workId', 'FAIL', `held work #${ctx.source.seq} but recalled #${other.seq}: ${leaked.slice(0, 80)}`);
      } else {
        rec(10, 'different-workId', 'PASS', `open checkpoint on #${ctx.source.seq} does not grant recall of #${other.seq}`);
      }
    } finally {
      await ctx.cleanup();
    }
  }

  // 10c. Addressee of two messages cannot open the second while the first is held by another
  // after reassignment — and cannot recall the moved work via the other workId either.
  {
    const ctx = await primed();
    try {
      const other = await ctx.store.send({
        from: 'claude', to: 'grok', kind: 'task', subject: 'second assignment', body: 'SECOND'
      });
      await ctx.store.reassignBaton({ to: 'codex', reason: 'move first', force: true });
      const viaOther = await ctx.store.recallAssignment('grok', other.seq);
      const viaMoved = await ctx.store.recallAssignment('grok', ctx.source.seq);
      // grok may open the second (it is addressed to them and nobody holds it).
      let openedSecond = false;
      try {
        await ctx.store.openRecovery('grok', other.seq, 'taking the other one');
        openedSecond = true;
      } catch (error) {
        rec(10, 'open-other-after-loss', 'NOTE', `could not open the other addressed work: ${error.message}`);
      }
      const afterOpen = openedSecond ? await ctx.store.recallAssignment('grok', other.seq) : undefined;
      const stillMoved = await ctx.store.recallAssignment('grok', ctx.source.seq);
      if (viaMoved || stillMoved) {
        rec(10, 'different-workId-after-reassign', 'FAIL', 'predecessor recalled the moved work via any workId');
      } else if (viaOther) {
        rec(10, 'different-workId-after-reassign', 'FAIL', 'recalled the other brief without an open checkpoint on it');
      } else {
        rec(10, 'different-workId-after-reassign', 'PASS',
          `moved work stays with successor; other brief ${openedSecond ? 'recallable only after opening its own checkpoint' : 'not opened'}; afterOpen=${Boolean(afterOpen)}`);
      }
    } finally {
      await ctx.cleanup();
    }
  }

  // 10d. reassignBaton twice: grok -> codex -> claude. Only claude recalls.
  {
    const ctx = await primed();
    try {
      await ctx.store.reassignBaton({ to: 'codex', reason: 'first hop', force: true });
      await ctx.store.reassignBaton({ to: 'claude', reason: 'second hop', force: true });
      const grok = await ctx.store.recallAssignment('grok', ctx.source.seq);
      const codex = await ctx.store.recallAssignment('codex', ctx.source.seq);
      const claude = await ctx.store.recallAssignment('claude', ctx.source.seq);
      if (grok || codex) {
        rec(10, 'reassign-twice', 'FAIL', `a prior holder still recalled after two hops (grok=${Boolean(grok)} codex=${Boolean(codex)})`);
      } else if (!claude) {
        rec(10, 'reassign-twice', 'FAIL', 'final holder could not recall after two hops');
      } else {
        rec(10, 'reassign-twice', 'PASS', 'only the second successor recalls; both prior holders denied');
      }
    } finally {
      await ctx.cleanup();
    }
  }

  // 10e. reassign back to the original holder. They should recall again; the middle seat must not.
  {
    const ctx = await primed();
    try {
      await ctx.store.reassignBaton({ to: 'codex', reason: 'away', force: true });
      await ctx.store.reassignBaton({ to: 'grok', reason: 'back', force: true });
      const grok = await ctx.store.recallAssignment('grok', ctx.source.seq);
      const codex = await ctx.store.recallAssignment('codex', ctx.source.seq);
      if (!grok) {
        rec(10, 'reassign-roundtrip', 'FAIL', 'original holder could not recall after the work came back');
      } else if (codex) {
        rec(10, 'reassign-roundtrip', 'FAIL', 'middle seat still recalled after handing back');
      } else {
        rec(10, 'reassign-roundtrip', 'PASS', 'round-trip returns the brief to the original holder only');
      }
    } finally {
      await ctx.cleanup();
    }
  }

  // 10f. Predecessor cannot reopen while successor holds; CAN reopen after successor closes?
  {
    const ctx = await primed();
    try {
      await ctx.store.reassignBaton({ to: 'codex', reason: 'moved', force: true });
      let blocked = false;
      try {
        await ctx.store.openRecovery('grok', ctx.source.seq, 'steal');
      } catch (error) {
        blocked = /held by codex/i.test(error.message);
      }
      await ctx.store.closeRecovery('codex', ctx.source.seq, 'done');
      let reopened = false;
      try {
        await ctx.store.openRecovery('grok', ctx.source.seq, 'reclaim abandoned');
        reopened = true;
      } catch (error) {
        rec(10, 'reopen-after-successor-close', 'NOTE', `predecessor cannot reclaim abandoned addressed work: ${error.message}`);
      }
      const brief = reopened ? await ctx.store.recallAssignment('grok', ctx.source.seq) : undefined;
      rec(10, 'reopen-while-held', blocked ? 'PASS' : 'FAIL',
        blocked ? 'predecessor cannot reopen while successor holds' : 'predecessor reopened while successor still held');
      rec(10, 'reopen-after-successor-close', reopened && brief ? 'NOTE' :
        (reopened ? 'FAIL' : 'NOTE'),
        reopened && brief
          ? 'after successor closes, the original addressee can reopen and recall — work was unheld; address still names them'
          : `reopened=${reopened} brief=${Boolean(brief)}`);
    } finally {
      await ctx.cleanup();
    }
  }
}

// ---------------------------------------------------------------------------
// ITEM 18
// ---------------------------------------------------------------------------
async function item18() {
  // 18a. PLAN_SCHEMA is actually handed to a real provider argv builder.
  {
    const args = buildGrokArgs('hello', PLAN_SCHEMA, 'grok-4');
    const idx = args.indexOf('--json-schema');
    if (idx < 0) {
      rec(18, 'schema-reaches-grok-argv', 'FAIL', 'buildGrokArgs dropped --json-schema');
    } else {
      const parsed = JSON.parse(args[idx + 1]);
      const props = parsed?.properties?.actions?.items?.properties;
      rec(18, 'schema-reaches-grok-argv', props && props.supersedes ? 'PASS' : 'FAIL',
        props && props.supersedes
          ? `grok argv contains --json-schema with supersedes=${JSON.stringify(props.supersedes)}`
          : `schema reached argv but supersedes missing: ${args[idx + 1].slice(0, 200)}`);
    }
  }

  // 18b. Other providers ignore responseSchema — inspect their ask signatures via toString.
  {
    const src = fs.readFileSync(path.join(REPO, 'src', 'brain', 'providers.ts'), 'utf8');
    const asks = [...src.matchAll(/async ask\([^)]*\)/g)].map((m) => m[0]);
    const withSchema = asks.filter((s) => s.includes('responseSchema'));
    rec(18, 'providers-forward-schema', withSchema.length === 1 ? 'NOTE' : 'NOTE',
      `${asks.length} ask() implementations; ${withSchema.length} destructure responseSchema. ` +
      'Only grok forwards it (by design: others ignore, parsePlan handles). Schema change reaches a REAL call only for grok.');
  }

  // 18c. System prompt still describes both verbs, including the consumed-target rule.
  {
    const text = buildDefaultSystem('claude');
    const hasAtomic = /supersedes/.test(text) && /ONE step|one step/i.test(text);
    const hasTwoStep = /supersede requires/.test(text) && /unread/.test(text);
    rec(18, 'prompt-both-verbs', hasAtomic && hasTwoStep ? 'PASS' : 'FAIL',
      `atomic=${hasAtomic} two-step=${hasTwoStep}`);
  }

  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'pab-r3-18-'));
  const store = new MailboxStore(dir);
  await store.ensureInitialized(['claude', 'grok', 'codex'], 500);
  const cleanup = () => fsp.rm(dir, { recursive: true, force: true, maxRetries: 8 }).catch(() => {});

  try {
    // 18d. Cross-recipient: both verbs refuse.
    const toGrok = await store.send({ from: 'claude', to: 'grok', kind: 'task', subject: 'do X', body: 'X' });
    let atomicCross = 'threw';
    try {
      await store.send({ from: 'claude', to: 'codex', kind: 'task', subject: 'Y', body: 'Y', supersedes: toGrok.seq });
      atomicCross = 'accepted';
    } catch (error) {
      atomicCross = error.message;
    }
    const replacement = await store.send({ from: 'claude', to: 'codex', kind: 'task', subject: 'Y2', body: 'Y2' });
    let twoStepCross = 'threw';
    try {
      await store.supersedeMessage(toGrok.seq, replacement.seq, 'redirect', 'claude');
      twoStepCross = 'accepted';
    } catch (error) {
      twoStepCross = error.message;
    }
    rec(18, 'cross-recipient-agree',
      atomicCross !== 'accepted' && twoStepCross !== 'accepted' ? 'PASS' : 'FAIL',
      `atomic=${atomicCross} | two-step=${twoStepCross}`);

    // 18e. Consumed target: do the verbs still disagree in SHAPE?
    const original = await store.send({ from: 'claude', to: 'grok', kind: 'task', subject: 'do Z', body: 'Z' });
    await store.acknowledge('grok', [original.seq]);
    let atomicConsumed;
    try {
      const sent = await store.send({
        from: 'claude', to: 'grok', kind: 'task', subject: 'Z2', body: 'Z2', supersedes: original.seq
      });
      atomicConsumed = { threw: false, superseded: sent.superseded, outcome: sent.supersedeOutcome, seq: sent.seq };
    } catch (error) {
      atomicConsumed = { threw: true, message: error.message };
    }
    const later = await store.send({ from: 'claude', to: 'grok', kind: 'task', subject: 'Z3', body: 'Z3' });
    let twoStepConsumed;
    try {
      await store.supersedeMessage(original.seq, later.seq, 'too late', 'claude');
      twoStepConsumed = { threw: false };
    } catch (error) {
      twoStepConsumed = { threw: true, message: error.message };
    }
    const reread = JSON.parse(await fsp.readFile(
      path.join(dir, '.ai-bus', 'runtime', 'mailbox', 'inbox',
        (await fsp.readdir(path.join(dir, '.ai-bus', 'runtime', 'mailbox', 'inbox')))
          .find((n) => n.includes(`-${original.seq}-`) || n.startsWith(String(original.seq).padStart(6, '0')))),
      'utf8'
    ));
    const policyAgree = reread.supersededBy === undefined && twoStepConsumed.threw === true &&
      atomicConsumed.threw === false && atomicConsumed.superseded === false;
    rec(18, 'consumed-target-policy', policyAgree ? 'PASS' : 'FAIL',
      `neither verb marks a read target superseded (atomic threw=${atomicConsumed.threw} superseded=${atomicConsumed.superseded} outcome=${atomicConsumed.outcome}; two-step threw=${twoStepConsumed.threw}). original.supersededBy=${reread.supersededBy}`);
    rec(18, 'consumed-target-shape', 'NOTE',
      `SHAPE still disagrees: atomic delivers a correction (seq=${atomicConsumed.seq}, superseded=false, reason=${atomicConsumed.outcome}); two-step throws (${twoStepConsumed.message}). Policy is the same; the call outcome is not.`);

    // 18f. Empty reason: two-step refuses; atomic defaults.
    const live = await store.send({ from: 'claude', to: 'grok', kind: 'task', subject: 'live', body: 'L' });
    const live2 = await store.send({ from: 'claude', to: 'grok', kind: 'task', subject: 'live2', body: 'L2' });
    let twoStepEmpty;
    try {
      await store.supersedeMessage(live.seq, live2.seq, '   ', 'claude');
      twoStepEmpty = 'accepted';
    } catch (error) {
      twoStepEmpty = error.message;
    }
    const live3 = await store.send({ from: 'claude', to: 'grok', kind: 'task', subject: 'still-live', body: 'L3' });
    let atomicEmpty;
    try {
      const sent = await store.send({
        from: 'claude', to: 'grok', kind: 'task', subject: 'live4', body: 'L4',
        supersedes: live3.seq, supersedeReason: '   '
      });
      atomicEmpty = { threw: false, superseded: sent.superseded };
    } catch (error) {
      atomicEmpty = { threw: true, message: error.message };
    }
    rec(18, 'empty-reason-disagree', 'NOTE',
      `two-step empty reason: ${twoStepEmpty}; atomic whitespace reason: ${JSON.stringify(atomicEmpty)}. Two-step requires a non-empty reason; atomic defaults to "superseded by #N".`);

    // 18g. Idempotent two-step vs atomic (cannot resend same seq).
    const a = await store.send({ from: 'claude', to: 'grok', kind: 'task', subject: 'A', body: 'A' });
    const b = await store.send({ from: 'claude', to: 'grok', kind: 'task', subject: 'B', body: 'B' });
    await store.supersedeMessage(a.seq, b.seq, 'once', 'claude');
    const again = await store.supersedeMessage(a.seq, b.seq, 'once', 'claude');
    rec(18, 'two-step-idempotent', again.supersededBy === b.seq ? 'NOTE' : 'FAIL',
      `two-step re-supersede with same by+reason returns success (seq=${again.seq}). Atomic has no equivalent: the replacement already exists.`);
  } finally {
    await cleanup();
  }
}

// ---------------------------------------------------------------------------
// ITEM 15
// ---------------------------------------------------------------------------
async function item15() {
  // 15a. Honest broken index still refuses (negative control).
  {
    const fx = await fixtureRepo();
    try {
      if (!fx.linked) {
        rec(15, 'honest-broken-refuses', 'SKIP', 'could not link node_modules');
      } else {
        await fsp.writeFile(path.join(fx.repo, 'src', 'index.ts'), 'export const broken: number = "no";\n');
        git(fx.repo, 'add', '-A');
        const result = runGuard(fx.repo, fx.busRoot);
        rec(15, 'honest-broken-refuses', result.code === 1 && /does not compile/i.test(result.out) ? 'PASS' : 'FAIL',
          `exit=${result.code} out=${result.out.slice(0, 240)}`);
      }
    } finally {
      await fx.cleanup();
    }
  }

  // 15b. Staged tsconfig include: absolute path to the WORKTREE src (good files).
  {
    const fx = await fixtureRepo();
    try {
      if (!fx.linked) {
        rec(15, 'absolute-include-worktree', 'SKIP', 'could not link node_modules');
      } else {
        await fsp.writeFile(path.join(fx.repo, 'src', 'index.ts'), 'export const broken: number = "no";\n');
        const worktreeSrc = path.join(fx.repo, 'src').replace(/\\/g, '/');
        await fsp.writeFile(path.join(fx.repo, 'tsconfig.json'), JSON.stringify({
          compilerOptions: { strict: true, noEmit: true, skipLibCheck: true, types: [] },
          include: [worktreeSrc]
        }, null, 2));
        git(fx.repo, 'add', '-A');
        // Restore a compiling worktree so a naive worktree compile would pass.
        await fsp.writeFile(path.join(fx.repo, 'src', 'index.ts'), 'export const good: number = 1;\n');
        const result = runGuard(fx.repo, fx.busRoot);
        if (result.code === 0) {
          rec(15, 'absolute-include-worktree', 'FAIL',
            `staged tsconfig include pointed at the worktree; guard exited 0. The index still has the type error. out=${result.out.slice(0, 200)}`);
        } else {
          rec(15, 'absolute-include-worktree', 'PASS',
            `refused (exit ${result.code}). Absolute include did not let a broken index land. out=${result.out.slice(0, 200)}`);
        }
      }
    } finally {
      await fx.cleanup();
    }
  }

  // 15c. Staged tsconfig extends an absolute worktree tsconfig that has a narrow include.
  {
    const fx = await fixtureRepo();
    try {
      if (!fx.linked) {
        rec(15, 'extends-worktree-tsconfig', 'SKIP', 'could not link node_modules');
      } else {
        await fsp.writeFile(path.join(fx.repo, 'src', 'index.ts'), 'export const broken: number = "no";\n');
        const base = path.join(fx.repo, 'tsconfig.worktree-only.json');
        await fsp.writeFile(base, JSON.stringify({
          compilerOptions: { strict: true, noEmit: true, skipLibCheck: true, types: [] },
          include: ['src/ok.ts']
        }, null, 2));
        await fsp.writeFile(path.join(fx.repo, 'tsconfig.json'), JSON.stringify({
          extends: base.replace(/\\/g, '/')
        }, null, 2));
        git(fx.repo, 'add', 'src', 'tsconfig.json');
        const result = runGuard(fx.repo, fx.busRoot);
        if (result.code === 0) {
          rec(15, 'extends-worktree-tsconfig', 'FAIL',
            `staged tsconfig extends a worktree-only narrow config; guard exited 0. out=${result.out.slice(0, 200)}`);
        } else {
          rec(15, 'extends-worktree-tsconfig', 'PASS',
            `refused (exit ${result.code}). Extending a worktree config did not skip the broken index. out=${result.out.slice(0, 200)}`);
        }
      }
    } finally {
      await fx.cleanup();
    }
  }

  // 15d. Staged tsconfig with empty include — tsc compiles nothing.
  {
    const fx = await fixtureRepo();
    try {
      if (!fx.linked) {
        rec(15, 'empty-include', 'SKIP', 'could not link node_modules');
      } else {
        await fsp.writeFile(path.join(fx.repo, 'src', 'index.ts'), 'export const broken: number = "no";\n');
        await fsp.writeFile(path.join(fx.repo, 'tsconfig.json'), JSON.stringify({
          compilerOptions: { strict: true, noEmit: true, skipLibCheck: true, types: [] },
          include: [],
          files: []
        }, null, 2));
        git(fx.repo, 'add', '-A');
        const result = runGuard(fx.repo, fx.busRoot);
        rec(15, 'empty-include', result.code === 0 ? 'NOTE' : 'NOTE',
          `exit=${result.code}. Empty staged include ${result.code === 0 ? 'lets tsc succeed with zero files — the INDEX said not to check. Class: tsc trusts the staged config.' : 'refused'}. out=${result.out.slice(0, 180)}`);
      }
    } finally {
      await fx.cleanup();
    }
  }

  // 15e. noCheck: true in the staged tsconfig.
  {
    const fx = await fixtureRepo();
    try {
      if (!fx.linked) {
        rec(15, 'nocheck', 'SKIP', 'could not link node_modules');
      } else {
        await fsp.writeFile(path.join(fx.repo, 'src', 'index.ts'), 'export const broken: number = "no";\n');
        await fsp.writeFile(path.join(fx.repo, 'tsconfig.json'), JSON.stringify({
          compilerOptions: { strict: true, noEmit: true, skipLibCheck: true, types: [], noCheck: true },
          include: ['src']
        }, null, 2));
        git(fx.repo, 'add', '-A');
        const result = runGuard(fx.repo, fx.busRoot);
        rec(15, 'nocheck', result.code === 0 ? 'NOTE' : 'NOTE',
          `exit=${result.code}. noCheck ${result.code === 0 ? 'lets a type error land because the INDEX disabled checking. Same class as empty include.' : 'refused anyway'}. out=${result.out.slice(0, 180)}`);
      }
    } finally {
      await fx.cleanup();
    }
  }

  // 15f. Missing mailbox state skips the compile check entirely.
  {
    const fx = await fixtureRepo();
    try {
      if (!fx.linked) {
        rec(15, 'missing-mailbox-skips-compile', 'SKIP', 'could not link node_modules');
      } else {
        await fsp.writeFile(path.join(fx.repo, 'src', 'index.ts'), 'export const broken: number = "no";\n');
        git(fx.repo, 'add', '-A');
        const emptyRoot = path.join(fx.dir, 'no-bus');
        await fsp.mkdir(emptyRoot, { recursive: true });
        const result = runGuard(fx.repo, emptyRoot);
        rec(15, 'missing-mailbox-skips-compile', result.code === 0 ? 'NOTE' : 'NOTE',
          `exit=${result.code} out=${result.out.slice(0, 200)}. ${result.code === 0 ? 'No mailbox → exit 0, compile never runs. Intended for a non-shared tree; a wrong BUS_ROOT is the same skip.' : 'missing mailbox did not skip'}`);
      }
    } finally {
      await fx.cleanup();
    }
  }

  // 15g. Hatch still lands a broken commit through the guard (not through git).
  {
    const fx = await fixtureRepo();
    try {
      if (!fx.linked) {
        rec(15, 'hatch', 'SKIP', 'could not link node_modules');
      } else {
        await fsp.writeFile(path.join(fx.repo, 'src', 'index.ts'), 'export const broken: number = "no";\n');
        git(fx.repo, 'add', '-A');
        const result = runGuard(fx.repo, fx.busRoot, { BUS_ALLOW_BROKEN_BUILD: '1' });
        rec(15, 'hatch', result.code === 0 && /SKIPPED/.test(result.out) ? 'PASS' : 'FAIL',
          `exit=${result.code} out=${result.out.slice(0, 180)}`);
      }
    } finally {
      await fx.cleanup();
    }
  }
}

(async () => {
  console.log(`HEAD expected 082ddfa; probes against dist/ + scripts/claim-guard-cli.js`);
  await item13();
  await item10();
  await item18();
  await item15();
  const counts = results.reduce((acc, r) => {
    acc[r.status] = (acc[r.status] || 0) + 1;
    return acc;
  }, {});
  console.log('\n=== SUMMARY ===');
  console.log(JSON.stringify({ counts, results }, null, 2));
  await fsp.writeFile(path.join(REPO, 'tmp-audit-r3-out.json'), JSON.stringify({ counts, results }, null, 2));
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
