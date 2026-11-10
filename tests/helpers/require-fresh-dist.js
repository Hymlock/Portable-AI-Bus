/**
 * ITEM 26: a test file invoked DIRECTLY can pass on stale `dist`.
 *
 * `npm test` is `npm run compile && node --test`, so it compiles first and is NOT the footgun -
 * grok corrected me on that in r29, and the correction matters because I had been describing
 * this as a defect of `npm test`.
 *
 * The footgun is running one file by hand:
 *
 *   node --test tests/item21-survivable-refusal.test.js
 *
 * That `require()`s `dist/`, so it can report a confident green against bytecode compiled
 * before the change under test. Measured: item 21's gates passed 4/4 while `tsc` was FAILING
 * on an undefined type name. A green from a build that did not happen is not a green, and it
 * would have been committed.
 *
 * This is a WARNING, not a refusal, and that is deliberate. Refusing would make every
 * single-file run depend on a compile, which is slow enough that people stop running single
 * files - and the whole value of a single-file run is that it is fast during a tight loop.
 * Item 6's lesson: a guard that cannot be satisfied gets bypassed. So it says the one thing
 * the operator cannot work out from a green: THIS RESULT MAY BE ABOUT OLD CODE.
 *
 *   require('./helpers/require-fresh-dist')();
 */

const fs = require('node:fs');
const path = require('node:path');

const REPO = path.join(__dirname, '..', '..');

function newestMtimeMs(directory) {
  let newest = 0;
  let entries;
  try { entries = fs.readdirSync(directory, { withFileTypes: true }); } catch { return 0; }
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name === '.git') continue;
    const item = path.join(directory, entry.name);
    if (entry.isDirectory()) newest = Math.max(newest, newestMtimeMs(item));
    else if (entry.isFile()) {
      try { newest = Math.max(newest, fs.statSync(item).mtimeMs); } catch { /* changed mid-scan */ }
    }
  }
  return newest;
}

/**
 * Returns the staleness in ms (0 when fresh), so a gate can assert on it rather than scraping
 * stderr. Warns on stderr when src is newer than dist.
 */
function requireFreshDist({ warn = true, repo = REPO } = {}) {
  const src = newestMtimeMs(path.join(repo, 'src'));
  const dist = newestMtimeMs(path.join(repo, 'dist'));
  if (src === 0 || dist === 0) return 0;      // nothing to compare; not this check's business
  const staleBy = src - dist;
  if (staleBy > 0 && warn) {
    const seconds = Math.round(staleBy / 1000);
    process.emitWarning(
      `dist is ${seconds}s older than src. This run may be testing OLD code - ` +
      'run `npm run compile` first, or use `npm test` which compiles. ' +
      'A green from a build that did not happen is not a green.',
      'StaleDistWarning'
    );
  }
  return Math.max(0, staleBy);
}

module.exports = requireFreshDist;
module.exports.newestMtimeMs = newestMtimeMs;
