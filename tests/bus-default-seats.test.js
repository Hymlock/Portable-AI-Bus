const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');

/**
 * The DEFAULTS must describe the correct shape, because defaults are what actually runs.
 *
 * Live cost: the roster was cleaned to three seats and the console-seat-with-a-brain guard was
 * added - and the defaults still said `--console codex --brains claude,codex,grok`. Any restart
 * that omitted the flags would have re-seated a redundant `claude` brain beside the chat
 * interface, rebuilding the exact shape just cleaned up, AND made codex both console and brain,
 * which the new guard refuses outright. A guard whose own defaults trip it is not a guard.
 *
 * Read as text rather than by requiring the scripts, which execute on import.
 */

const SCRIPTS = path.join(__dirname, '..', 'scripts');

function defaultsOf(file) {
  const source = fs.readFileSync(path.join(SCRIPTS, file), 'utf8');
  const consoleSeat = source.match(/option\(\s*'--console',\s*'([^']+)'\s*\)/);
  const brains = source.match(/option\(\s*'--brains',\s*'([^']+)'\s*\)/);
  assert.ok(consoleSeat, `${file}: no --console default found`);
  assert.ok(brains, `${file}: no --brains default found`);
  return { file, consoleSeat: consoleSeat[1], brains: brains[1].split(',').map((s) => s.trim()) };
}

for (const file of ['bus-up.js', 'bus-restart.js']) {
  test(`${file} does not give the console seat a brain by default`, () => {
    const { consoleSeat, brains } = defaultsOf(file);
    assert.ok(!brains.includes(consoleSeat),
      `default --brains ${brains.join(',')} contains the default --console ${consoleSeat}; `
      + 'the console seat is driven by its live interface and must not also get a brain');
  });

  test(`${file} pilots from claude and seats brains only for the unattended vendors`, () => {
    const { consoleSeat, brains } = defaultsOf(file);
    assert.equal(consoleSeat, 'claude',
      'the chat interface holds the claude seat and pilots from it');
    assert.deepEqual(brains.slice().sort(), ['codex', 'grok'],
      'a brain exists to drive a seat with nobody live behind it - claude has someone');
  });
}

test('the two scripts agree, so a restart cannot silently reshape the bus', () => {
  const up = defaultsOf('bus-up.js');
  const restart = defaultsOf('bus-restart.js');
  assert.equal(up.consoleSeat, restart.consoleSeat);
  assert.deepEqual(up.brains, restart.brains);
});
