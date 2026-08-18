import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { MailboxStore } from './dist/mailbox.js';

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
    console.log('junction failed', error.message);
    return false;
  }
}

async function withStore(prefix, seats = ['claude', 'grok', 'codex']) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), prefix));
  const store = new MailboxStore(root);
  await store.ensureInitialized(seats, 500);
  return { store, root, cleanup: () => fsp.rm(root, { recursive: true, force: true, maxRetries: 8 }) };
}

// ---------------------------------------------------------------------------
// ITEM 13
// ---------------------------------------------------------------------------
async function item13() {
  const { store, root, cleanup } = await withStore('pab-a13-');
  try {
    await fsp.mkdir(path.join(root, 'src'), { recursive: true });
    await fsp.writeFile(path.join(root, 'src', 'bus.ts'), 'x');

    // src/.. collapses to '.' and must refuse
    try {
      await store.claim({ agent: 'codex', paths: ['src/..'], why: 'collapse to root' });
      rec(13, 'src/.. spelling', 'FAIL', 'src/.. was accepted — lexical collapse to root was not refused');
    } catch (error) {
      rec(13, 'src/.. spelling', /whole repositor|too broad|escapes/i.test(error.message) ? 'PASS' : 'FAIL', error.message);
    }

    // everything junction -> bus root
    const everything = path.join(root, 'everything');
    if (process.platform === 'win32' && junctionsAvailable(everything, root)) {
      try {
        await store.claim({ agent: 'codex', paths: ['everything'], why: 'junction to bus root' });
        rec(13, 'junction-to-bus-root', 'FAIL', 'junction named everything pointing at bus root was accepted');
      } catch (error) {
        rec(13, 'junction-to-bus-root', /whole repositor|too broad/i.test(error.message) ? 'PASS' : 'FAIL', error.message);
      }
    } else {
      rec(13, 'junction-to-bus-root', 'SKIP', 'junctions unavailable');
    }

    // A second tree used as repoRoot. Junction in the repo pointing at the BUS root.
    const repo = await fsp.mkdtemp(path.join(os.tmpdir(), 'pab-a13repo-'));
    await fsp.mkdir(path.join(repo, 'src'), { recursive: true });
    await fsp.writeFile(path.join(repo, 'src', 'bus.ts'), 'x');
    const busAlias = path.join(repo, 'busroot');
    if (process.platform === 'win32' && junctionsAvailable(busAlias, root)) {
      try {
        await store.claim({
          agent: 'grok',
          paths: ['busroot'],
          why: 'junction to BUS root from a repoRoot claim',
          repoRoot: repo
        });
        rec(13, 'junction-to-bus-from-repo', 'FAIL', 'path resolving to BUS root (not repo root) was accepted');
      } catch (error) {
        rec(13, 'junction-to-bus-from-repo', /whole repositor|too broad/i.test(error.message) ? 'PASS' : 'FAIL', error.message);
      }
    } else {
      rec(13, 'junction-to-bus-from-repo', 'SKIP', 'junctions unavailable');
    }

    // Junction in the repo pointing at the REPO root (the original attack, with explicit repoRoot)
    const repoEverything = path.join(repo, 'everything');
    if (process.platform === 'win32' && junctionsAvailable(repoEverything, repo)) {
      try {
        await store.claim({
          agent: 'grok',
          paths: ['everything'],
          why: 'junction to repo root',
          repoRoot: repo
        });
        rec(13, 'junction-to-repo-root', 'FAIL', 'junction to repoRoot was accepted');
      } catch (error) {
        rec(13, 'junction-to-repo-root', /whole repositor|too broad/i.test(error.message) ? 'PASS' : 'FAIL', error.message);
      }
    } else {
      rec(13, 'junction-to-repo-root', 'SKIP', 'junctions unavailable');
    }

    // Non-existent repoRoot is skipped in the identity loop. Junction in the BUS
    // pointing at the intended-but-missing repo should be accepted (it is not a claim root).
    const ghost = path.join(os.tmpdir(), 'pab-does-not-exist-' + Date.now());
    const intended = await fsp.mkdtemp(path.join(os.tmpdir(), 'pab-a13intended-'));
    await fsp.writeFile(path.join(intended, 'readme.txt'), 'x');
    const aliasToIntended = path.join(root, 'otherrepo');
    if (process.platform === 'win32' && junctionsAvailable(aliasToIntended, intended)) {
      try {
        const held = await store.claim({
          agent: 'claude',
          paths: ['otherrepo'],
          why: 'ghost repoRoot + junction to a whole other tree',
          repoRoot: ghost
        });
        rec(13, 'missing-repoRoot-skips-identity', 'NOTE',
          `accepted claim on a whole foreign tree because repoRoot did not exist and was skipped. held=${JSON.stringify(held.map(c => c.path))}`);
      } catch (error) {
        rec(13, 'missing-repoRoot-skips-identity', 'NOTE', `refused: ${error.message}`);
      }
    } else {
      rec(13, 'missing-repoRoot-skips-identity', 'SKIP', 'junctions unavailable');
    }

    // Non-existent repoRoot + junction in BUS pointing at the BUS itself must still refuse
    const busAgain = path.join(root, 'busagain');
    if (process.platform === 'win32' && junctionsAvailable(busAgain, root)) {
      try {
        await store.claim({
          agent: 'codex',
          paths: ['busagain'],
          why: 'ghost repoRoot but path is the bus',
          repoRoot: ghost
        });
        rec(13, 'missing-repoRoot-still-checks-bus', 'FAIL', 'missing repoRoot skipped AND bus-root junction got through');
      } catch (error) {
        rec(13, 'missing-repoRoot-still-checks-bus', /whole repositor|too broad/i.test(error.message) ? 'PASS' : 'FAIL', error.message);
      }
    } else {
      rec(13, 'missing-repoRoot-still-checks-bus', 'SKIP', 'junctions unavailable');
    }

    // everything/.  and ./everything
    if (fs.existsSync(everything)) {
      try {
        await store.claim({ agent: 'codex', paths: ['everything/.'], why: 'dot suffix' });
        rec(13, 'everything/. spelling', 'FAIL', 'everything/. accepted');
      } catch (error) {
        rec(13, 'everything/. spelling', /whole repositor|too broad/i.test(error.message) ? 'PASS' : 'FAIL', error.message);
      }
      try {
        await store.claim({ agent: 'codex', paths: ['./everything'], why: 'dot prefix' });
        rec(13, './everything spelling', 'FAIL', './everything accepted');
      } catch (error) {
        rec(13, './everything spelling', /whole repositor|too broad/i.test(error.message) ? 'PASS' : 'FAIL', error.message);
      }
    }

    // Parent-of-root junction. Nest the mailbox under a sandbox so the walk cannot
    // escape into %TEMP%. Identity of the parent is not a claim root; if accepted,
    // the overlap walk stayUnderRoot realpath becomes the parent and locks the tree.
    const sandbox = await fsp.mkdtemp(path.join(os.tmpdir(), 'pab-a13sandbox-'));
    const nestedRoot = path.join(sandbox, 'ws');
    await fsp.cp(root, nestedRoot, { recursive: true });
    const nestedStore = new MailboxStore(nestedRoot);
    await nestedStore.ensureInitialized(['claude', 'grok', 'codex'], 500);
    await fsp.mkdir(path.join(nestedRoot, 'src'), { recursive: true });
    await fsp.writeFile(path.join(nestedRoot, 'src', 'bus.ts'), 'x');
    const above = path.join(nestedRoot, 'above');
    if (process.platform === 'win32' && junctionsAvailable(above, sandbox)) {
      try {
        const held = await nestedStore.claim({ agent: 'codex', paths: ['above'], why: 'parent of the claim root' });
        try {
          await nestedStore.claim({ agent: 'grok', paths: ['src/bus.ts'], why: 'should still be free' });
          rec(13, 'parent-of-root-junction', 'NOTE',
            `parent junction was accepted (${held.map((c) => c.path).join(',')}) but did NOT lock src/bus.ts`);
        } catch (error) {
          rec(13, 'parent-of-root-junction', 'FAIL',
            `parent-of-root junction accepted and then blocked src/bus.ts: ${error.message}`);
        }
        await nestedStore.release('codex');
      } catch (error) {
        rec(13, 'parent-of-root-junction', /whole repositor|too broad|escapes/i.test(error.message) ? 'PASS' : 'FAIL',
          error.message);
      }
    } else {
      rec(13, 'parent-of-root-junction', 'SKIP', 'junctions unavailable');
    }
    await fsp.rm(sandbox, { recursive: true, force: true, maxRetries: 8 });

    // Bare '..' must refuse as an escape, not sneak through as a root alias.
    try {
      await store.claim({ agent: 'codex', paths: ['..'], why: 'parent spelling' });
      rec(13, '.. spelling', 'FAIL', '.. was accepted');
    } catch (error) {
      rec(13, '.. spelling', /escape|whole repositor|too broad/i.test(error.message) ? 'PASS' : 'FAIL', error.message);
    }

    await fsp.rm(repo, { recursive: true, force: true, maxRetries: 8 });
    await fsp.rm(intended, { recursive: true, force: true, maxRetries: 8 });
  } finally {
    await cleanup();
  }
}

