# r21 — attack on e28c7b5 hook bytes (HEAD 58d507fbd4e898aba86c0da35b2286c168141700)

Instrument: tmp-audit-r21-grok.cjs
Live hook: scripts/claim-guard-cli.js
Hook blob: ea74c7b0f556023ee5caa41ab7cb8c29a875d71f (matches e28c7b5: true)
Live dist: dist/evidence.js + dist/mailbox.js (item 2 spot-check only)

PASS 20 / FAIL 0 / NOTE 3

ITEM 15 CERTIFIED at e28c7b5 (hook bytes unchanged on later docs-only HEAD).
Item 2 remains certified at 1592382; this wake only spot-checked live dist.

- [NOTE] item 15 / against: HEAD=58d507fbd4e898aba86c0da35b2286c168141700
- [PASS] item 15 / hook-identity: HEAD hook blob matches e28c7b5
- [PASS] item 15 / tree-clean: scripts/claim-guard-cli.js src/evidence.ts src/mailbox.ts tests/audit-round2.test.js clean
- [PASS] item 15 / linked-tmpdir-honest-green: code=0
- [PASS] item 15 / linked-tmpdir-unfixed-red: unfixed hook must refuse an honest commit when TMPDIR is a link; code=1
- [PASS] item 15 / linked-tmpdir-outside-types: claim-guard: 3 staged path(s), all covered by claude's claims
- [PASS] item 15 / linked-tmpdir-nocheck: code=1
- [PASS] item 15 / honest-green: code=0
- [PASS] item 15 / nocheck-true: code=1
- [PASS] item 15 / files-empty-plus-references/control: tsc -p succeeded on files:[] + references
- [PASS] item 15 / files-empty-plus-references: code=1
- [PASS] item 15 / nm-substring-types: claim-guard: 3 staged path(s), all covered by claude's claims
- [PASS] item 15 / broken-compile-refused: code=1
- [PASS] item 15 / escape-hatch-loud: code=0
- [NOTE] item 15 / rootDir-junction-outside: tsc did not list the outside path; not red-capable
- [PASS] item 15 / typeroots-junction-outside: claim-guard: 2 staged path(s), all covered by claude's claims
- [NOTE] item 15 / extends-symlink-outside: git stored bytes not a symlink; not red-capable
- [PASS] item 15 / realpath-scratch-sibling-types: claim-guard: 3 staged path(s), all covered by claude's claims
- [PASS] item 2 / debris-empty-bytes: recovered in 5ms
- [PASS] item 2 / debris-unparseable: recovered in 3ms
- [PASS] item 2 / debris-missing-pid: recovered in 4ms
- [PASS] item 2 / live-pid-not-stolen: treated as live owner, timed out in 10010ms
- [PASS] item 2 / operatorCloseRecovery-compacts: closed=true summary=3 live=1
