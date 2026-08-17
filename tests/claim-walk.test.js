const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { afterEach, test } = require('node:test');

const {
  directoryContainsIdentities,
  directoryContainsIdentitiesUnbounded,
  emptyWalkStats,
  observedFilesystemIdentity
} = require('../dist/claim-walk.js');

let roots = [];

async function scratch(prefix = 'pab-claim-walk-') {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  roots.push(root);
  return root;
}

afterEach(async () => {
  const doomed = roots;
  roots = [];
  await Promise.all(doomed.map((root) => fs.rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 })));
});

async function writeTree(base, dirs, filesPerDir) {
  for (let d = 0; d < dirs; d += 1) {
    const dir = path.join(base, `bucket-${String(d).padStart(2, '0')}`);
    await fs.mkdir(dir, { recursive: true });
    await Promise.all(
      Array.from({ length: filesPerDir }, (_, i) => fs.writeFile(path.join(dir, `f-${i}.txt`), `n=${d}-${i}\n`))
    );
  }
}

test('ITEM 14 RED: the unbounded walk follows a junction onto a large tree — show the cost', async () => {
  const claimed = await scratch('pab-cw-claimed-');
  const foreign = await scratch('pab-cw-foreign-');
  await fs.writeFile(path.join(claimed, 'mailbox.ts'), 'inside\n');
  await writeTree(foreign, 50, 50);
  await fs.symlink(foreign, path.join(claimed, 'escape'), 'junction');

  const unbounded = emptyWalkStats();
  const started = process.hrtime.bigint();
  const hit = directoryContainsIdentitiesUnbounded(
    claimed,
    new Set(['filesystem-v1:0:0']),
    unbounded
  );
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;

  assert.equal(hit, false);
  assert.ok(
    unbounded.entriesSeen >= 2500,
    `unbounded walk must visit the foreign tree; saw ${unbounded.entriesSeen} entries in ${elapsedMs.toFixed(1)}ms`
  );
  assert.equal(unbounded.skippedEscapes, 0, 'the historical walk has no stay-under-root skip');
});

test('ITEM 14 GREEN: stay-under-root does not walk the same outbound junction', async () => {
  const claimed = await scratch('pab-cw-claimed-');
  const foreign = await scratch('pab-cw-foreign-');
  await fs.writeFile(path.join(claimed, 'mailbox.ts'), 'inside\n');
  await writeTree(foreign, 50, 50);
  await fs.symlink(foreign, path.join(claimed, 'escape'), 'junction');

  const stats = emptyWalkStats();
  const started = process.hrtime.bigint();
  const hit = directoryContainsIdentities(
    claimed,
    new Set(['filesystem-v1:0:0']),
    { stayUnderRoot: claimed, stats }
  );
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;

  assert.equal(hit, false);
  assert.ok(stats.skippedEscapes >= 1, `expected to skip the outbound junction, saw ${stats.skippedEscapes}`);
  assert.ok(
    stats.entriesSeen < 100,
    `stay-under-root must not walk the 2500-file foreign tree; saw ${stats.entriesSeen} entries in ${elapsedMs.toFixed(1)}ms`
  );
  assert.ok(elapsedMs < 100, `bounded walk took ${elapsedMs.toFixed(1)}ms; a follow-the-junction walk was 326ms`);
});

test('ITEM 14 GREEN: directory-vs-outside-hardlink still resolves — the walk exists for this', async () => {
  const claimed = await scratch('pab-cw-dir-');
  const other = await scratch('pab-cw-other-');
  const inside = path.join(claimed, 'mailbox.ts');
  const alias = path.join(other, 'mailbox-hardlink.ts');
  await fs.writeFile(inside, 'fixture\n');
  await fs.link(inside, alias);

  const target = observedFilesystemIdentity(alias);
  assert.ok(target, 'hardlink must expose a filesystem identity');
  const stats = emptyWalkStats();
  const found = directoryContainsIdentities(claimed, new Set([target]), {
    stayUnderRoot: claimed,
    stats
  });
  assert.equal(found, true, 'a hardlink outside the tree is the same inode as a file inside it');
  assert.equal(stats.skippedEscapes, 0);
});

test('ITEM 14 GREEN: a legitimate deep tree still finds a hardlink of a deep leaf', async () => {
  const claimed = await scratch('pab-cw-deep-');
  const other = await scratch('pab-cw-deep-other-');
  let current = claimed;
  for (let i = 0; i < 24; i += 1) {
    current = path.join(current, `d${i}`);
    await fs.mkdir(current);
  }
  const leaf = path.join(current, 'leaf.ts');
  await fs.writeFile(leaf, 'deep\n');
  const alias = path.join(other, 'leaf-hardlink.ts');
  await fs.link(leaf, alias);

  const target = observedFilesystemIdentity(alias);
  assert.ok(target);
  const found = directoryContainsIdentities(claimed, new Set([target]), { stayUnderRoot: claimed });
  assert.equal(found, true, 'depth is not the bound; stay-under-root still walks a real deep tree');
});

test('ITEM 14 GREEN: a junction that stays inside the claimed tree is still followed', async () => {
  const claimed = await scratch('pab-cw-inside-');
  const realDir = path.join(claimed, 'real');
  const viaLink = path.join(claimed, 'via');
  await fs.mkdir(realDir);
  const hidden = path.join(realDir, 'hidden.ts');
  await fs.writeFile(hidden, 'inside-via-junction\n');
  await fs.symlink(realDir, viaLink, 'junction');

  const target = observedFilesystemIdentity(hidden);
  assert.ok(target);
  const found = directoryContainsIdentities(claimed, new Set([target]), { stayUnderRoot: claimed });
  assert.equal(found, true, 'in-tree junctions remain part of the claimed tree');
});

test('ITEM 14 GREEN: a cyclic junction does not hang', async () => {
  const claimed = await scratch('pab-cw-cycle-');
  await fs.writeFile(path.join(claimed, 'mailbox.ts'), 'cycle\n');
  await fs.symlink(claimed, path.join(claimed, 'loop'), 'junction');

  const started = process.hrtime.bigint();
  const found = directoryContainsIdentities(
    claimed,
    new Set(['filesystem-v1:0:0']),
    { stayUnderRoot: claimed }
  );
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
  assert.equal(found, false);
  assert.ok(elapsedMs < 100, `cycle walk took ${elapsedMs.toFixed(1)}ms`);
});
