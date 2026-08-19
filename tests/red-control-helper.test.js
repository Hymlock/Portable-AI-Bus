const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

const { withBrokenFile } = require('./helpers/red-control');

// ---------------------------------------------------------------------------
// The helper that exists because four of my own verifications reported success while the
// thing under test was never exercised. Its single job is to refuse to measure a red control
// whose break did not apply - so it had better be tested for exactly that, or it becomes the
// fifth instance of the defect it was written to prevent.
// ---------------------------------------------------------------------------

function tempFile(t, contents = 'const value = 1;\n') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pab-redctl-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 8 }));
  const file = path.join(dir, 'subject.js');
  fs.writeFileSync(file, contents);
  return file;
}

test('RED CONTROL HELPER: a mutation that does not mutate is REFUSED', (t) => {
  const file = tempFile(t);
  // This is the exact failure: a regex that silently does not match. Previously it produced
  // `fail=0`, which reads identically to "the gate cannot go red".
  assert.throws(
    () => withBrokenFile(file, (source) => source.replace(/NOT_PRESENT/, 'x'), () => 'measured'),
    /did NOT modify/,
    'a no-op break must throw rather than let a false green be recorded'
  );
});

test('RED CONTROL HELPER: a real mutation is applied while the callback runs', (t) => {
  const file = tempFile(t);
  let seen;
  const result = withBrokenFile(
    file,
    (source) => source.replace('const value = 1;', 'const value = 2;'),
    () => { seen = fs.readFileSync(file, 'utf8'); return 'measured'; }
  );
  assert.equal(result, 'measured');
  assert.match(seen, /const value = 2;/, 'the callback must observe the BROKEN file');
});

test('RED CONTROL HELPER: the file is restored byte-exactly', (t) => {
  const original = 'const value = 1;\r\n// trailing comment, CRLF on purpose\r\n';
  const file = tempFile(t, original);
  withBrokenFile(file, (source) => `${source}// broken\n`, () => undefined);
  assert.equal(fs.readFileSync(file, 'utf8'), original,
    'line endings included - a restore that normalises them leaves the tree dirty');
});

test('RED CONTROL HELPER: it restores even when the measurement THROWS', (t) => {
  const original = 'const value = 1;\n';
  const file = tempFile(t, original);
  assert.throws(() => withBrokenFile(file, (source) => `${source}// broken\n`, () => {
    throw new Error('the gate blew up');
  }), /the gate blew up/);
  // Without the finally, a throwing gate would leave the repo broken - which on this project
  // means the next commit carries a mutation nobody made deliberately.
  assert.equal(fs.readFileSync(file, 'utf8'), original, 'a throwing measurement must still restore');
});
