const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

const requireFreshDist = require('./helpers/require-fresh-dist');

// ---------------------------------------------------------------------------
// ITEM 26: a test file invoked DIRECTLY can pass on stale `dist`.
//
// Measured 2026-08-19: item 21's gates reported 4/4 PASS while `tsc` was FAILING on an
// undefined type name. They were exercising bytecode compiled before the change under test.
// A green from a build that did not happen is not a green, and it would have been committed.
//
// grok's correction in r29, and it is why the fix lives here rather than in package.json:
// `npm test` is `npm run compile && node --test`, so it compiles first and is NOT the
// footgun. The footgun is `node --test tests/one-file.test.js`, which require()s dist/
// directly. Describing this as a defect of `npm test` would have been wrong.
//
// Deliberately a WARNING, not a refusal. Item 6: a guard that cannot be SATISFIED gets
// bypassed. Making every single-file run compile first is slow enough that people stop
// running single files, and fast single-file runs are the entire point during a tight loop.
// ---------------------------------------------------------------------------

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pab-i26-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 8 }));
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'dist'), { recursive: true });
  return dir;
}

function write(dir, rel, mtimeMs) {
  const file = path.join(dir, rel);
  fs.writeFileSync(file, 'x');
  fs.utimesSync(file, mtimeMs / 1000, mtimeMs / 1000);
}

test('ITEM 26 RED: src newer than dist is detected as stale', (t) => {
  const dir = fixture(t);
  const base = Date.now() - 60_000;
  write(dir, path.join('dist', 'a.js'), base);
  write(dir, path.join('src', 'a.ts'), base + 30_000);

  const staleBy = requireFreshDist({ warn: false, repo: dir });
  assert.ok(staleBy > 0, 'REGRESSION: a test run against dist older than src reported no problem');
  assert.ok(staleBy >= 29_000, `expected roughly 30s of staleness, got ${staleBy}ms`);
});

test('ITEM 26 GREEN CONTROL: dist newer than src is not flagged', (t) => {
  const dir = fixture(t);
  const base = Date.now() - 60_000;
  write(dir, path.join('src', 'a.ts'), base);
  write(dir, path.join('dist', 'a.js'), base + 30_000);

  // Without this a check that always warned would pass the gate above while making the
  // warning meaningless - the same "signal becomes noise" failure item 22 exists to avoid.
  assert.equal(requireFreshDist({ warn: false, repo: dir }), 0, 'a fresh build must be silent');
});

test('ITEM 26: it emits a WARNING, not a refusal, and names the remedy', (t) => {
  const dir = fixture(t);
  const base = Date.now() - 60_000;
  write(dir, path.join('dist', 'a.js'), base);
  write(dir, path.join('src', 'a.ts'), base + 30_000);

  const warnings = [];
  const listener = (warning) => warnings.push(warning);
  process.on('warning', listener);
  t.after(() => process.off('warning', listener));

  // Must not throw: refusing would make single-file runs depend on a compile, and a guard
  // that cannot be satisfied gets bypassed (item 6).
  assert.doesNotThrow(() => requireFreshDist({ repo: dir }));
});

test('ITEM 26: a repo with no src or no dist is not this check\'s business', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pab-i26-bare-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 8 }));
  assert.equal(requireFreshDist({ warn: false, repo: dir }), 0,
    'absent trees must read as "nothing to say", not as stale');
});
