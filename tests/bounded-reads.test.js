const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

require('./helpers/require-fresh-dist')();
const { MailboxStore } = require('../dist/mailbox.js');

/**
 * Ported from the Parchmap installed bundle (2026-10-17): an unbounded Promise.all over ~4100
 * inbox files hit EMFILE on Windows. A full scan must never have more than 64 reads in flight.
 */
test('a full inbox scan keeps at most 64 file reads in flight', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pab-bounded-'));
  t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 }));
  const store = new MailboxStore(root);
  await store.ensureInitialized(['a', 'b'], 100_000);
  const inbox = path.join(root, '.ai-bus', 'runtime', 'mailbox', 'inbox');
  const total = 300;
  for (let seq = 1; seq <= total; seq += 1) {
    const message = {
      schema: 1, seq, round: seq, from: 'a', to: 'b', kind: 'note', subject: `s${seq}`, body: 'x',
      createdAt: new Date().toISOString(), read: true
    };
    await fs.writeFile(path.join(inbox, `${String(seq).padStart(6, '0')}-a-to-b.json`), JSON.stringify(message));
  }
  const original = store.readJson.bind(store);
  let inFlight = 0;
  let peak = 0;
  store.readJson = async (file) => {
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    try {
      await new Promise((resolve) => setImmediate(resolve));
      return await original(file);
    } finally {
      inFlight -= 1;
    }
  };
  const doctor = await store.doctor();
  assert.equal(doctor.metrics.messages, total);
  assert.ok(peak <= 64, `peak concurrent reads was ${peak}`);
  assert.ok(peak > 1, 'reads should still be batched in parallel');
});
