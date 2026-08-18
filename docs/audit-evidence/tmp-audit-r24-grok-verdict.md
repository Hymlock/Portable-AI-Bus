# r24 — first attack on bb5478b hook bytes (walker scoped to listFilesOnly)

Instrument: tmp-audit-r24-grok.cjs (run from C:\Users\hymlo\Downloads\Projects\ai-bus\_grok_r24_item15.cjs)
Live hook: scripts/claim-guard-cli.js
HEAD: 322df62c468486d8558adcfe39e26fc64ff5177e
Hook blob: 09302e9326b80f556189a5fa6757edc8bf5e0a26 (matches bb5478b: true; matches e28c7b5: false)
On-disk git sha1: 09302e9326b80f556189a5fa6757edc8bf5e0a26
Not the author suite. Not r21/r22/r23 re-run.

PASS 28 / FAIL 0 / NOTE 2

ITEM 15: no red-capable leftover found against bb5478b bytes in this instrument. Certification is this wake's call, not a copy of the r21 table row.

Standing question: can a commit that does not compile still land?
No via tsc -p --noEmit. Broken staged source is refused (does not compile, exit 1). The hatch is BUS_ALLOW_BROKEN_BUILD=1 and it names itself. Hatch unused on bb5478b.

- [NOTE] item 15 / against: HEAD=322df62c468486d8558adcfe39e26fc64ff5177e
- [PASS] item 15 / hook-identity: HEAD hook blob matches bb5478b (09302e9326b80f556189a5fa6757edc8bf5e0a26); differs from e28c7b5 (ea74c7b0f556023ee5caa41ab7cb8c29a875d71f)
- [PASS] item 15 / tree-clean: scripts/claim-guard-cli.js src/evidence.ts src/mailbox.ts tests/audit-round2.test.js clean
- [PASS] item 15 / split-evidence-cjs-e28-red: e28 whole-tree walker must refuse comment text tsc never loads; code=1
- [PASS] item 15 / split-evidence-cjs-live-green: docs evidence must be committable on bb5478b; code=0
- [PASS] item 15 / split-src-cjs-allowJs-off: unloaded src/*.cjs must not refuse; listed=false; code=0
- [PASS] item 15 / split-excluded-ts-not-loaded: excluded file tsc did not load must not refuse; code=0
- [PASS] item 15 / split-program-absolute-real: claim-guard: 3 staged path(s), all covered by claude's claims
- [PASS] item 15 / split-import-pulled-docs: claim-guard: 4 staged path(s), all covered by claude's claims
- [PASS] item 15 / split-rootDirs-unimported: rootDirs is not membership; code=0
- [PASS] item 15 / split-rootDirs-imported: claim-guard: 4 staged path(s), all covered by claude's claims
- [PASS] item 15 / split-jsdoc-import-types: claim-guard: 4 staged path(s), all covered by claude's claims
- [PASS] item 15 / split-listfiles-vs-listfilesonly: noEmit --listFiles and --listFilesOnly named the same 9 files
- [NOTE] item 15 / split-plugins-outside: tsc.ok=true listedPlugin=false code=0
- [PASS] item 15 / r8b-absolute-import: claim-guard: 3 staged path(s), all covered by claude's claims
- [PASS] item 15 / r8b-staged-dir-symlink: code=1
- [PASS] item 15 / r9-implicit-atypes-junction: claim-guard: 3 staged path(s), all covered by claude's claims
- [PASS] item 15 / r9-compilerOptions-types-junction: code=1
- [PASS] item 15 / r9-triple-slash-types: tsc.ok=true code=1
- [PASS] item 15 / r9-bare-specifier-junction: claim-guard: 3 staged path(s), all covered by claude's claims
- [PASS] item 15 / r10-package-json-types: claim-guard: 3 staged path(s), all covered by claude's claims
- [PASS] item 15 / r10-allowJs-absolute: claim-guard: 3 staged path(s), all covered by claude's claims
- [PASS] item 15 / honest-green: code=0
- [PASS] item 15 / broken-compile-refused: code=1
- [PASS] item 15 / escape-hatch-loud: code=0
- [PASS] item 15 / hatch-unused-on-fix: fix(item 15): source-text walker inspects only files tsc loaded
- [PASS] item 15 / nocheck-true: code=1
- [PASS] item 15 / files-empty-plus-references/control: tsc -p succeeded on files:[] + references
- [PASS] item 15 / files-empty-plus-references: code=1
- [PASS] item 15 / referenced-project-type-error: tsc -p ok=false
