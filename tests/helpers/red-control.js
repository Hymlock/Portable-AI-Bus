/**
 * Prove a gate can go RED, without fooling yourself about whether you broke anything.
 *
 * ## Why this exists
 *
 * Four times in two days a verification of mine reported success while the thing under test
 * was never exercised. Every one was the same defect wearing a different coat:
 *
 *   - `git stash push -- src` stashed NOTHING, because src/ was clean and the change was
 *     already committed. The "unfixed" run was the fixed code. Reported a clean pass.
 *   - a test file ran against a stale `dist` while `tsc` was FAILING. 4/4 green, about code
 *     that had never compiled.
 *   - a regex revert of a source file silently did not match. `fail=0` was read as "this gate
 *     cannot go red" when it meant "nothing was reverted".
 *   - a pre-publication scan asked `git diff origin/main..HEAD` - the files CHANGED - when the
 *     question was what a push makes PUBLIC, which is the whole tree.
 *
 * The shared shape: A CHECK REPORTED SUCCESS WITHOUT THE THING UNDER TEST HAVING BEEN
 * EXERCISED. That is the same defect this project has spent days finding in the bus itself -
 * a gate that cannot go red, a guard that cannot be satisfied, a store that is not the
 * feature. It kept reappearing in the INSTRUMENTS rather than the code, which is worse,
 * because an instrument is what you use to check everything else.
 *
 * So: never assert a red control until the break is CONFIRMED APPLIED, and never trust the
 * restore until it is CONFIRMED BYTE-IDENTICAL.
 *
 * ## Use
 *
 *   const { withBrokenFile } = require('./helpers/red-control');
 *
 *   const result = withBrokenFile(file, (source) => source.replace(GOOD, BAD), () => runGates());
 *   assert.ok(result.failed > 0, 'the gate must go red without the fix');
 *
 * The callback runs with the file broken. The file is restored before this returns, including
 * when the callback throws.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');

/**
 * @param {string} file        absolute path to the file to break
 * @param {(source: string) => string} breakIt   must return DIFFERENT text, or this throws
 * @param {() => T} run        what to measure while the file is broken
 * @returns {T}
 */
function withBrokenFile(file, breakIt, run) {
  const original = fs.readFileSync(file, 'utf8');
  const broken = breakIt(original);

  // THE WHOLE POINT. A mutation that does not mutate is how "fail=0" gets recorded as "this
  // gate cannot go red". Refuse to measure anything until the break is real.
  assert.notEqual(broken, original,
    `red control did NOT modify ${file}. A no-op revert reports a false green - ` +
    'check your pattern before trusting the result.');

  fs.writeFileSync(file, broken, 'utf8');
  try {
    return run();
  } finally {
    fs.writeFileSync(file, original, 'utf8');
    // And the restore has to be exact, or the next test in the file is measuring debris.
    const after = fs.readFileSync(file, 'utf8');
    assert.equal(after, original, `red control failed to restore ${file} exactly`);
  }
}

module.exports = { withBrokenFile };
