const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { test } = require('node:test');
// Item 26: warn if this file is about to test bytecode older than the source it covers.
require('./helpers/require-fresh-dist')();
const { MailboxStore } = require('../dist/mailbox.js');
const { cliBusClient } = require('../dist/brain/bus-client.js');

// ---------------------------------------------------------------------------
// Gates for the fixes to grok's audit of items 7, 13, 10 and 18.
//
// Each fix gets a gate written from the ATTACK grok actually described, not from the fix -
// a test written by reading the patch tends to assert what the patch does rather than what
// the hole was. Every one of these failed before its fix; the reverts are recorded per gate.
// ---------------------------------------------------------------------------

async function withStore(t, prefix, seats = ['claude', 'grok', 'codex']) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 }));
  const store = new MailboxStore(root);
  await store.ensureInitialized(seats, 500);
  return { store, root };
}

// ---------------------------------------------------------------------------
// ITEM 7 - a claim must say why. The store already refused an empty `why`; the BRAIN path
// sent `why || 'unstated'`, inventing a reason for a caller that supplied none. That is the
// same backfill the code forbids for legacy rows a few lines above it.
// ---------------------------------------------------------------------------

// The tool transport is injected, so these gates observe exactly what the client would put on
// the wire - which is where both defects lived.
function recordingTools(calls) {
  const client = cliBusClient({
    root: 'C:/nowhere',
    async callSeatTool(_options, name, input) {
      calls.push({ name, input });
      return { ok: true };
    }
  });
  return client.tools('grok');
}

test('ITEM 7 RED: the brain path refuses a why-less claim instead of inventing one', async () => {
  const calls = [];
  const tools = recordingTools(calls);

  const refusal = await tools.claim(['src/mailbox.ts'], '');
  assert.equal(calls.length, 0, 'a why-less claim must never reach the mailbox at all');
  assert.ok(refusal && typeof refusal.refused === 'string', 'it must be refused, with a reason');
  assert.doesNotMatch(JSON.stringify(refusal), /unstated/,
    'REGRESSION: "unstated" is the invented reason this fix removed');

  // GREEN CONTROL: a real why still goes through untouched, or the guard is unsatisfiable.
  await tools.claim(['src/mailbox.ts'], 'item 18 wiring');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].input.why, 'item 18 wiring');
});

// ---------------------------------------------------------------------------
// ITEM 13 - grok's attack verbatim: "a directory junction named `everything` pointing at the
// repo root is accepted as path 'everything'. claimsOverlap then uses realpath/inode, so
// src/bus.ts is blocked (codex already holds everything). Another spelling of everything.
// The lexical check never sees '.'."
// ---------------------------------------------------------------------------

