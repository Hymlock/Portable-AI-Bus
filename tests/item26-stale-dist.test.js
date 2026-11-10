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

test('ITEM 26: it emits a WARNING, not a refusal, and names the remedy', async (t) => {
  const dir = fixture(t);
  const base = Date.now() - 60_000;
  write(dir, path.join('dist', 'a.js'), base);
  write(dir, path.join('src', 'a.ts'), base + 30_000);

  /**
   * grok r34: the previous version of this test collected `warnings[]` and NEVER ASSERTED ON
   * IT. `doesNotThrow` was the only assertion, so the warning property - the entire point of
   * the item - was untested. Vacuous, in the file written to prove the warning exists.
   *
   * `process.emitWarning` is asynchronous, so the listener is awaited rather than polled.
   */
  const seen = await new Promise((resolve) => {
    const listener = (warning) => { process.off('warning', listener); resolve(warning); };
    process.on('warning', listener);
    // Must not throw: refusing would make single-file runs depend on a compile, and a guard
    // that cannot be satisfied gets bypassed (item 6).
    assert.doesNotThrow(() => requireFreshDist({ repo: dir }));
    setTimeout(() => { process.off('warning', listener); resolve(undefined); }, 2000);
  });

  assert.ok(seen, 'a stale dist must actually EMIT a warning, not merely fail to throw');
  assert.equal(seen.name, 'StaleDistWarning', 'named, so it can be filtered or searched for');
  assert.match(seen.message, /older than src/, 'and it must say what is wrong');
  assert.match(seen.message, /npm run compile|npm test/, 'and name the remedy');
});

test('ITEM 26: EVERY dist-loading test carries the check, not just the ones I remembered', () => {
  /**
   * grok r34: "4 of 40 dist-loading tests import the helper - mailbox.test.js and most others
   * can still pass on stale dist, silently. OPT-IN IS NOT THE ITEM."
   *
   * Correct. The measured failure was a green from a build that did not happen; a check
   * present in the files I happened to think of does not prevent that, it just makes those
   * four files honest. This gate fails the moment someone adds a test that loads dist without
   * the guard - including me, next week.
   */
  /**
   * EVERY `.js` under tests/, not just `.test.js`.
   *
   * grok r37 recorded that `vscode-integration.js` loads dist and is not a `.test.js`, so
   * `node --test tests/*.test.js` never sees it - correctly calling it outside the MEASURED
   * footgun, since the vscode driver launches it rather than a person. That is fair about the
   * item and wrong as a stopping point: "outside the measured case" is how the next measured
   * case gets made. The file is now covered, and so is the gate that would have missed it.
   */
  const dir = path.join(__dirname);
  const unguarded = fs.readdirSync(dir)
    .filter((name) => name.endsWith('.js'))
    .filter((name) => {
      const source = fs.readFileSync(path.join(dir, name), 'utf8');
      return /require\('\.\.\/dist/.test(source) && !/require-fresh-dist/.test(source);
    });
  assert.deepEqual(unguarded, [],
    `these files load dist/ without the staleness check: ${unguarded.join(', ')}`);
});

test('ITEM 26: a repo with no src or no dist is not this check\'s business', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pab-i26-bare-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 8 }));
  assert.equal(requireFreshDist({ warn: false, repo: dir }), 0,
    'absent trees must read as "nothing to say", not as stale');
});
