'use strict';
/**
 * Live attacks against 0472056 + 6480d81 at current HEAD.
 * Does not edit src/ or tests/. Writes only this untracked probe and a report.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { MailboxStore } = require('./dist/mailbox.js');
const { cliBusClient } = require('./dist/brain/bus-client.js');
const { PLAN_SCHEMA, buildDefaultSystem } = require('./dist/brain/brains/agent.js');

const results = [];
function record(item, name, pass, detail) {
  results.push({ item, name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  [${item}] ${name}\n       ${detail}`);
}

function junctionsAvailable(link, target) {
  try {
    execFileSync('cmd.exe', ['/c', 'mklink', '/J', link, target], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

async function withStore(prefix, seats = ['claude', 'grok', 'codex']) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), prefix));
  const store = new MailboxStore(root);
  await store.ensureInitialized(seats, 500);
  return { store, root, cleanup: () => fsp.rm(root, { recursive: true, force: true, maxRetries: 8 }) };
}

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
  const missing = await tools.claim(['src/mailbox.ts']);
  const ws = await tools.claim(['src/mailbox.ts'], '   ');
  const wireEmpty = calls.length === 0
    && empty && typeof empty.refused === 'string'
    && !JSON.stringify(empty).includes('unstated')
    && missing && typeof missing.refused === 'string'
    && ws && typeof ws.refused === 'string';
  record(7, 'empty/missing/whitespace why refused, never reaches mailbox, no unstated',
    wireEmpty,
    wireEmpty
      ? `refusals: ${JSON.stringify({ empty, missing, ws })}`
      : `leaked or invented: calls=${JSON.stringify(calls)} empty=${JSON.stringify(empty)}`);

  await tools.claim(['src/mailbox.ts'], 'item 18 wiring');
  const forwarded = calls.length === 1 && calls[0].input.why === 'item 18 wiring';
  record(7, 'real why forwarded untouched', forwarded, JSON.stringify(calls[0]));

  const { store, cleanup } = await withStore('pab-i7-');
  try {
    let threw = false;
    try { await store.claim({ agent: 'grok', paths: ['src'], why: '' }); }
    catch (e) { threw = /why|reason/i.test(String(e && e.message)); }
    record(7, 'store still refuses empty why', threw, threw ? 'ClaimReasonRequiredError' : 'store accepted empty why');
  } finally { await cleanup(); }
}

async function item13() {
  const { store, root, cleanup } = await withStore('pab-i13-');
  try {
    await fsp.mkdir(path.join(root, 'src'), { recursive: true });
    await fsp.writeFile(path.join(root, 'src', 'bus.ts'), 'x');

    const lexical = [];
    for (const spelling of ['.', './', 'src/..', 'src/../.', 'src/foo/../..']) {
      try {
        await store.claim({ agent: 'codex', paths: [spelling], why: 'lexical root' });
        lexical.push({ spelling, accepted: true });
      } catch (e) {
        lexical.push({ spelling, accepted: false, err: String(e.message).slice(0, 80) });
      }
    }
    const lexicalClosed = lexical.every((row) => !row.accepted);
    record(13, 'lexical whole-repo spellings refused', lexicalClosed, JSON.stringify(lexical));

    if (process.platform !== 'win32' || !junctionsAvailable(path.join(root, 'everything'), root)) {
      record(13, 'junction attacks', false, 'junctions unavailable; cannot confirm');
      return;
    }

    try {
      await store.claim({ agent: 'codex', paths: ['everything'], why: 'junction to mailbox root' });
      record(13, 'junction everything -> mailbox root', false, 'ACCEPTED — original attack still open');
    } catch (e) {
      const refused = /whole repositor|too broad/i.test(e.message);
      record(13, 'junction everything -> mailbox root', refused, e.message);
    }

    // nested alias
    await fsp.mkdir(path.join(root, 'decoy'), { recursive: true });
    if (junctionsAvailable(path.join(root, 'decoy', 'all'), root)) {
      try {
        await store.claim({ agent: 'codex', paths: ['decoy/all'], why: 'nested junction to root' });
        record(13, 'nested decoy/all -> root', false, 'ACCEPTED');
      } catch (e) {
        record(13, 'nested decoy/all -> root', /whole repositor|too broad/i.test(e.message), e.message);
      }
    }

    // path resolving to BUS root rather than repo root
    const repoDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'pab-i13-repo-'));
    await fsp.mkdir(path.join(repoDir, 'src'), { recursive: true });
    await fsp.writeFile(path.join(repoDir, 'src', 'bus.ts'), 'y');
    if (junctionsAvailable(path.join(repoDir, 'busroot'), root)) {
      try {
        await store.claim({
          agent: 'codex',
          paths: ['busroot'],
          why: 'junction in repo pointing at bus root',
          repoRoot: repoDir
        });
        record(13, 'junction in repo -> BUS root (repoRoot set)', false, 'ACCEPTED — bus root not treated as a claim root');
      } catch (e) {
        record(13, 'junction in repo -> BUS root (repoRoot set)',
          /whole repositor|too broad/i.test(e.message), e.message);
      }
    }

    // missing/ghost repoRoot + foreign tree
    const ghost = path.join(os.tmpdir(), 'pab-i13-ghost-does-not-exist-' + Date.now());
    const foreign = await fsp.mkdtemp(path.join(os.tmpdir(), 'pab-i13-foreign-'));
    await fsp.writeFile(path.join(foreign, 'secret.ts'), 'z');
    if (junctionsAvailable(path.join(root, 'otherrepo'), foreign)) {
      try {
        const held = await store.claim({
          agent: 'codex',
          paths: ['otherrepo'],
          why: 'ghost repoRoot plus foreign junction',
          repoRoot: ghost
        });
        record(13, 'ghost repoRoot + foreign junction', false,
          `ACCEPTED held=${JSON.stringify(held.map((c) => c.path))} — missing root skipped in identity check`);
        await store.release('codex');
      } catch (e) {
        record(13, 'ghost repoRoot + foreign junction', true, `refused: ${e.message}`);
      }
    }
    await fsp.rm(foreign, { recursive: true, force: true });
    await fsp.rm(repoDir, { recursive: true, force: true });

    // parent-of-root junction
    const parent = path.dirname(root);
    if (junctionsAvailable(path.join(root, 'up'), parent)) {
      try {
        const held = await store.claim({ agent: 'codex', paths: ['up'], why: 'junction to parent of root' });
        let blocked = false;
        let blockErr = '';
        try {
          await store.claim({ agent: 'grok', paths: ['src/bus.ts'], why: 'should still be free if up is not everything' });
        } catch (e) {
          blocked = true;
          blockErr = e.message;
        }
        record(13, 'parent-of-root junction (equality-to-root only)', false,
          `ACCEPTED held=${JSON.stringify(held.map((c) => ({ p: c.path, id: c.identity })))}; src/bus.ts ${blocked ? 'BLOCKED: ' + blockErr : 'still free'}`);
        await store.release('codex').catch(() => {});
      } catch (e) {
        record(13, 'parent-of-root junction (equality-to-root only)', true, `refused: ${e.message}`);
      }
    }

    // green control
    const below = await store.claim({ agent: 'grok', paths: ['src'], why: 'ancestor below root' });
    record(13, 'green: ancestor claim below root still succeeds',
      below.some((c) => c.path === 'src'), JSON.stringify(below.map((c) => c.path)));
  } finally {
    await cleanup();
  }
}

async function item10() {
  const { store, cleanup } = await withStore('pab-i10-');
  try {
    const source = await store.send({
      from: 'claude', to: 'grok', kind: 'task',
      subject: 'ITEM 18 wiring', body: 'PATHS: src/harness.ts\nGATES: supersedes reaches every surface.'
    });
    await store.openRecovery('grok', source.seq, 'started');
    const moved = await store.reassignBaton({ to: 'codex', reason: 'grok went dark', force: true });
    const successor = await store.recallAssignment('codex', source.seq);
    const uninvolved = await store.recallAssignment('claude', source.seq);
    const predecessor = await store.recallAssignment('grok', source.seq);

    record(10, 'successor after reassignBaton recalls brief',
      Boolean(successor) && /PATHS: src\/harness\.ts/.test(successor),
      `moved=${moved.moved} inherited=${moved.inheritedWorkId} recall=${String(successor).slice(0, 80)}`);
    record(10, 'uninvolved seat recalls nothing',
      uninvolved === undefined, String(uninvolved));
    record(10, 'predecessor-after-baton still recalls (address short-circuit)',
      predecessor === undefined,
      predecessor
        ? 'FAIL attack predecessor-after-baton: message.to is still grok, checkpoint check skipped, predecessor got the brief'
        : 'predecessor could not recall');

    // close successor, predecessor still addressee
    await store.closeRecovery('codex', source.seq, 'done');
    const closedSuccessor = await store.recallAssignment('codex', source.seq);
    const closedAddressee = await store.recallAssignment('grok', source.seq);
    record(10, 'closed successor (non-addressee) recalls nothing',
      closedSuccessor === undefined, String(closedSuccessor));
    record(10, 'closed-checkpoint-addressee still recalls',
      closedAddressee === undefined,
      closedAddressee
        ? 'FAIL attack closed-checkpoint-addressee: after all open rows closed, addressee still got the brief'
        : 'addressee could not recall after close');

    // addressee own close without inherit
    const own = await store.send({
      from: 'claude', to: 'grok', kind: 'task', subject: 'solo', body: 'own close'
    });
    await store.openRecovery('grok', own.seq, 'started');
    await store.closeRecovery('grok', own.seq, 'settled');
    const afterOwnClose = await store.recallAssignment('grok', own.seq);
    record(10, 'addressee-after-own-close still recalls',
      afterOwnClose === undefined,
      afterOwnClose
        ? 'FAIL attack addressee-after-own-close: closeRecovery then recall still returns the brief'
        : 'own close revoked recall');

    // predecessor can reopen after inherit
    const src2 = await store.send({
      from: 'claude', to: 'grok', kind: 'task', subject: 'reopen', body: 'PATHS: src/mailbox.ts'
    });
    await store.openRecovery('grok', src2.seq, 'started');
    await store.reassignBaton({ to: 'codex', reason: 'again', force: true });
    let reopenErr = null;
    try { await store.openRecovery('grok', src2.seq, 'I am still here'); }
    catch (e) { reopenErr = e.message; }
    const grokAgain = await store.recallAssignment('grok', src2.seq);
    const codexStill = await store.recallAssignment('codex', src2.seq);
    record(10, 'addressee-reopen-after-inherit (both open on same workId)',
      Boolean(reopenErr) || !(grokAgain && codexStill),
      reopenErr
        ? `predecessor reopen refused: ${reopenErr}`
        : `BOTH recall: grok=${Boolean(grokAgain)} codex=${Boolean(codexStill)}`);

    const client = cliBusClient({ root: 'C:/nowhere', async callSeatTool() { return {}; } });
    record(10, 'production cliBusClient implements recallAssignment',
      typeof client.recallAssignment === 'function',
      typeof client.recallAssignment === 'function'
        ? 'wired'
        : 'FAIL attack production-wiring: runner only recalls if (bus.recallAssignment); cli.ts passes cliBusClient; production brains never recall');
  } finally {
    await cleanup();
  }
}

async function item18() {
  const calls = [];
  const tools = cliBusClient({
    root: 'C:/nowhere',
    async callSeatTool(_o, name, input) {
      calls.push({ name, input });
      return { ok: true };
    }
  }).tools('grok');

  await tools.send({
    to: 'claude', kind: 'task', subject: 'correction', body: 'use the index',
    supersedes: 1764, supersedeReason: 'earlier instruction wrong'
  });
  const wired = calls[0] && calls[0].input.supersedes === 1764 && calls[0].input.supersedeReason === 'earlier instruction wrong';
  record(18, 'brain client forwards supersedes/reason', wired, JSON.stringify(calls[0]));

  await tools.send({ to: 'claude', kind: 'note', subject: 'plain', body: 'no retraction' });
  const plain = !('supersedes' in calls[1].input) && !('supersedeReason' in calls[1].input);
  record(18, 'plain send carries neither field', plain, JSON.stringify(calls[1].input));

  await tools.send({ to: 'claude', kind: 'task', subject: 'junk', body: 'b', supersedes: 'seventeen' });
  const dropped = !('supersedes' in calls[2].input);
  record(18, 'malformed supersedes dropped rather than failing send', dropped, JSON.stringify(calls[2].input));

  const props = PLAN_SCHEMA.properties.actions.items.properties;
  const schemaHas = 'supersedes' in props && 'supersedeReason' in props;
  record(18, 'PLAN_SCHEMA lists supersedes/supersedeReason', schemaHas,
    schemaHas
      ? 'present'
      : `FAIL attack missed-surface PLAN_SCHEMA: properties=${Object.keys(props).join(',')}`);

  let prompt;
  try {
    prompt = typeof buildDefaultSystem === 'function' ? buildDefaultSystem('claude') : '';
  } catch {
    prompt = '';
  }
  // buildDefaultSystem may not be exported; read the schema-adjacent prompt from the module source via require cache is enough.
  const agentSrc = fs.readFileSync(path.join(__dirname, 'src', 'brain', 'brains', 'agent.ts'), 'utf8');
  const promptLine = (agentSrc.match(/send requires string fields[^']+/) || ['(not found)'])[0];
  const promptMentions = /supersedes/.test(promptLine);
  record(18, 'system prompt names supersedes on send', promptMentions,
    promptMentions ? 'named' : `FAIL attack missed-surface prompt: ${promptLine}`);

  const { store, cleanup } = await withStore('pab-i18-');
  try {
    const unread = await store.send({ from: 'claude', to: 'grok', kind: 'task', subject: 'stale', body: 'old' });
    const correction = await store.send({
      from: 'claude', to: 'grok', kind: 'task', subject: 'correction', body: 'new',
      supersedes: unread.seq, supersedeReason: 'settled'
    });
    function row(seq) {
      const name = fs.readdirSync(store.paths.inboxDir).find((n) => n.startsWith(String(seq).padStart(6, '0')));
      if (!name) throw new Error(`no inbox file for #${seq} in ${store.paths.inboxDir}: ${fs.readdirSync(store.paths.inboxDir).join(',')}`);
      return JSON.parse(fs.readFileSync(path.join(store.paths.inboxDir, name), 'utf8'));
    }
    const reread = row(unread.seq);
    record(18, 'atomic unread retract removes original from inbox',
      !(await store.inbox('grok')).some((m) => m.seq === unread.seq) && correction.superseded === true,
      `inbox=${(await store.inbox('grok')).map((m) => m.seq)} superseded=${correction.superseded} original.supersededBy=${reread.supersededBy} original.supersededAt=${reread.supersededAt}`);

    // consumed target: atomic vs two-step
    const consumed = await store.send({ from: 'claude', to: 'grok', kind: 'task', subject: 'read', body: 'acted' });
    await store.acknowledge('grok', [consumed.seq]);
    const late = await store.send({
      from: 'claude', to: 'grok', kind: 'note', subject: 'too late', body: 'correction',
      supersedes: consumed.seq
    });
    const consumedRow = row(consumed.seq);
    const twoStepTarget = await store.send({ from: 'claude', to: 'grok', kind: 'task', subject: 'read2', body: 'acted2' });
    await store.acknowledge('grok', [twoStepTarget.seq]);
    const twoStepRepl = await store.send({ from: 'claude', to: 'grok', kind: 'note', subject: 'repl', body: 'new2' });
    const twoStep = await store.supersedeMessage(twoStepTarget.seq, twoStepRepl.seq, 'anyway', 'claude');
    record(18, 'two-step vs atomic on consumed target',
      late.superseded === false && late.supersedeOutcome === 'target-consumed' && consumedRow.supersededBy === undefined
        && twoStep.supersededBy === twoStepRepl.seq,
      `atomic: superseded=${late.superseded} outcome=${late.supersedeOutcome} target.supersededBy=${consumedRow.supersededBy}; two-step wrote supersededBy=${twoStep.supersededBy} supersededAt=${twoStep.supersededAt}. NOT identical.`);

    // recipient change
    const grokMail = await store.send({ from: 'claude', to: 'grok', kind: 'task', subject: 'for grok', body: 'old brief' });
    let atomicXRecipient;
    try {
      atomicXRecipient = await store.send({
        from: 'claude', to: 'codex', kind: 'task', subject: 'for codex', body: 'moved',
        supersedes: grokMail.seq
      });
    } catch (e) {
      atomicXRecipient = { error: e.message };
    }
    const grokAfter = row(grokMail.seq);
    const twoA = await store.send({ from: 'claude', to: 'grok', kind: 'task', subject: 'for grok2', body: 'old2' });
    const twoB = await store.send({ from: 'claude', to: 'codex', kind: 'task', subject: 'for codex2', body: 'new2' });
    let twoStepX;
    try { twoStepX = await store.supersedeMessage(twoA.seq, twoB.seq, 'move seat', 'claude'); }
    catch (e) { twoStepX = { error: e.message }; }
    const atomicSucceeded = atomicXRecipient && !atomicXRecipient.error && grokAfter.supersededBy === atomicXRecipient.seq;
    const twoStepRefused = Boolean(twoStepX && twoStepX.error);
    record(18, 'two-step vs atomic on recipient change',
      !(atomicSucceeded && twoStepRefused),
      `atomic ${atomicSucceeded ? 'SUCCEEDED and retracted grok brief while delivering to codex' : JSON.stringify(atomicXRecipient)}; two-step ${twoStepRefused ? 'REFUSED: ' + twoStepX.error : 'accepted'}. NOT identical.`);

    record(18, 'atomic writes supersededAt like two-step',
      Boolean(reread.supersededAt),
      reread.supersededAt
        ? `atomic supersededAt=${reread.supersededAt}`
        : 'FAIL attack two-step-vs-atomic supersededAt: atomic send writes supersededBy only; two-step writes supersededAt');
  } finally {
    await cleanup();
  }
}

async function item15() {
  const repo = await fsp.mkdtemp(path.join(os.tmpdir(), 'pab-i15-'));
  const guard = path.join(__dirname, 'scripts', 'claim-guard-cli.js');
  const busRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'pab-i15-bus-'));
  try {
    execFileSync('git', ['init'], { cwd: repo, stdio: 'pipe' });
    execFileSync('git', ['config', 'user.email', 'audit@example'], { cwd: repo, stdio: 'pipe' });
    execFileSync('git', ['config', 'user.name', 'audit'], { cwd: repo, stdio: 'pipe' });
    await fsp.mkdir(path.join(repo, 'src'), { recursive: true });
    await fsp.writeFile(path.join(repo, 'src', 'index.ts'), 'export const n: number = 1;\n');
    await fsp.writeFile(path.join(repo, 'tsconfig.json'), JSON.stringify({
      compilerOptions: { strict: true, noEmit: true, target: 'ES2020', module: 'commonjs' },
      include: ['src/**/*.ts']
    }, null, 2));
    await fsp.writeFile(path.join(repo, '.gitignore'), 'node_modules\n');
    execFileSync('git', ['add', 'src/index.ts', 'tsconfig.json', '.gitignore'], { cwd: repo, stdio: 'pipe' });
    execFileSync('git', ['commit', '-m', 'base'], { cwd: repo, stdio: 'pipe' });
    // reuse PAB typescript so the guard finds a local tsc; keep it out of the index
    const tscDir = path.join(__dirname, 'node_modules');
    try { fs.symlinkSync(tscDir, path.join(repo, 'node_modules'), 'junction'); } catch {}

    const mailboxDir = path.join(busRoot, '.ai-bus', 'runtime', 'mailbox');
    await fsp.mkdir(mailboxDir, { recursive: true });
    await fsp.writeFile(path.join(mailboxDir, 'state.json'), JSON.stringify({
      schema: 1, agents: ['grok'], claims: { grok: [
        { path: 'src/index.ts', why: 'audit', at: new Date().toISOString() },
        { path: 'tsconfig.json', why: 'audit', at: new Date().toISOString() }
      ] }
    }));

    function runGuard() {
      try {
        const out = execFileSync(process.execPath, [guard, '--root', busRoot, '--seat', 'grok', '--repo', repo], {
          cwd: repo, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe']
        });
        return { code: 0, out };
      } catch (e) {
        return { code: e.status ?? 1, out: `${e.stdout || ''}${e.stderr || ''}` };
      }
    }

    // original attack: stage type error, restore compiling worktree
    await fsp.writeFile(path.join(repo, 'src', 'index.ts'), 'export const n: number = "broken";\n');
    execFileSync('git', ['add', 'src/index.ts'], { cwd: repo, stdio: 'pipe' });
    await fsp.writeFile(path.join(repo, 'src', 'index.ts'), 'export const n: number = 1;\n');
    const original = runGuard();
    record(15, 'original staged-error + clean-worktree',
      original.code === 1 && /REFUSING|TS2322/i.test(original.out),
      `exit=${original.code} ${original.out.split('\n').slice(0, 6).join(' | ')}`);

    execFileSync('git', ['reset', 'HEAD', 'src/index.ts'], { cwd: repo, stdio: 'pipe' });
    await fsp.writeFile(path.join(repo, 'src', 'index.ts'), 'export const n: number = 1;\n');
    execFileSync('git', ['add', 'src/index.ts'], { cwd: repo, stdio: 'pipe' });
    const honest = runGuard();
    record(15, 'honest commit prints compile OK (staged index)',
      honest.code === 0 && /compile OK \(staged index\)/.test(honest.out),
      `exit=${honest.code} ${honest.out.trim()}`);

    // hide-worktree-tsconfig
    await fsp.writeFile(path.join(repo, 'src', 'index.ts'), 'export const n: number = "broken";\n');
    execFileSync('git', ['add', 'src/index.ts'], { cwd: repo, stdio: 'pipe' });
    await fsp.writeFile(path.join(repo, 'src', 'index.ts'), 'export const n: number = 1;\n');
    const tsPath = path.join(repo, 'tsconfig.json');
    const tsSaved = await fsp.readFile(tsPath, 'utf8');
    await fsp.unlink(tsPath);
    const hidden = runGuard();
    record(15, 'hide-worktree-tsconfig still lets a non-compiling commit land',
      hidden.code !== 0,
      hidden.code === 0
        ? `FAIL attack hide-worktree-tsconfig: exit 0, ${hidden.out.trim()} — index still has tsconfig + type error`
        : `exit=${hidden.code} ${hidden.out.split('\n').slice(0, 4).join(' | ')}`);
    await fsp.writeFile(tsPath, tsSaved);

    // worktree tsconfig noCheck overwrite
    await fsp.writeFile(path.join(repo, 'src', 'index.ts'), 'export const n: number = "broken";\n');
    execFileSync('git', ['add', 'src/index.ts'], { cwd: repo, stdio: 'pipe' });
    await fsp.writeFile(path.join(repo, 'src', 'index.ts'), 'export const n: number = 1;\n');
    await fsp.writeFile(tsPath, JSON.stringify({
      compilerOptions: { strict: true, noEmit: true, target: 'ES2020', module: 'commonjs', noCheck: true },
      include: ['src/**/*.ts']
    }, null, 2));
    const nocheck = runGuard();
    const stagedStillBroken = execFileSync('git', ['show', ':src/index.ts'], { cwd: repo, encoding: 'utf8' }).includes('"broken"');
    record(15, 'worktree tsconfig noCheck overwrite',
      !(nocheck.code === 0 && /staged index/.test(nocheck.out) && stagedStillBroken),
      nocheck.code === 0 && stagedStillBroken
        ? `FAIL attack worktree-tsconfig-noCheck: printed ${nocheck.out.trim()} while git show :src/index.ts still has the type error`
        : `exit=${nocheck.code} stagedBroken=${stagedStillBroken} ${nocheck.out.trim()}`);

    // staged broken tsconfig, good worktree copy
    await fsp.writeFile(tsPath, '{ this is not json');
    execFileSync('git', ['add', 'tsconfig.json', 'src/index.ts'], { cwd: repo, stdio: 'pipe' });
    await fsp.writeFile(tsPath, tsSaved);
    const badcfg = runGuard();
    const stagedCfg = execFileSync('git', ['show', ':tsconfig.json'], { cwd: repo, encoding: 'utf8' });
    record(15, 'staged broken tsconfig overwritten by worktree copy',
      badcfg.code !== 0,
      badcfg.code === 0
        ? `FAIL attack staged-broken-tsconfig: exit 0 ${badcfg.out.trim()} while git show :tsconfig.json is ${JSON.stringify(stagedCfg.slice(0, 40))}`
        : `exit=${badcfg.code} ${badcfg.out.split('\n').slice(0, 4).join(' | ')}`);
  } finally {
    await fsp.rm(repo, { recursive: true, force: true, maxRetries: 8 }).catch(() => {});
    await fsp.rm(busRoot, { recursive: true, force: true, maxRetries: 8 }).catch(() => {});
  }
}

(async () => {
  await item15();
  const summary = {
    pass: results.filter((r) => r.pass).map((r) => `[${r.item}] ${r.name}`),
    fail: results.filter((r) => !r.pass).map((r) => `[${r.item}] ${r.name} :: ${r.detail}`)
  };
  console.log('\n==== SUMMARY ====');
  console.log(JSON.stringify(summary, null, 2));
  await fsp.writeFile(path.join(__dirname, 'tmp-audit-1842-rerun-out.json'), JSON.stringify({ results, summary }, null, 2));
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
