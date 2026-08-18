# r23 — independent attack on e28c7b5 hook bytes (live HEAD 14cb3cbd671dc656c5948df5067fec8fe814aef2)

Instrument: tmp-audit-r23-grok.cjs
Live hook: scripts/claim-guard-cli.js
Hook blob: ea74c7b0f556023ee5caa41ab7cb8c29a875d71f (matches e28c7b5: true)
On-disk git sha1: ea74c7b0f556023ee5caa41ab7cb8c29a875d71f
Not the author suite. Not r21/r22 re-run.

PASS 15 / FAIL 0 / NOTE 1

Standing question: can a commit that does not compile still land?
No. Broken staged source is refused (does not compile, exit 1).

ITEM 15 CERTIFIED at e28c7b5 (hook bytes unchanged on later docs-only HEAD).

- [NOTE] item 15 / against: asked=e28c7b5 liveHEAD=14cb3cbd671dc656c5948df5067fec8fe814aef2
- [PASS] item 15 / hook-identity: HEAD hook blob and on-disk bytes match e28c7b5
- [PASS] item 15 / tree-clean: scripts/claim-guard-cli.js tests/audit-round2.test.js clean
- [PASS] item 15 / linked-tmpdir-honest-green: code=0
- [PASS] item 15 / linked-tmpdir-unfixed-red: unfixed hook must refuse an honest commit when TMPDIR is a link; code=1
- [PASS] item 15 / broken-compile-refused: code=1
- [PASS] item 15 / broken-compile-under-linked-tmpdir: code=1
- [PASS] item 15 / escape-hatch-loud: code=0
- [PASS] item 15 / honest-green: code=0
- [PASS] item 15 / linked-tmpdir-nocheck: code=1
- [PASS] item 15 / files-empty-plus-references/control: tsc -p succeeded on files:[] + references
- [PASS] item 15 / files-empty-plus-references: code=1
- [PASS] item 15 / nm-substring-types: claim-guard: 3 staged path(s), all covered by claude's claims
- [PASS] item 15 / realpath-scratch-sibling-types: claim-guard: 3 staged path(s), all covered by claude's claims
- [PASS] item 15 / realpath-scratch-prefix-types: claim-guard: 3 staged path(s), all covered by claude's claims
- [PASS] item 15 / typeroots-junction-outside: claim-guard: 2 staged path(s), all covered by claude's claims
