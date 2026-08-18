'use strict';
/**
 * Independent AUDIT instrument (grok), this session, round 3i.
 * Brief named 8ea4c35 / 082ddfa. HEAD is later (8b5ae78 item-15 compiler rule).
 * Report HEAD first. Attack dist/ + scripts/. Do not edit src/ or tests/. Item 2 left alone.
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
  const row = { item, name, status, detail: String(detail).slice(0, 4000) };
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

async function rm(dir) {
  await fsp.rm(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 }).catch(() => {});
}

async function findMessageFile(root, seq) {
  const dir = path.join(root, '.ai-bus', 'runtime', 'mailbox', 'inbox');
  const names = await fsp.readdir(dir);
  const match = names.find((name) => name.startsWith(`${String(seq).padStart(6, '0')}-`) || name.includes(`${seq}-`));
  if (!match) throw new Error(`no message file for #${seq}`);
  return path.join(dir, match);
}

// ---------------------------------------------------------------------------
// ITEM 13
// ---------------------------------------------------------------------------

async function claimFixture() {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'pab-r3i-13-'));
  const workspace = path.join(dir, 'ws');
  await fsp.mkdir(path.join(workspace, 'src'), { recursive: true });
  await fsp.writeFile(path.join(workspace, 'src', 'bus.ts'), 'x');
  await fsp.writeFile(path.join(workspace, 'README.md'), 'r');
  const busRoot = path.join(dir, 'bus');
  await fsp.mkdir(busRoot, { recursive: true });
  const store = new MailboxStore(busRoot);
  await store.ensureInitialized(['claude', 'codex'], 500);
  return { dir, workspace, busRoot, store };
}

async function attack13() {
  {
    const fx = await claimFixture();
    try {
      if (process.platform !== 'win32' || !dirSymlink(path.join(fx.workspace, 'above'), fx.dir)) {
        rec(13, 'symlink-to-parent', 'SKIP', 'directory symlink unavailable');
      } else {
        let refused = false;
        let why = '';
        try {
          await fx.store.claim({ agent: 'codex', paths: ['above'], why: 'parent via symlink', repoRoot: fx.workspace });
        } catch (error) {
          refused = /whole repositor|too broad/i.test(errMsg(error));
          why = errMsg(error);
        }
        const other = await fx.store.claim({
          agent: 'claude', paths: ['src/bus.ts'], why: 'still free', repoRoot: fx.workspace
        });
        rec(13, 'symlink-to-parent', refused && other ? 'PASS' : 'FAIL',
          refused ? `refused (${why}); other seat still claimed src/bus.ts` : `ACCEPTED symlink to parent; other=${Boolean(other)}`);
      }
    } finally {
      await rm(fx.dir);
    }
  }

  {
    const fx = await claimFixture();
    try {
      const linkRoot = path.join(fx.dir, 'ws-link');
      if (process.platform !== 'win32' || !junction(linkRoot, fx.workspace)) {
        rec(13, 'root-is-link', 'SKIP', 'junction unavailable');
      } else {
        const ok = await fx.store.claim({
          agent: 'claude', paths: ['src/bus.ts'], why: 'through linked root', repoRoot: linkRoot
        });
        await fx.store.release('claude');
        let rootRefused = false;
        try {
          await fx.store.claim({ agent: 'claude', paths: ['.'], why: 'dot through linked root', repoRoot: linkRoot });
        } catch (error) {
          rootRefused = /whole repositor|too broad|must be workspace-relative/i.test(errMsg(error));
        }
        rec(13, 'root-is-link', ok && rootRefused ? 'PASS' : 'FAIL',
          `file-through-link=${Boolean(ok)} dot-refused=${rootRefused}`);
      }
    } finally {
      await rm(fx.dir);
    }
  }

  {
    const fx = await claimFixture();
    try {
      const held = await fx.store.claim({
        agent: 'claude', paths: ['SRC/bus.ts'], why: 'odd case', repoRoot: fx.workspace
      });
      rec(13, 'windows-case', held ? 'PASS' : 'FAIL',
        held ? 'SRC/bus.ts accepted against folder src' : 'case difference refused an in-tree file');
    } catch (error) {
      rec(13, 'windows-case', 'FAIL', errMsg(error));
    } finally {
      await rm(fx.dir);
    }
  }

  {
    const fx = await claimFixture();
    try {
      if (process.platform !== 'win32' || !junction(path.join(fx.workspace, 'src', 'all'), fx.workspace)) {
        rec(13, 'under-root-blocks-tree', 'SKIP', 'junction unavailable');
      } else {
        const srcOk = await fx.store.claim({
          agent: 'codex', paths: ['src'], why: 'dir containing a portal', repoRoot: fx.workspace
        });
        let readmeBlocked = false;
        try {
          await fx.store.claim({ agent: 'claude', paths: ['README.md'], why: 'sibling of src', repoRoot: fx.workspace });
        } catch (error) {
          readmeBlocked = /conflict|held|claimed/i.test(errMsg(error));
        }
        await fx.store.release('codex');
        let portalRefused = false;
        try {
          await fx.store.claim({ agent: 'codex', paths: ['src/all'], why: 'the portal itself', repoRoot: fx.workspace });
        } catch (error) {
          portalRefused = /whole repositor|too broad/i.test(errMsg(error));
        }
        rec(13, 'under-root-blocks-tree', srcOk && !readmeBlocked && portalRefused ? 'PASS' : 'FAIL',
          `claim-src=${Boolean(srcOk)} readme-blocked=${readmeBlocked} portal-refused=${portalRefused}`);
      }
    } finally {
      await rm(fx.dir);
    }
  }

  {
    const fx = await claimFixture();
    try {
      const outside = path.join(fx.dir, 'outside.md');
      await fsp.writeFile(outside, 'x');
      if (!fileSymlink(path.join(fx.workspace, 'alias.md'), outside)) {
        rec(13, 'file-symlink-above', 'SKIP', 'file symlink unavailable');
      } else {
        let refused = false;
        try {
          await fx.store.claim({ agent: 'codex', paths: ['alias.md'], why: 'alias above', repoRoot: fx.workspace });
        } catch (error) {
          refused = /whole repositor|too broad/i.test(errMsg(error));
        }
        rec(13, 'file-symlink-above', refused ? 'PASS' : 'FAIL',
          refused ? 'file symlink to parent refused' : 'ACCEPTED a file symlink that lands above the root');
      }
    } finally {
      await rm(fx.dir);
    }
  }

  {
    const fx = await claimFixture();
    try {
      let refused = false;
      let why = '';
      try {
        await fx.store.claim({
          agent: 'codex', paths: ['src/bus.ts'], why: 'bad root',
          repoRoot: path.join(fx.workspace, 'does-not-exist')
        });
      } catch (error) {
        refused = /claim root does not exist/i.test(errMsg(error));
        why = errMsg(error);
      }
      rec(13, 'missing-root', refused ? 'PASS' : 'FAIL', refused ? why : 'missing root did not refuse as claimed');
    } finally {
      await rm(fx.dir);
    }
  }

  {
    const fx = await claimFixture();
    try {
      const held = await fx.store.claim({
        agent: 'claude', paths: ['src/../src/bus.ts'], why: 'normalises', repoRoot: fx.workspace
      });
      rec(13, 'dotdot-normalises', held ? 'PASS' : 'FAIL', 'src/../src/bus.ts should land as src/bus.ts');
    } catch (error) {
      rec(13, 'dotdot-normalises', 'FAIL', errMsg(error));
    } finally {
      await rm(fx.dir);
    }
  }
}

// ---------------------------------------------------------------------------
// ITEM 10
// ---------------------------------------------------------------------------

async function recallFixture() {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'pab-r3i-10-'));
  const store = new MailboxStore(dir);
  await store.ensureInitialized(['claude', 'grok', 'codex'], 500);
  const source = await store.send({
    from: 'claude', to: 'grok', kind: 'task',
    subject: 'ITEM 2 consolidation', body: 'PATHS: src/evidence.ts\nGATES: invalidate must not orphan.'
  });
  await store.openRecovery('grok', source.seq, 'started');
  return { dir, store, source };
}

async function attack10() {
  {
    const fx = await recallFixture();
    try {
      const moved = await fx.store.reassignBaton({ to: 'codex', reason: 'grok went dark', force: true });
      const pred = await fx.store.recallAssignment('grok', fx.source.seq);
      const succ = await fx.store.recallAssignment('codex', fx.source.seq);
      rec(10, 'inheritedFrom-not-authority',
        !pred && Boolean(succ) && moved.inheritedWorkId === fx.source.seq ? 'PASS' : 'FAIL',
        `pred=${pred ? 'BRIEF' : 'undefined'} succ=${succ ? 'BRIEF' : 'undefined'} inheritedWorkId=${moved.inheritedWorkId}`);
    } finally {
      await rm(fx.dir);
    }
  }

  {
    const fx = await recallFixture();
    try {
      const two = await fx.store.send({
        from: 'claude', to: 'grok', kind: 'task', subject: 'other work', body: 'NOT THE BRIEF'
      });
      const leaked = await fx.store.recallAssignment('grok', two.seq);
      await fx.store.reassignBaton({ to: 'codex', reason: 'move first', force: true });
      let opened = true;
      let openErr = '';
      try {
        await fx.store.openRecovery('grok', two.seq, 'second assignment');
      } catch (error) {
        opened = false;
        openErr = errMsg(error);
      }
      const resurrected = await fx.store.recallAssignment('grok', fx.source.seq);
      const twoOk = opened ? await fx.store.recallAssignment('grok', two.seq) : undefined;
      rec(10, 'different-workId', !leaked && !resurrected && (twoOk || !opened) ? 'PASS' : 'FAIL',
        `leak-before-open=${Boolean(leaked)} resurrected-#1=${Boolean(resurrected)} #2=${twoOk ? 'BRIEF' : 'undefined'} openErr=${openErr}`);
    } finally {
      await rm(fx.dir);
    }
  }

  {
    const fx = await recallFixture();
    try {
      await fx.store.reassignBaton({ to: 'codex', reason: 'hop 1', force: true });
      await fx.store.reassignBaton({ to: 'claude', reason: 'hop 2', force: true });
      const g = Boolean(await fx.store.recallAssignment('grok', fx.source.seq));
      const x = Boolean(await fx.store.recallAssignment('codex', fx.source.seq));
      const c = Boolean(await fx.store.recallAssignment('claude', fx.source.seq));
      rec(10, 'reassign-twice-forward', !g && !x && c ? 'PASS' : 'FAIL',
        `grok=${g} codex=${x} claude=${c} (only claude should recall)`);
    } finally {
      await rm(fx.dir);
    }
  }

  {
    const fx = await recallFixture();
    try {
      await fx.store.reassignBaton({ to: 'codex', reason: 'hop 1', force: true });
      await fx.store.reassignBaton({ to: 'grok', reason: 'back', force: true });
      const g = Boolean(await fx.store.recallAssignment('grok', fx.source.seq));
      const x = Boolean(await fx.store.recallAssignment('codex', fx.source.seq));
      rec(10, 'reassign-twice-back', g && !x ? 'PASS' : 'FAIL',
        `grok=${g} codex=${x} (only grok should recall after the work returns)`);
    } finally {
      await rm(fx.dir);
    }
  }

  {
    const fx = await recallFixture();
    try {
      await fx.store.reassignBaton({ to: 'codex', reason: 'moved', force: true });
      let refused = false;
      let why = '';
      try {
        await fx.store.openRecovery('grok', fx.source.seq, 're-opening what I lost');
      } catch (error) {
        refused = /held by codex/i.test(errMsg(error));
        why = errMsg(error);
      }
      const pred = await fx.store.recallAssignment('grok', fx.source.seq);
      rec(10, 'predecessor-cannot-reopen', refused && !pred ? 'PASS' : 'FAIL', why || 'predecessor reopened');
    } finally {
      await rm(fx.dir);
    }
  }

  {
    const fx = await recallFixture();
    try {
      await fx.store.send({
        from: 'claude', to: 'grok', kind: 'task', subject: 'replacement', body: 'new',
        supersedes: fx.source.seq, supersedeReason: 'retracted'
      });
      const recalled = await fx.store.recallAssignment('grok', fx.source.seq);
      rec(10, 'superseded-not-recalled', !recalled ? 'PASS' : 'FAIL',
        recalled ? 'retracted brief still recalled' : 'superseded source yields nothing');
    } finally {
      await rm(fx.dir);
    }
  }

  {
    const fx = await recallFixture();
    try {
      await fx.store.acknowledge('grok', [fx.source.seq]);
      const still = await fx.store.recallAssignment('grok', fx.source.seq);
      rec(10, 'consumed-still-recalled-while-open', still ? 'PASS' : 'FAIL',
        still ? 'open checkpoint still recalls a consumed brief' : 'consume revoked recall');
    } finally {
      await rm(fx.dir);
    }
  }

  {
    const src = fs.readFileSync(path.join(REPO, 'src', 'brain', 'bus-client.ts'), 'utf8');
    const dist = fs.readFileSync(path.join(REPO, 'dist', 'brain', 'bus-client.js'), 'utf8');
    const cli = fs.readFileSync(path.join(REPO, 'src', 'brain', 'cli.ts'), 'utf8');
    const runner = fs.readFileSync(path.join(REPO, 'src', 'brain', 'runner.ts'), 'utf8');
    rec(10, 'production-source-mentions-recall',
      /recallAssignment/.test(src) || /recallAssignment/.test(dist) ? 'NOTE' : 'FAIL',
      `bus-client src=${/recallAssignment/.test(src)} dist=${/recallAssignment/.test(dist)} cliUsesCliBusClient=${/cliBusClient\(/.test(cli)} runnerGuards=${/if \(bus\.recallAssignment\)/.test(runner)}`);

    const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'pab-r3i-10cli-'));
    try {
      const client = cliBusClient({ root: tmp, log() {} });
      rec(10, 'production-cliBusClient-wires-recall',
        typeof client.recallAssignment === 'function' ? 'PASS' : 'FAIL',
        `typeof client.recallAssignment = ${typeof client.recallAssignment}`);
    } finally {
      await rm(tmp);
    }
  }
}

// ---------------------------------------------------------------------------
// ITEM 18
// ---------------------------------------------------------------------------

async function attack18() {
  const props = PLAN_SCHEMA?.properties?.actions?.items?.properties
    ?? PLAN_SCHEMA?.properties?.actions?.items?.oneOf?.[0]?.properties;
  rec(18, 'plan-schema-has-supersedes',
    props && props.supersedes && props.supersedeReason ? 'PASS' : 'FAIL',
    props ? `keys=${Object.keys(props).join(',')}` : 'no action properties');

  const system = buildDefaultSystem('claude');
  const text = Array.isArray(system) ? system.join('\n') : String(system);
  rec(18, 'system-prompt-describes-atomic',
    /supersedes/.test(text) && /one step|ONE step/i.test(text) ? 'PASS' : 'FAIL',
    /supersedes/.test(text) ? 'prompt names supersedes and one-step' : 'prompt missing atomic retract');

  const args = buildGrokArgs('hello', PLAN_SCHEMA);
  const schemaIdx = args.indexOf('--json-schema');
  const schemaJson = schemaIdx >= 0 ? args[schemaIdx + 1] : '';
  rec(18, 'schema-reaches-provider-argv',
    schemaJson.includes('"supersedes"') ? 'PASS' : 'FAIL',
    schemaIdx >= 0
      ? `--json-schema present; supersedes=${schemaJson.includes('"supersedes"')}`
      : 'buildGrokArgs did not emit --json-schema');

  const agentSrc = fs.readFileSync(path.join(REPO, 'src', 'brain', 'brains', 'agent.ts'), 'utf8');
  const askSites = agentSrc.match(/responseSchema:\s*PLAN_SCHEMA/g) || [];
  rec(18, 'agent-passes-schema-on-ask',
    askSites.length >= 2 ? 'PASS' : 'FAIL',
    `PLAN_SCHEMA passed on ${askSites.length} ask() site(s)`);

  {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'pab-r3i-18x-'));
    try {
      const store = new MailboxStore(dir);
      await store.ensureInitialized(['claude', 'grok', 'codex'], 500);
      const toGrok = await store.send({ from: 'claude', to: 'grok', kind: 'task', subject: 'do X', body: 'X' });
      let atomicRefused = false;
      try {
        await store.send({
          from: 'claude', to: 'codex', kind: 'task', subject: 'replacement', body: 'Y', supersedes: toGrok.seq
        });
      } catch (error) {
        atomicRefused = /sent to grok, not codex/i.test(errMsg(error));
      }
      const inbox = await store.inbox('grok');
      const replacement = await store.send({ from: 'claude', to: 'codex', kind: 'task', subject: 'other', body: 'Z' });
      let twoStepRefused = false;
      try {
        await store.supersedeMessage(toGrok.seq, replacement.seq, 'redirect', 'claude');
      } catch (error) {
        twoStepRefused = /addressed to codex, not grok/i.test(errMsg(error));
      }
      rec(18, 'cross-recipient-both-verbs',
        atomicRefused && twoStepRefused && inbox.length === 1 && inbox[0].seq === toGrok.seq ? 'PASS' : 'FAIL',
        `atomicRefused=${atomicRefused} twoStepRefused=${twoStepRefused} grokInbox=${inbox.map((m) => m.seq).join(',') || '-'}`);
    } finally {
      await rm(dir);
    }
  }

  {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'pab-r3i-18c-'));
    try {
      const store = new MailboxStore(dir);
      await store.ensureInitialized(['claude', 'grok'], 500);
      const original = await store.send({ from: 'claude', to: 'grok', kind: 'task', subject: 'do X', body: 'X' });
      await store.acknowledge('grok', [original.seq]);
      const atomic = await store.send({
        from: 'claude', to: 'grok', kind: 'task', subject: 'do Y', body: 'Y', supersedes: original.seq
      });
      const reread = JSON.parse(await fsp.readFile(await findMessageFile(dir, original.seq), 'utf8'));
      const atomicPolicy = atomic.superseded === false
        && atomic.supersedeOutcome === 'target-consumed'
        && reread.supersededBy === undefined;

      const second = await store.send({ from: 'claude', to: 'grok', kind: 'task', subject: 'do Z', body: 'Z' });
      let twoStepThrew = false;
      try {
        await store.supersedeMessage(original.seq, second.seq, 'changed my mind', 'claude');
      } catch (error) {
        twoStepThrew = /already read/i.test(errMsg(error));
      }
      const reread2 = JSON.parse(await fsp.readFile(await findMessageFile(dir, original.seq), 'utf8'));
      rec(18, 'consumed-neither-marks',
        atomicPolicy && twoStepThrew && reread2.supersededBy === undefined ? 'PASS' : 'FAIL',
        `atomic.superseded=${atomic.superseded} outcome=${atomic.supersedeOutcome} twoStepThrew=${twoStepThrew} marked=${reread2.supersededBy}`);
    } finally {
      await rm(dir);
    }
  }

  {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'pab-r3i-18t-'));
    try {
      const store = new MailboxStore(dir);
      await store.ensureInitialized(['claude', 'grok'], 500);
      const original = await store.send({ from: 'claude', to: 'grok', kind: 'task', subject: 'stale', body: 'old' });
      const correction = await store.send({
        from: 'claude', to: 'grok', kind: 'task', subject: 'fresh', body: 'new',
        supersedes: original.seq, supersedeReason: 'settled already'
      });
      const raw = JSON.parse(await fsp.readFile(await findMessageFile(dir, original.seq), 'utf8'));
      rec(18, 'atomic-writes-supersededAt',
        correction.superseded === true && raw.supersededBy === correction.seq && raw.supersededAt && raw.supersedeReason === 'settled already'
          ? 'PASS' : 'FAIL',
        `superseded=${correction.superseded} by=${raw.supersededBy} at=${raw.supersededAt} reason=${raw.supersedeReason}`);
    } finally {
      await rm(dir);
    }
  }

  {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'pab-r3i-18r-'));
    try {
      const store = new MailboxStore(dir);
      await store.ensureInitialized(['claude', 'grok'], 500);
      const original = await store.send({ from: 'claude', to: 'grok', kind: 'task', subject: 'stale', body: 'old' });
      const atomic = await store.send({
        from: 'claude', to: 'grok', kind: 'task', subject: 'fresh', body: 'new',
        supersedes: original.seq, supersedeReason: '   '
      });
      const raw = JSON.parse(await fsp.readFile(await findMessageFile(dir, original.seq), 'utf8'));
      const two = await store.send({ from: 'claude', to: 'grok', kind: 'task', subject: 'later', body: 'z' });
      let twoStepEmpty = false;
      try {
        await store.supersedeMessage(two.seq, two.seq + 1, '   ', 'claude');
      } catch (error) {
        twoStepEmpty = /reason must not be empty/i.test(errMsg(error));
      }
      rec(18, 'empty-reason-disagreement',
        'NOTE',
        `atomic whitespace reason defaulted to "${raw.supersedeReason}" and retracted=${Boolean(raw.supersededBy)}; two-step empty reason refused=${twoStepEmpty}. Shape disagreement, not who-may-retract.`);
    } finally {
      await rm(dir);
    }
  }
}

// ---------------------------------------------------------------------------
// ITEM 15
// ---------------------------------------------------------------------------

async function writeBus(busRoot) {
  const mailboxDir = path.join(busRoot, '.ai-bus', 'runtime', 'mailbox');
  await fsp.mkdir(mailboxDir, { recursive: true });
  await fsp.writeFile(path.join(mailboxDir, 'state.json'),
    JSON.stringify({ claims: { claude: [{ path: 'src' }, { path: 'tsconfig.json' }] } }));
}

async function seedRepo() {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'pab-r3i-15-'));
  const repo = path.join(dir, 'repo');
  const busRoot = path.join(dir, 'bus');
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
  await writeBus(busRoot);
  return { dir, repo, busRoot };
}

async function linkWholeModules(repo) {
  return junction(path.join(repo, 'node_modules'), path.join(REPO, 'node_modules'));
}

async function plantOwnModules(repo) {
  const nm = path.join(repo, 'node_modules');
  await fsp.mkdir(nm, { recursive: true });
  const ts = junction(path.join(nm, 'typescript'), path.join(REPO, 'node_modules', 'typescript'));
  const bin = junction(path.join(nm, '.bin'), path.join(REPO, 'node_modules', '.bin'));
  return ts && bin;
}

async function plantLeakConfig(repo, includePath, packageName = 'leak-config') {
  const pkg = path.join(repo, 'node_modules', packageName);
  await fsp.mkdir(pkg, { recursive: true });
  await fsp.writeFile(path.join(pkg, 'package.json'), JSON.stringify({
    name: packageName,
    version: '1.0.0'
  }));
  await fsp.writeFile(path.join(pkg, 'tsconfig.json'), JSON.stringify({
    compilerOptions: { strict: true, noEmit: true, skipLibCheck: true, types: [] },
    include: [includePath.replace(/\\/g, '/')]
  }, null, 2));
}

async function attack15() {
  {
    const fx = await seedRepo();
    try {
      if (!await linkWholeModules(fx.repo)) {
        rec(15, 'honest-green', 'SKIP', 'could not link node_modules');
      } else {
        git(fx.repo, 'add', '-A');
        const result = runGuard(fx.repo, fx.busRoot);
        rec(15, 'honest-green', result.code === 0 && /compile OK \(staged index\)/.test(result.out) ? 'PASS' : 'FAIL',
          `code=${result.code} out=${result.out.trim()}`);
      }
    } finally {
      await rm(fx.dir);
    }
  }

  {
    const fx = await seedRepo();
    try {
      if (!await linkWholeModules(fx.repo)) {
        rec(15, 'staged-type-error-red', 'SKIP', 'could not link node_modules');
      } else {
        await fsp.writeFile(path.join(fx.repo, 'src', 'index.ts'), 'export const broken: number = "no";\n');
        git(fx.repo, 'add', '-A');
        const result = runGuard(fx.repo, fx.busRoot);
        rec(15, 'staged-type-error-red',
          result.code === 1 && /TS2322|does not compile/i.test(result.out) ? 'PASS' : 'FAIL',
          `code=${result.code} out=${result.out.trim().slice(0, 500)}`);
      }
    } finally {
      await rm(fx.dir);
    }
  }

  {
    const fx = await seedRepo();
    try {
      if (!await linkWholeModules(fx.repo)) {
        rec(15, 'absolute-include-refused', 'SKIP', 'could not link node_modules');
      } else {
        await fsp.writeFile(path.join(fx.repo, 'src', 'index.ts'), 'export const broken: number = "no";\n');
        await fsp.writeFile(path.join(fx.repo, 'tsconfig.json'), JSON.stringify({
          compilerOptions: { strict: true, noEmit: true, skipLibCheck: true, types: [] },
          include: [path.join(fx.repo, 'src').replace(/\\/g, '/')]
        }, null, 2));
        git(fx.repo, 'add', '-A');
        await fsp.writeFile(path.join(fx.repo, 'src', 'index.ts'), 'export const good: number = 1;\n');
        const result = runGuard(fx.repo, fx.busRoot);
        rec(15, 'absolute-include-refused',
          result.code === 1 && /OUTSIDE the staged tree/i.test(result.out) ? 'PASS' : 'FAIL',
          `code=${result.code} out=${result.out.trim().slice(0, 500)}`);
      }
    } finally {
      await rm(fx.dir);
    }
  }

  {
    const fx = await seedRepo();
    try {
      if (!await linkWholeModules(fx.repo)) {
        rec(15, 'untracked-extends-refused', 'SKIP', 'could not link node_modules');
      } else {
        await fsp.writeFile(path.join(fx.repo, 'src', 'index.ts'), 'export const broken: number = "no";\n');
        await fsp.writeFile(path.join(fx.repo, 'tsconfig.worktree-only.json'), JSON.stringify({
          compilerOptions: { strict: true, noEmit: true, skipLibCheck: true, types: [] },
          include: ['src/ok.ts']
        }, null, 2));
        await fsp.writeFile(path.join(fx.repo, 'tsconfig.json'), JSON.stringify({
          extends: path.join(fx.repo, 'tsconfig.worktree-only.json').replace(/\\/g, '/')
        }, null, 2));
        git(fx.repo, 'add', 'src', 'tsconfig.json', '.gitignore');
        const result = runGuard(fx.repo, fx.busRoot);
        rec(15, 'untracked-extends-refused',
          result.code === 1 && /OUTSIDE the staged tree|extends/i.test(result.out) ? 'PASS' : 'FAIL',
          `code=${result.code} out=${result.out.trim().slice(0, 500)}`);
      }
    } finally {
      await rm(fx.dir);
    }
  }

  {
    const fx = await seedRepo();
    try {
      if (!await linkWholeModules(fx.repo)) {
        rec(15, 'hatch-is-loud', 'SKIP', 'could not link node_modules');
      } else {
        await fsp.writeFile(path.join(fx.repo, 'src', 'index.ts'), 'export const broken: number = "no";\n');
        git(fx.repo, 'add', '-A');
        const result = runGuard(fx.repo, fx.busRoot, { BUS_ALLOW_BROKEN_BUILD: '1' });
        rec(15, 'hatch-is-loud',
          result.code === 0 && /SKIPPED/i.test(result.out) ? 'PASS' : 'FAIL',
          `code=${result.code} out=${result.out.trim().slice(0, 400)}`);
      }
    } finally {
      await rm(fx.dir);
    }
  }

  // Named class attack: bare extends of a local package whose include is the worktree.
  async function bareExtends(name, extendsValue, restoreWorktree) {
    const fx = await seedRepo();
    try {
      if (!await plantOwnModules(fx.repo)) {
        rec(15, name, 'SKIP', 'could not plant own node_modules');
        return;
      }
      await plantLeakConfig(fx.repo, path.join(fx.repo, 'src'));
      await fsp.writeFile(path.join(fx.repo, 'src', 'index.ts'), 'export const broken: number = "no";\n');
      await fsp.writeFile(path.join(fx.repo, 'tsconfig.json'), JSON.stringify({
        extends: extendsValue
      }, null, 2));
      git(fx.repo, 'add', '-A');
      if (restoreWorktree) {
        await fsp.writeFile(path.join(fx.repo, 'src', 'index.ts'), 'export const good: number = 1;\n');
      }
      const result = runGuard(fx.repo, fx.busRoot);
      rec(15, name,
        result.code === 1 ? 'PASS' : 'FAIL',
        `code=${result.code} out=${result.out.trim().slice(0, 800)}`);
    } finally {
      await rm(fx.dir);
    }
  }

  await bareExtends('bare-extends-package-file', 'leak-config/tsconfig.json', true);
  await bareExtends('bare-extends-array', ['leak-config/tsconfig.json'], true);
  await bareExtends('bare-extends-package-name', 'leak-config', true);
  await bareExtends('bare-extends-control-worktree-also-broken', 'leak-config/tsconfig.json', false);

  {
    const fx = await seedRepo();
    try {
      if (!await plantOwnModules(fx.repo)) {
        rec(15, 'relative-extends-same-package', 'SKIP', 'could not plant own node_modules');
      } else {
        await plantLeakConfig(fx.repo, path.join(fx.repo, 'src'));
        await fsp.writeFile(path.join(fx.repo, 'src', 'index.ts'), 'export const broken: number = "no";\n');
        await fsp.writeFile(path.join(fx.repo, 'tsconfig.json'), JSON.stringify({
          extends: './node_modules/leak-config/tsconfig.json'
        }, null, 2));
        git(fx.repo, 'add', '-A');
        await fsp.writeFile(path.join(fx.repo, 'src', 'index.ts'), 'export const good: number = 1;\n');
        const result = runGuard(fx.repo, fx.busRoot);
        rec(15, 'relative-extends-same-package',
          result.code === 1 && /OUTSIDE the staged tree|include/i.test(result.out) ? 'PASS' : 'FAIL',
          `code=${result.code} out=${result.out.trim().slice(0, 600)}`);
      }
    } finally {
      await rm(fx.dir);
    }
  }

  {
    const fx = await seedRepo();
    try {
      if (!await plantOwnModules(fx.repo)) {
        rec(15, 'node-modules-junction-include', 'SKIP', 'could not plant own node_modules');
      } else {
        const leakSrc = path.join(fx.repo, 'node_modules', 'leak-src');
        if (!junction(leakSrc, path.join(fx.repo, 'src'))) {
          rec(15, 'node-modules-junction-include', 'SKIP', 'could not junction leak-src');
        } else {
          await fsp.writeFile(path.join(fx.repo, 'src', 'index.ts'), 'export const broken: number = "no";\n');
          await fsp.writeFile(path.join(fx.repo, 'tsconfig.json'), JSON.stringify({
            compilerOptions: { strict: true, noEmit: true, skipLibCheck: true, types: [] },
            include: ['node_modules/leak-src']
          }, null, 2));
          git(fx.repo, 'add', '-A');
          await fsp.writeFile(path.join(fx.repo, 'src', 'index.ts'), 'export const good: number = 1;\n');
          const result = runGuard(fx.repo, fx.busRoot);
          rec(15, 'node-modules-junction-include',
            result.code === 1 ? 'PASS' : 'FAIL',
            `code=${result.code} out=${result.out.trim().slice(0, 600)}`);
        }
      }
    } finally {
      await rm(fx.dir);
    }
  }
}

async function main() {
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO, encoding: 'utf8' }).trim();
  const log = execFileSync('git', ['log', '-6', '--oneline'], { cwd: REPO, encoding: 'utf8' }).trim();
  console.log(`HEAD=${head}`);
  console.log(log);
  console.log('---');
  await attack13();
  await attack10();
  await attack18();
  await attack15();

  const byItem = {};
  for (const row of results) {
    byItem[row.item] ??= { PASS: 0, FAIL: 0, SKIP: 0, NOTE: 0 };
    byItem[row.item][row.status] = (byItem[row.item][row.status] || 0) + 1;
  }
  const summary = { head, byItem, results };
  const outPath = path.join(REPO, 'tmp-audit-r3i-grok-out.json');
  await fsp.writeFile(outPath, JSON.stringify(summary, null, 2));
  console.log('---');
  console.log(JSON.stringify(byItem, null, 2));
  console.log(`wrote ${outPath}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
