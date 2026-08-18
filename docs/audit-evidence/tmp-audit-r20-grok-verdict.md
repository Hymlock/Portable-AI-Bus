# r20 — first attack on committed HEAD c9c76b4a70bcab12f6b1b3679d8fe7e25b232714

Instrument: tmp-audit-r20-grok.cjs
Live hook: scripts/claim-guard-cli.js (committed bytes at ebd70ec; c9c76b4 is docs-only)
Live dist: dist/evidence.js + dist/mailbox.js

PASS 22 / FAIL 0 / NOTE 1

Item 2 remains CERTIFIED (debris ms vs live 10s timeout still cannot collapse).
Item 15 is NOT certified on this wake: after r20 returned, the working tree gained
uncommitted edits to scripts/claim-guard-cli.js and tests/audit-round2.test.js
(Claude realpath-ing the scratch root). I did not touch them. A new HEAD is incoming.

- [NOTE] item 15 / against: HEAD=c9c76b4a70bcab12f6b1b3679d8fe7e25b232714
- [PASS] item 15 / honest-green: code=0
- [PASS] item 15 / nocheck-true: code=1
- [PASS] item 15 / files-empty-plus-references/control: tsc -p succeeded on files:[] + references
- [PASS] item 15 / files-empty-plus-references: code=1
- [PASS] item 15 / nm-substring-types: claim-guard: 3 staged path(s), all covered by claude's claims
- [PASS] item 15 / scratch-sibling-types/control: tsc compiled the types leak
- [PASS] item 15 / scratch-sibling-types: claim-guard: 3 staged path(s), all covered by claude's claims
- [PASS] item 15 / scratch-sibling-typeRoots: claim-guard: 2 staged path(s), all covered by claude's claims
- [PASS] item 15 / nm-sibling-types: claim-guard: 3 staged path(s), all covered by claude's claims
- [PASS] item 15 / scratch-sibling-paths: claim-guard: 2 staged path(s), all covered by claude's claims
- [PASS] item 15 / broken-compile-refused: code=1
- [PASS] item 15 / pin-scratch-honest-green: code=0
- [PASS] item 2 / debris-empty-bytes: recovered in 5ms
- [PASS] item 2 / debris-unparseable: recovered in 4ms
- [PASS] item 2 / debris-missing-pid: recovered in 3ms
- [PASS] item 2 / debris-string-pid: recovered in 3ms
- [PASS] item 2 / debris-float-pid: recovered in 3ms
- [PASS] item 2 / debris-unsafe-int: recovered in 3ms
- [PASS] item 2 / debris-lock-is-directory: recovered in 2ms
- [PASS] item 2 / live-pid-not-stolen: treated as live owner, timed out in 10018ms
- [PASS] item 2 / operatorCloseRecovery-compacts: closed=true summary=3 live=1
- [PASS] item 2 / inherit-does-not-compact: summary=false live=3
