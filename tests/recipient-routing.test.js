const assert = require('node:assert/strict');
const test = require('node:test');
require('./helpers/require-fresh-dist')();
const { executePlan } = require('../dist/brain/brains/index.js');

/**
 * A report addressed to a seat that does not exist is a LOST report.
 *
 * Live cost: the grok seat repeatedly addressed reports to `console`. The harness refused each
 * one with 403 unknown_seat, so nothing landed, so "done requires a report" correctly refused to
 * close the wake, so the repair path ran again - ten paid model calls on a task whose actual work
 * had already been committed. A correct guard amplifying one wrong name.
 */

function recordingTools(sent) {
  return {
    async send(input) { sent.push(input); return { ok: true }; },
    async status() { return {}; },
    async claim() { return {}; },
    async release() { return {}; },
    async runCapability() { return {}; },
    async listCapabilities() { return []; }
  };
}

const seats = ['claude', 'codex', 'grok', 'hymlock', 'worker'];

test('a report to a nonexistent seat is delivered to whoever asked', async () => {
  const sent = [];
  const plan = {
    actions: [{ type: 'send', to: 'console', kind: 'report', subject: 'findings', body: 'x' }],
    done: true
  };

  const failures = await executePlan(recordingTools(sent), plan, { seats, fallbackTo: 'hymlock' });

  assert.equal(sent.length, 1, 'the report must still be delivered');
  assert.equal(sent[0].to, 'hymlock', 'redirected to the seat that asked');
  assert.equal(failures.length, 1, 'and the substitution is reported, not hidden');
  assert.match(failures[0].detail, /not a seat/);
  assert.match(failures[0].detail, /claude, codex, grok, hymlock, worker/,
    'the model must be told the real roster, or it guesses the same name again');
});

test('a valid recipient is never rewritten', async () => {
  const sent = [];
  const plan = { actions: [{ type: 'send', to: 'codex', kind: 'note', subject: 's', body: 'b' }], done: true };
  const failures = await executePlan(recordingTools(sent), plan, { seats, fallbackTo: 'hymlock' });
  assert.equal(sent[0].to, 'codex');
  assert.equal(failures.length, 0);
});

test('with no roster known, addressing is left alone', async () => {
  // Not knowing the seats must not silently redirect mail. Unknown is not the same as wrong.
  const sent = [];
  const plan = { actions: [{ type: 'send', to: 'whoever', kind: 'note', subject: 's', body: 'b' }], done: true };
  await executePlan(recordingTools(sent), plan, {});
  assert.equal(sent[0].to, 'whoever');
});

test('an unusable fallback does not invent a destination', async () => {
  const sent = [];
  const plan = { actions: [{ type: 'send', to: 'console', kind: 'note', subject: 's', body: 'b' }], done: true };
  await executePlan(recordingTools(sent), plan, { seats, fallbackTo: 'also-not-a-seat' });
  assert.equal(sent[0].to, 'console',
    'if there is nowhere sound to send it, let the harness refuse rather than guess');
});
