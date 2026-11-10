const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
require('./helpers/require-fresh-dist')();
const { MailboxStore } = require('../dist/mailbox.js');
const { RECOVERY_LIMIT_BYTES } = require('../dist/brain/brains/agent.js');

// Why: on 2026-08-20 BOTH seats stalled on the same defect. An assignment longer than the
// 2KB recall field is truncated when the seat wakes - not when the operator writes it. codex
// received a brief cut off mid-claim and correctly refused to infer the rest. grok held an
// open checkpoint whose 2845-char brief truncated before the gates it named, so the gates
// could never be met and the checkpoint could never close: a closed loop built entirely from
// correct behaviour on both sides.
//
// Truncation at READ time is unactionable - the reader cannot know what it did not receive.
// The operator writing it can fix it in one edit. So the check belongs at the write.
async function freshStore() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'assign-cap-'));
  const store = new MailboxStore(root);
  await store.ensureInitialized(['claude', 'grok'], 64);
  await store.setGoal({ statement: 'a goal', doneWhen: 'done when the tests say so' });
  return store;
}

test('an assignment that would truncate on wake is REFUSED at write time', async () => {
  const store = await freshStore();
  const tooLong = 'x'.repeat(RECOVERY_LIMIT_BYTES + 1);

  await assert.rejects(
    () => store.assignGoal('grok', tooLong),
    (error) => {
      assert.match(String(error.message), /truncat|too long|\d+ bytes/i,
        'the refusal must say WHY, with the size, or the operator just retries the same thing');
      return true;
    },
    'a brief that cannot survive the recall field must not be accepted silently'
  );
});

test('an assignment inside the cap is accepted unchanged', async () => {
  const store = await freshStore();
  const fits = 'verify C1-C9 against the fork; read-only; detail arrives as mail';

  await store.assignGoal('grok', fits);

  assert.equal(await store.currentAssignment('grok'), fits,
    'the green control: normal assignments must be untouched by the guard');
});

test('the guard measures BYTES, not characters', async () => {
  const store = await freshStore();
  // Well under the cap in characters, over it in UTF-8 bytes. A character-based check would
  // pass this and the seat would still receive a truncated brief.
  const multibyte = '\u00e9'.repeat(RECOVERY_LIMIT_BYTES - 10);

  await assert.rejects(() => store.assignGoal('grok', multibyte),
    'the field is capped in bytes; a char-count guard is a guard that misses');
});

test('the store cap and the wake cap are the same number', () => {
  const { ASSIGNMENT_LIMIT_BYTES } = require('../dist/mailbox.js');
  assert.equal(ASSIGNMENT_LIMIT_BYTES, RECOVERY_LIMIT_BYTES,
    'the store refuses at one size and the wake truncates at another - assignments between ' +
    'the two would be accepted and then silently severed, which is the original bug wearing ' +
    'a different number');
});