function junctionsAvailable(link, target) {
  try {
    execFileSync('cmd.exe', ['/c', 'mklink', '/J', link, target], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

test('ITEM 13 RED: a junction pointing at the root is refused, whatever it is called', async (t) => {
  const { store, root } = await withStore(t, 'pab-i13-');
  await fs.mkdir(path.join(root, 'src'), { recursive: true });
  await fs.writeFile(path.join(root, 'src', 'bus.ts'), 'x');

  if (process.platform !== 'win32' || !junctionsAvailable(path.join(root, 'everything'), root)) {
    // Not a silent pass: the platform genuinely cannot stage this attack.
    t.skip('directory junctions unavailable on this platform');
    return;
  }

  await assert.rejects(
    () => store.claim({ agent: 'codex', paths: ['everything'], why: 'the whole tree by another name' }),
    /whole repositor|too broad/i,
    'a claim that RESOLVES to the root is the whole repository whatever it is spelled'
  );

  // And the consequence the attack was aiming at: another seat is still free to work.
  const held = await store.claim({ agent: 'grok', paths: ['src/bus.ts'], why: 'item 18' });
  assert.ok(held, 'no seat was locked out by the refused claim');

  // GREEN CONTROL: an ordinary directory claim BELOW the root still succeeds. Without this a
  // fix that refuses everything would look identical to a fix that refuses the right thing.
  await store.release('grok');
  const below = await store.claim({ agent: 'grok', paths: ['src'], why: 'ancestor claims stay legal' });
  assert.ok(below, 'ancestor claims below the root are exactly what the walk exists to support');
});

// ---------------------------------------------------------------------------
// ITEM 10 - recall must follow the BATON. `message.to !== seat` was wrong in the one case the
// item exists for: after reassignBaton the successor holds the open checkpoint but the source
// message is still addressed to the predecessor, so the seat now DOING the work could not
// recall its brief while the seat that no longer had it still could.
// ---------------------------------------------------------------------------

test('ITEM 10 RED: recall follows the baton to the seat that now holds the work', async (t) => {
  const { store } = await withStore(t, 'pab-i10b-');
  const source = await store.send({
    from: 'claude', to: 'grok', kind: 'task',
    subject: 'ITEM 18 wiring', body: 'PATHS: src/harness.ts\nGATES: supersedes reaches every surface.'
  });
  await store.openRecovery('grok', source.seq, 'started');

  assert.ok(await store.recallAssignment('grok', source.seq), 'the original holder can recall');

  // The real failover path: an operator moving the baton off a seat that went dark. `force`
  // skips only the staleness guard - the inheritance itself is the code under test.
  const moved = await store.reassignBaton({ to: 'codex', reason: 'grok went dark', force: true });
  assert.equal(moved.moved, true, 'the fixture must actually move the baton or the gate proves nothing');
  assert.equal(moved.inheritedWorkId, source.seq, 'and codex must inherit THIS work');

  const inherited = await store.recallAssignment('codex', source.seq);
  assert.ok(inherited, 'the INHERITING seat must be able to recall the brief it now owns');
  assert.match(inherited, /PATHS: src\/harness\.ts/, 'and it is the brief, not a summary of it');

  // GREEN CONTROL: recall still does not leak to an uninvolved seat. A fix that simply
  // dropped the addressing check would pass the assertion above and fail here.
  assert.equal(await store.recallAssignment('claude', source.seq), undefined,
    'a seat with no checkpoint on this work recalls nothing');
});

// ---------------------------------------------------------------------------
// ITEM 18 - the capability existed only on MailboxStore.send. Every surface a caller actually
// uses dropped it, which is the store-is-not-the-feature defect: CLI, harness tool, brain
// client, worker client and the vscode worker all silently discarded `supersedes`.
// ---------------------------------------------------------------------------

test('ITEM 18 RED: supersedes survives the brain client and reaches the tool call', async () => {
  const calls = [];
  const tools = recordingTools(calls);

  await tools.send({
    to: 'claude', kind: 'task', subject: 'correction', body: 'use the index, not the working tree',
    supersedes: 1764, supersedeReason: 'the earlier instruction was wrong'
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, 'mailbox_send');
  assert.equal(calls[0].input.supersedes, 1764, 'REGRESSION: the retraction was dropped in transit');
  assert.equal(calls[0].input.supersedeReason, 'the earlier instruction was wrong');

  // GREEN CONTROL: an ordinary send carries neither field. Defaulting them would make every
  // message look like a retraction of message #0.
  await tools.send({ to: 'claude', kind: 'note', subject: 'plain', body: 'no retraction here' });
  assert.equal('supersedes' in calls[1].input, false);
  assert.equal('supersedeReason' in calls[1].input, false);

  // Model output is untrusted: a malformed supersedes must be dropped rather than turn a
  // correction into a failed send.
  await tools.send({ to: 'claude', kind: 'task', subject: 'junk', body: 'b', supersedes: 'seventeen' });
  assert.equal('supersedes' in calls[2].input, false);
});

test('ITEM 18: the CLI send verb performs a real atomic supersession', async (t) => {
  const { store, root } = await withStore(t, 'pab-i18cli-');
  const original = await store.send({
    from: 'claude', to: 'grok', kind: 'task', subject: 'stale', body: 'the old instruction'
  });

  const cli = path.join(__dirname, '..', 'dist', 'mailbox.js');
  const out = execFileSync(process.execPath, [
    cli, 'send', '--root', root, '--from', 'claude', '--to', 'grok',
    '--kind', 'task', '--subject', 'correction', '--body', 'the new instruction',
    '--supersedes', String(original.seq), '--supersede-reason', 'settled four messages ago'
  ], { encoding: 'utf8' });

  assert.match(out, new RegExp(`superseding #${original.seq}`),
    'the CLI must REPORT the supersession, not just perform it');

  // The state on disk is the actual claim: the stale instruction is no longer deliverable.
  const inbox = await store.inbox('grok');
  assert.equal(inbox.some((m) => m.seq === original.seq), false,
    'REGRESSION: the stale instruction is still current - this is the window item 18 closes');
  assert.equal(inbox.length, 1, 'and exactly the correction is delivered in its place');
  assert.match(inbox[0].subject, /correction/);
});

test('ITEM 18 GREEN CONTROL: an already-read target reports target-consumed, not success', async (t) => {
  const { store, root } = await withStore(t, 'pab-i18read-');
  const original = await store.send({
    from: 'claude', to: 'grok', kind: 'task', subject: 'stale', body: 'already acted on'
  });
  await store.acknowledge('grok', [original.seq]);

  const cli = path.join(__dirname, '..', 'dist', 'mailbox.js');
  const out = execFileSync(process.execPath, [
    cli, 'send', '--root', root, '--from', 'claude', '--to', 'grok',
    '--subject', 'too late', '--body', 'the recipient already read it',
    '--supersedes', String(original.seq)
  ], { encoding: 'utf8' });

  // You cannot retract what was already acted on, and saying so is the whole point: a
  // success line here would be a report that the correction landed when it did not.
  assert.match(out, /NOT superseded: target-consumed/,
    'a supersession that could not take effect must never print as one that did');
});