// ---------------------------------------------------------------------------
// ITEM 10
// ---------------------------------------------------------------------------
async function item10() {
  const { store, cleanup } = await withStore('pab-a10-');
  try {
    const source = await store.send({
      from: 'claude', to: 'grok', kind: 'task',
      subject: 'secret brief', body: 'PATHS: src/harness.ts\nGATES: do not leak this'
    });
    await store.openRecovery('grok', source.seq, 'started');

    const moved = await store.reassignBaton({ to: 'codex', reason: 'grok went dark', force: true });
    assert.equal(moved.moved, true);

    const successor = await store.recallAssignment('codex', source.seq);
    rec(10, 'successor-after-baton', successor ? 'PASS' : 'FAIL',
      successor ? 'inheritor can recall' : 'inheritor still cannot recall');

    const predecessor = await store.recallAssignment('grok', source.seq);
    rec(10, 'predecessor-after-baton', predecessor ? 'FAIL' : 'PASS',
      predecessor
        ? 'PREDECESSOR still recalls after reassignBaton because message.to short-circuits the checkpoint check'
        : 'predecessor correctly recalls nothing');

    const uninvolved = await store.recallAssignment('claude', source.seq);
    rec(10, 'uninvolved-after-baton', uninvolved ? 'FAIL' : 'PASS',
      uninvolved ? 'uninvolved seat recalled' : 'uninvolved seat recalls nothing');

    // Closed checkpoint on the successor: operator-close, then recall
    const open = (source.seq);
    // successor currently has open checkpoint
    await store.operatorCloseRecovery('codex', open, 'withdrawn');
    const afterCloseSuccessor = await store.recallAssignment('codex', open);
    rec(10, 'closed-checkpoint-non-addressee', afterCloseSuccessor ? 'FAIL' : 'PASS',
      afterCloseSuccessor
        ? 'non-addressee recalled via a CLOSED checkpoint'
        : 'closed checkpoint on non-addressee recalls nothing');

    const afterCloseAddressee = await store.recallAssignment('grok', open);
    rec(10, 'closed-checkpoint-addressee', afterCloseAddressee ? 'FAIL' : 'PASS',
      afterCloseAddressee
        ? 'ADDRESSEE recalled after every checkpoint was closed — address still grants recall'
        : 'addressee with no open checkpoint recalls nothing');

    // Re-open by the original addressee after inheritance+close (they are still message.to)
    try {
      await store.openRecovery('grok', open, 'I am taking it back');
      const reopened = await store.recallAssignment('grok', open);
      rec(10, 'addressee-reopen-after-inherit', reopened ? 'NOTE' : 'NOTE',
        reopened
          ? 'addressee can openRecovery again after losing the baton (source.to still matches) and then recall'
          : 'addressee reopen did not restore recall');
    } catch (error) {
      rec(10, 'addressee-reopen-after-inherit', 'NOTE', `openRecovery refused: ${error.message}`);
    }

    // Fresh consumed brief, close checkpoint, store-level recall
    const consumed = await store.send({
      from: 'claude', to: 'grok', kind: 'task', subject: 'consumed', body: 'do the thing'
    });
    await store.openRecovery('grok', consumed.seq, 'working');
    await store.closeRecovery('grok', consumed.seq, 'settled');
    const afterOwnClose = await store.recallAssignment('grok', consumed.seq);
    rec(10, 'addressee-after-own-close', afterOwnClose ? 'FAIL' : 'PASS',
      afterOwnClose
        ? 'addressee recallAssignment still returns the brief after closeRecovery — item10-recall.test.js claims "no open checkpoint, no recall" but that is only the runner'
        : 'store refuses addressee recall after close');
  } finally {
    await cleanup();
  }
}

