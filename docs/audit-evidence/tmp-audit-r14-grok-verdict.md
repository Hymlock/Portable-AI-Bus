# r14 — r13c leftover closed on the untracked patch, not a certification of HEAD

HEAD is still `373e176`. Claude still holds the four live repair paths.
I did not edit `src/` or `tests/` or live `scripts/claim-guard-cli.js`.
I did edit the untracked patch: `tmp-audit-r6-patches/src-evidence-withLock.ts`,
`tmp-audit-r6-patches/dist-patched/evidence.js`, and `APPLY.md`.

Incoming mail: 0. I did not re-run r7 against HEAD (that would be a heartbeat).
I did not resend the r5 brief or r6 apply notes.

## What this wake measured

This wake re-read HEAD, not last-wake memory.

HEAD still has the original holes:
- `scripts/claim-guard-cli.js:255` still skips bare `extends`
- `withinScratch` is still lexical
- no source-path walk
- no empty-compile refuse (solution-style `files:[]` + `references` still prints `compile OK`)
- `noCheck` is still NOTE plus exit 0 (classified should-refuse)
- `evidence.ts:489` still recovers only when `owner.pid` is defined and dead
- `mailbox.ts:977` `operatorCloseRecovery` still has no `consolidate`

New instrument: `tmp-audit-r14-grok.cjs` against the patched dist on the REAL lock path
(`.ai-bus/runtime/mailbox/evidence.json.lock`). Not a re-run of r13c (that was pre-fix).

r13c leftover, same class as item 2 hole 1 (no live owner = debris):

| attack | r13c (pre-fix patch) | r14 (this wake) |
|---|---|---|
| lock path is an empty directory | FAIL EISDIR on `rm` | **PASS** recovered in 3ms |
| lock path is a directory with a nested file | not measured | **PASS** recovered in 3ms |

Controls still hold on the patched dist: empty / unparseable / missing-pid / string-pid recover in milliseconds; live pid and BOM+live pid time out (~10s). r14: **8 PASS / 0 FAIL / 0 NOTE**.

Patch change: treat `EISDIR` on `open(wx)` like `EEXIST`, and `rm` debris with `{ force: true, recursive: true }`. Windows reports `EEXIST` when the lock path is a directory; Unix reports `EISDIR` on the open.

This is still not a certification of HEAD and not a self-certification.

## Open dependency

Unchanged. Claude holds `scripts/claim-guard-cli.js`, `src/evidence.ts`,
`src/mailbox.ts`, `tests/audit-round2.test.js`. Items 15 and 2 stay unmet
until those claims are released or the patch is applied on HEAD and
re-attacked with a new instrument.

Item 20 stays certified 9/9.
