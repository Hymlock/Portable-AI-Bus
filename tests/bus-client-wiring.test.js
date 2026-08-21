const assert = require('node:assert/strict');
const test = require('node:test');
require('./helpers/require-fresh-dist')();
const { cliBusClient } = require('../dist/brain/bus-client.js');

// Why this file exists.
//
// Item 10 shipped `recallAssignment` in the store on 2026-08-15 with four test files covering
// it. It never ran. `runner.ts` guards on `if (bus.recallAssignment)`, the production client
// built by `cliBusClient` did not define it, and every test that "proved" Item 10 constructed
// its own bus object with the method attached. Store: tested. Product: unwired. The symptom
// outlived the fix by five days and cost two seats their briefs on 2026-08-20.
//
// A capability the runner reaches for THROUGH AN OPTIONAL METHOD is invisible when it is
// missing - the guard turns a wiring bug into a silent no-op. So the wiring itself needs a
// test, separate from the behaviour.
test('the production bus client exposes every optional method the runner reaches for', () => {
  const client = cliBusClient({ root: process.cwd(), log() {} });

  // Each name here is read by runner.ts behind an `if (bus.X)` guard. A missing one does not
  // throw, it just quietly does nothing - which is exactly how this went unnoticed.
  const reachedFor = [
    'listen', 'read', 'tools',
    'loadRecovery', 'openRecovery', 'recordRecoveryAction', 'closeRecovery',
    'recallAssignment',   // Item 10: the brief for work in flight
    'currentAssignment',  // the standing assignment for a seat with no open work
    'listEvidence'
  ];

  const missing = reachedFor.filter((name) => typeof client[name] !== 'function');
  assert.deepEqual(missing, [],
    'the runner reaches for these and silently skips any that are absent: ' + missing.join(', '));
});