// ---------------------------------------------------------------------------
// ITEM 18
// ---------------------------------------------------------------------------
async function item18() {
  const { store, root, cleanup } = await withStore('pab-a18-');
  try {
    const original = await store.send({
      from: 'claude', to: 'grok', kind: 'task', subject: 'stale', body: 'old instruction'
    });
    const atomic = await store.send({
      from: 'claude', to: 'grok', kind: 'task', subject: 'correction', body: 'new instruction',
      supersedes: original.seq, supersedeReason: 'settled'
    });

    const origAfter = await store.readJson
      ? null
      : null;
    // Re-read original via inbox/all — use recall of fields from disk through inbox emptiness
    const inbox = await store.inbox('grok');
    rec(18, 'atomic-removes-from-inbox', inbox.some((m) => m.seq === original.seq) ? 'FAIL' : 'PASS',
      `inbox seqs=${inbox.map((m) => m.seq).join(',')}`);

    rec(18, 'atomic-sets-superseded-on-new', atomic.superseded === true ? 'PASS' : 'FAIL',
      `superseded=${atomic.superseded} outcome=${atomic.supersedeOutcome}`);

    const inboxDir = path.join(root, '.ai-bus', 'runtime', 'mailbox', 'inbox');
    const files = await fsp.readdir(inboxDir);
    const origFile = files.find((name) => name.includes(`-${original.seq}-`) || name.startsWith(`${String(original.seq).padStart(6, '0')}`));
    let origRow;
    for (const name of files) {
      const row = JSON.parse(await fsp.readFile(path.join(inboxDir, name), 'utf8'));
      if (row.seq === original.seq) origRow = row;
    }
    rec(18, 'atomic-sets-supersededAt', origRow?.supersededAt ? 'PASS' : 'FAIL',
      origRow
        ? `atomic target supersededBy=${origRow.supersededBy} supersededAt=${origRow.supersededAt ?? '<MISSING>'} (two-step always writes supersededAt)`
        : `could not find original message file (tried ${origFile})`);

    // Two-step: send then supersedeMessage
    const a = await store.send({ from: 'claude', to: 'grok', kind: 'task', subject: 'A', body: 'first' });
    const b = await store.send({ from: 'claude', to: 'grok', kind: 'task', subject: 'B', body: 'second' });
    // Both are live in this window — that is the known two-step hole.
    const midInbox = await store.inbox('grok');
    const bothLive = midInbox.some((m) => m.seq === a.seq) && midInbox.some((m) => m.seq === b.seq);
    rec(18, 'two-step-window-still-exists', bothLive ? 'NOTE' : 'NOTE',
      bothLive
        ? 'two-step still has the dual-live window (expected: this is why atomic exists)'
        : 'two-step window unexpectedly gone');

    const superseded = await store.supersedeMessage(a.seq, b.seq, 'settled', 'claude');
    rec(18, 'two-step-sets-supersededAt', superseded.supersededAt ? 'NOTE' : 'FAIL',
      `two-step supersededAt=${superseded.supersededAt ?? '<missing>'}; atomic path does not set supersededAt on the target`);

    rec(18, 'two-step-sets-supersedeReason', superseded.supersedeReason === 'settled' ? 'PASS' : 'FAIL',
      `reason=${superseded.supersedeReason}`);

    // Atomic vs two-step on an already-read target
    const readTarget = await store.send({ from: 'claude', to: 'codex', kind: 'task', subject: 'readme', body: 'act' });
    await store.acknowledge('codex', [readTarget.seq]);
    const lateAtomic = await store.send({
      from: 'claude', to: 'codex', kind: 'task', subject: 'too late', body: 'correction',
      supersedes: readTarget.seq, supersedeReason: 'late'
    });
    rec(18, 'atomic-consumed-does-not-retract', lateAtomic.supersedeOutcome === 'target-consumed' ? 'PASS' : 'FAIL',
      `outcome=${lateAtomic.supersedeOutcome} superseded=${lateAtomic.superseded}`);

    let twoStepOnRead;
    try {
      twoStepOnRead = await store.supersedeMessage(readTarget.seq, lateAtomic.seq, 'late-two-step', 'claude');
      rec(18, 'two-step-on-consumed', 'FAIL',
        `two-step STILL retracts an already-read target (supersededBy=${twoStepOnRead.supersededBy}). Atomic send refuses this. They do not behave identically.`);
    } catch (error) {
      rec(18, 'two-step-on-consumed', 'PASS', `two-step also refused consumed target: ${error.message}`);
    }

    // Atomic send to a DIFFERENT recipient than the target
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
          ? 'atomic refused to pull a grok-addressed message when sending to codex? still in grok inbox'
          : `atomic supersede RETRACTED a message to grok by sending a replacement to codex (new #${redirected.seq}). two-step supersedeMessage requires the same recipient.`);
    } catch (error) {
      rec(18, 'atomic-cross-recipient', 'PASS', `refused cross-recipient: ${error.message}`);
    }
  } finally {
    await cleanup();
  }

  // Static surfaces: PLAN_SCHEMA is what constrained decoding actually allows.
  const agentSrc = fs.readFileSync(new URL('./src/brain/brains/agent.ts', import.meta.url), 'utf8');
  const schemaHasSupersedes = /export const PLAN_SCHEMA[\s\S]*?required: \['actions', 'done'\]/.test(agentSrc)
    && /export const PLAN_SCHEMA[\s\S]*supersedes:/.test(agentSrc);
  rec(18, 'PLAN_SCHEMA-has-supersedes', schemaHasSupersedes ? 'PASS' : 'FAIL',
    schemaHasSupersedes
      ? 'PLAN_SCHEMA lists supersedes'
      : 'PLAN_SCHEMA omits supersedes/supersedeReason — constrained decoding cannot emit the atomic retract');

  const promptMentions = /send requires[\s\S]*?supersedes/.test(agentSrc);
  rec(18, 'system-prompt-mentions-supersedes', promptMentions ? 'PASS' : 'FAIL',
    promptMentions
      ? 'system prompt tells the model send can retract'
      : 'system prompt describes send without supersedes — model is not told the field exists');

  const vscodeSrc = fs.readFileSync(new URL('./src/vscode-lm-worker.ts', import.meta.url), 'utf8');
  const vscodeWhyRequired = /mailbox_claim[\s\S]*?required: \[[^\]]*why/.test(vscodeSrc);
  rec(7, 'vscode-claim-why-required', vscodeWhyRequired ? 'PASS' : 'NOTE',
    vscodeWhyRequired
      ? 'vscode mailbox_claim requires why'
      : 'vscode mailbox_claim required:[paths] only; empty why now dies at the store instead of becoming unstated');
}

await item13();
await item10();
await item18();

console.log('\n===== SUMMARY =====');
for (const row of results) {
  console.log(`${row.status.padEnd(4)}  item ${row.item}  ${row.name}`);
}
