const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { EvidenceStore } = require('../dist/evidence.js');

// ---------------------------------------------------------------------------
// Item 2: consolidation of an assignment's episodes.
//
// The gap Cwars leaves: it supersedes FACTS, but EPISODES accumulate. Bundle.format's
// max_chars bounds what is INJECTED, not what is STORED or ranked, so retrieval degrades as
// history grows even while prompt cost stays flat. Bounding the prompt is not bounding memory.
//
// Two properties that pull against each other, which is why this had to be designed rather
// than adapted:
//   1. a summary must NOT RESURRECT superseded state
//   2. it must be LOSSLESS for anything still current
// ---------------------------------------------------------------------------

async function withStore(t, fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pab-item2-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 }));
  return fn(new EvidenceStore(dir));
}

async function seed(store, workId, subjects) {
  const made = [];
  for (const subject of subjects) {
    made.push(await store.record({ workId, subject, statement: `${subject} happened`, recordedBy: 'grok' }));
  }
  return made;
}

test('ITEM 2 GREEN: consolidation absorbs live episodes and supersedes them without deleting', async (t) => {
  await withStore(t, async (store) => {
    const made = await seed(store, 42, ['first', 'second', 'third']);
    const { summary, absorbed } = await store.consolidate(42, 'claude');

    assert.equal(absorbed, 3);
    assert.ok(summary);
    assert.deepEqual(summary.consolidatedFrom, made.map((m) => m.id).sort());

    // Superseded, NOT deleted - the audit trail survives.
    const all = await store.list(42);
    assert.equal(all.length, 4, 'originals are retained alongside the summary');
    for (const original of made) {
      const row = all.find((item) => item.id === original.id);
      assert.equal(row.supersededBy, summary.id);
      assert.equal(row.statement, `${row.subject} happened`, 'original text is untouched');
    }

    // And only the summary is current for a wake.
    const current = await store.forWake([42]);
    assert.deepEqual(current.map((item) => item.id), [summary.id]);
  });
});

test('ITEM 2 HARD GATE 1: a summary must NOT resurrect superseded or invalidated state', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pab-item2-hg1-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 }));
  const filePath = path.join(dir, '.ai-bus', 'runtime', 'mailbox', 'evidence.json');
  const store = new EvidenceStore(dir);

  const [retired, invalidated, ...live] = await seed(
    store, 7, ['retired-claim', 'invalidated-claim', 'live-a', 'live-b', 'live-c']
  );

  // Retire one and invalidate another, the way corrected facts are retired. Written straight to
  // the file so the fixture does not depend on a seam the store does not offer.
  const raw = JSON.parse(await fs.readFile(filePath, 'utf8'));
  raw.records.find((r) => r.id === retired.id).supersededBy = 'some-newer-record';
  raw.records.find((r) => r.id === retired.id).statement = 'THE RETIRED WORDING';
  raw.records.find((r) => r.id === invalidated.id).invalidateReason = 'subject identity changed';
  raw.records.find((r) => r.id === invalidated.id).statement = 'THE INVALIDATED WORDING';
  await fs.writeFile(filePath, `${JSON.stringify(raw, null, 2)}\n`, 'utf8');

  const { summary, absorbed } = await store.consolidate(7, 'claude');
  assert.ok(summary);
  assert.equal(absorbed, 3, 'only the three live episodes may be absorbed');

  assert.ok(!summary.consolidatedFrom.includes(retired.id), 'a superseded episode must not return');
  assert.ok(!summary.consolidatedFrom.includes(invalidated.id), 'an invalidated episode must not return');
  assert.doesNotMatch(summary.statement, /THE RETIRED WORDING/,
    'rolling up "everything ever said" would quietly restore deliberately retired facts');
  assert.doesNotMatch(summary.statement, /THE INVALIDATED WORDING/);
  for (const item of live) assert.match(summary.statement, new RegExp(item.subject));
});

test('ITEM 2 HARD GATE 2: lossless for everything still current', async (t) => {
  await withStore(t, async (store) => {
    const made = await seed(store, 9, ['alpha', 'beta', 'gamma', 'delta']);
    const { summary } = await store.consolidate(9, 'claude');
    for (const original of made) {
      assert.match(summary.statement, new RegExp(original.subject),
        `${original.subject} must survive consolidation`);
      assert.match(summary.statement, new RegExp(`${original.subject} happened`));
    }
  });
});

test('ITEM 2: trust is never laundered - a summary is only as good as its weakest input', async (t) => {
  await withStore(t, async (store) => {
    await seed(store, 11, ['a', 'b', 'c']);   // all untrusted
    const { summary } = await store.consolidate(11, 'claude');
    assert.equal(summary.trust, 'untrusted',
      'rolling untrusted claims into one confident fact is how a memory system starts lying');
    assert.match(summary.statement, /\[untrusted\]/, 'per-episode trust stays visible');
  });
});

test('ITEM 2 RED: a summary is never consolidated into another summary', async (t) => {
  await withStore(t, async (store) => {
    await seed(store, 13, ['a', 'b', 'c']);
    const first = await store.consolidate(13, 'claude');
    assert.ok(first.summary);
    const second = await store.consolidate(13, 'claude');
    assert.equal(second.summary, undefined, 'nothing left to consolidate');
    assert.match(second.reason, /minimum is/);
  });
});

test('ITEM 2 GREEN CONTROL: a short assignment is left completely alone', async (t) => {
  await withStore(t, async (store) => {
    const made = await seed(store, 21, ['only-one', 'only-two']);
    const result = await store.consolidate(21, 'claude');
    assert.equal(result.summary, undefined);
    assert.equal(result.absorbed, 0);
    const current = await store.forWake([21]);
    assert.deepEqual(current.map((i) => i.id).sort(), made.map((i) => i.id).sort(),
      'consolidation must not touch an assignment that does not need it');
  });
});

test('ITEM 2: consolidation is scoped to one assignment', async (t) => {
  await withStore(t, async (store) => {
    await seed(store, 30, ['a', 'b', 'c']);
    const other = await seed(store, 31, ['x', 'y', 'z']);
    await store.consolidate(30, 'claude');
    const untouched = await store.forWake([31]);
    assert.deepEqual(untouched.map((i) => i.id).sort(), other.map((i) => i.id).sort(),
      'a neighbouring assignment must be untouched');
  });
});
