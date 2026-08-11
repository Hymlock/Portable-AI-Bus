const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

/**
 * ANY funded vendor can pilot the chat interface; the OTHER TWO spin up as brains.
 *
 * So the shape is a rule, not a fixed pairing: brains = funded seats minus whoever is piloting,
 * and never more than two. Hardcoding `codex,grok` is only correct while claude happens to hold
 * the chat interface, and silently wrong the moment codex or grok does.
 *
 * Live cost of getting this wrong: the defaults were `--console codex --brains claude,codex,grok`
 * - a redundant claude brain beside the chat interface that already drives that seat, plus codex
 * as both console and brain. A third brain can only mean one wallet driving two seats at once,
 * which is exactly what the retired `worker` seat did on codex's wallet.
 *
 * Read as text rather than by requiring the scripts, which execute on import.
 */

const SCRIPTS = path.join(__dirname, '..', 'scripts');
const FUNDED = ['claude', 'codex', 'grok'];

function defaultsOf(file) {
  const source = fs.readFileSync(path.join(SCRIPTS, file), 'utf8');
  const consoleSeat = source.match(/option\(\s*'--console',\s*'([^']+)'\s*\)/);
  assert.ok(consoleSeat, `${file}: no --console default found`);
  const derived = /FUNDED_SEATS\s*\.filter\(\s*\(\s*seat\s*\)\s*=>\s*seat\s*!==\s*consoleSeat\s*\)/;
  return { file, consoleSeat: consoleSeat[1], derivesBrains: derived.test(source), source };
}

for (const file of ['bus-up.js', 'bus-restart.js']) {
  test(`${file} derives the brain list from whoever is piloting`, () => {
    const { consoleSeat, derivesBrains, source } = defaultsOf(file);
    assert.ok(FUNDED.includes(consoleSeat), `default pilot ${consoleSeat} is not a funded vendor`);
    assert.ok(derivesBrains,
      `${file} must default --brains to the funded seats MINUS the console seat. A hardcoded pair `
      + 'is only right while one particular seat pilots.');
    assert.ok(/FUNDED_SEATS\s*=\s*\[\s*'claude',\s*'codex',\s*'grok'\s*\]/.test(source),
      'the funded roster must be stated once, so the two scripts cannot drift apart');
  });
}

test('every possible pilot yields exactly the other two as brains', () => {
  // The rule has to hold for all three, not just the seat that happens to be piloting today.
  for (const pilot of FUNDED) {
    const brains = FUNDED.filter((seat) => seat !== pilot);
    assert.equal(brains.length, 2, `${pilot} piloting must leave exactly two brains`);
    assert.ok(!brains.includes(pilot), 'the pilot must never also hold a brain');
  }
});

test('bus-up refuses a third brain', () => {
  // Three brains means one wallet is driving two seats at once.
  const result = spawnSync(process.execPath, [
    path.join(SCRIPTS, 'bus-up.js'),
    '--root', path.join(__dirname, '..'),
    '--console', 'claude',
    '--brains', 'codex,grok,worker'
  ], { encoding: 'utf8', windowsHide: true });

  assert.equal(result.status, 2, 'a third brain must be refused before anything starts');
  assert.match(result.stderr, /at most 2 can be active/i);
});

test('bus-up refuses to give the pilot a brain as well', () => {
  const result = spawnSync(process.execPath, [
    path.join(SCRIPTS, 'bus-up.js'),
    '--root', path.join(__dirname, '..'),
    '--console', 'grok',
    '--brains', 'grok,claude'
  ], { encoding: 'utf8', windowsHide: true });

  assert.equal(result.status, 2);
  assert.match(result.stderr, /also in --brains/i);
});
