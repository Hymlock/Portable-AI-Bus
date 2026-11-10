const assert = require('node:assert/strict');
const test = require('node:test');
require('./helpers/require-fresh-dist')();
const { ReminderTracker } = require('../dist/reminders.js');

test('reminders establish a quiet baseline and report only new transitions', () => {
  const tracker = new ReminderTracker();
  assert.deepEqual(tracker.observe('one', { unread: { grok: 2, codex: 0 }, newestUnreadSeq: { grok: 3, codex: 0 }, staleSeats: ['claude'] }), { unreadAgents: [], staleSeats: [] });
  assert.deepEqual(tracker.observe('one', { unread: { grok: 2, codex: 1 }, newestUnreadSeq: { grok: 4, codex: 5 }, staleSeats: ['claude', 'grok'] }), {
    unreadAgents: [{ agent: 'codex', count: 1 }, { agent: 'grok', count: 2 }], staleSeats: ['grok']
  });
  assert.deepEqual(tracker.observe('one', { unread: { grok: 2, codex: 1 }, newestUnreadSeq: { grok: 4, codex: 5 }, staleSeats: ['claude', 'grok'] }), { unreadAgents: [], staleSeats: [] });
});

test('reminder baselines are isolated and resettable per workspace', () => {
  const tracker = new ReminderTracker();
  tracker.observe('one', { unread: { grok: 0 }, newestUnreadSeq: { grok: 0 }, staleSeats: [] });
  tracker.observe('two', { unread: { grok: 4 }, newestUnreadSeq: { grok: 4 }, staleSeats: ['grok'] });
  tracker.reset('one');
  assert.deepEqual(tracker.observe('one', { unread: { grok: 5 }, newestUnreadSeq: { grok: 5 }, staleSeats: ['grok'] }), { unreadAgents: [], staleSeats: [] });
  assert.deepEqual(tracker.observe('two', { unread: { grok: 4 }, newestUnreadSeq: { grok: 5 }, staleSeats: ['grok'] }), { unreadAgents: [{ agent: 'grok', count: 4 }], staleSeats: [] });
});
