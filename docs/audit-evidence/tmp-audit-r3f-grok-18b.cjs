'use strict';
/**
 * Follow-up: item 18 two-step verbs with the real arity
 * supersedeMessage(seq, by, reason, actor)
 */
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { MailboxStore } = require('./dist/mailbox.js');

function rec(name, status, detail) {
  console.log(`[${status}] ${name}: ${String(detail).split('\n')[0]}`);
  return { name, status, detail: String(detail) };
}

async function main() {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'pab-r3f-18b-'));
  const store = new MailboxStore(dir);
  await store.ensureInitialized(['claude', 'grok', 'codex'], 500);
  const rows = [];
  try {
    const original = await store.send({
      from: 'claude', to: 'grok', kind: 'task',
      subject: 'original brief', body: 'DO THE THING'
    });
    const replacement = await store.send({
      from: 'claude', to: 'codex', kind: 'task', subject: 'other', body: 'other'
    });
    try {
      await store.supersedeMessage(original.seq, replacement.seq, 'cross two-step', 'claude');
      rows.push(rec('twostep-cross-recipient', 'FAIL', 'two-step retracted across recipients'));
    } catch (error) {
      rows.push(rec('twostep-cross-recipient',
        /addressed to/i.test(error.message) ? 'PASS' : 'FAIL', error.message));
    }
    const inbox = await store.inbox('grok');
    rows.push(rec('twostep-cross-leaves-original',
      inbox.some((m) => m.seq === original.seq && m.supersededBy === undefined) ? 'PASS' : 'FAIL',
      `inbox=${inbox.map((m) => `${m.seq}:${m.supersededBy ?? '-'}`).join(',')}`));

    const consumed = await store.send({
      from: 'claude', to: 'grok', kind: 'task', subject: 'read-me', body: 'secret'
    });
    await store.acknowledge('grok', [consumed.seq]);
    const later = await store.send({ from: 'claude', to: 'grok', kind: 'task', subject: 'later', body: 'later' });
    try {
      await store.supersedeMessage(consumed.seq, later.seq, 'two-step late', 'claude');
      rows.push(rec('twostep-consumed', 'FAIL', 'two-step marked a read message'));
    } catch (error) {
      rows.push(rec('twostep-consumed', /already read/i.test(error.message) ? 'PASS' : 'FAIL', error.message));
    }

    const needReason = await store.send({ from: 'claude', to: 'grok', kind: 'task', subject: 'need-r', body: 'x' });
    const after = await store.send({ from: 'claude', to: 'grok', kind: 'task', subject: 'after', body: 'y' });
    try {
      await store.supersedeMessage(needReason.seq, after.seq, '   ', 'claude');
      rows.push(rec('twostep-empty-reason', 'FAIL', 'two-step accepted whitespace reason'));
    } catch (error) {
      rows.push(rec('twostep-empty-reason',
        /reason must not be empty/i.test(error.message) ? 'NOTE' : 'FAIL', error.message));
    }

    // two-step writes supersededAt (parity with atomic)
    const live = await store.send({ from: 'claude', to: 'grok', kind: 'task', subject: 'live', body: 'live' });
    const corr = await store.send({ from: 'claude', to: 'grok', kind: 'task', subject: 'corr', body: 'corr' });
    const marked = await store.supersedeMessage(live.seq, corr.seq, 'fix', 'claude');
    rows.push(rec('twostep-writes-supersededAt',
      typeof marked.supersededAt === 'string' && marked.supersededBy === corr.seq ? 'PASS' : 'FAIL',
      JSON.stringify({ supersededBy: marked.supersededBy, supersededAt: marked.supersededAt })));
  } finally {
    await fsp.rm(dir, { recursive: true, force: true, maxRetries: 8 }).catch(() => {});
  }
  fs.writeFileSync(path.join(__dirname, 'tmp-audit-r3f-grok-18b-out.json'), JSON.stringify({ rows }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
