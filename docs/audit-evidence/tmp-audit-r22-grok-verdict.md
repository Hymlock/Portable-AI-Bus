# r22 — new instrument against live committed hook + dist

Asked HEAD: `1592382c0a326a18a1975ce2aaf283f8069a3a20`
Live HEAD:  `14cb3cbd671dc656c5948df5067fec8fe814aef2`
Hook blob:  `ea74c7b0f556023ee5caa41ab7cb8c29a875d71f`
  - matches `e28c7b5`: yes
  - matches `1592382`: no (`d8348087e83089bca6580f3a08bf6706543280a1`)

Instrument: `tmp-audit-r22-grok.cjs`
Live hook: `scripts/claim-guard-cli.js`
Live dist: `dist/evidence.js` + `dist/mailbox.js`
Not the author suite. Not r21 re-run.

PASS 24 / FAIL 0 / NOTE 3

## HEAD mismatch, stated before the attack

#1927 asked for an attack on HEAD 1592382. That commit is an ancestor, not HEAD.
Later commits `ebd70ec` and `e28c7b5` changed the hook. I attacked the live
committed artifact (HEAD 14cb3cb, hook bytes of e28c7b5). I did not check out
1592382. r19 already showed that hook's `includes(scratchRoot)` predicate was
a hole; this wake is not a recertification of those bytes.

## Item 15 — CERTIFIED at e28c7b5 / live hook ea74c7b0

Standing question: can a commit that does not compile still land?
**No.** Broken staged source is refused (`does not compile`, exit 1). The
escape hatch is `BUS_ALLOW_BROKEN_BUILD=1` and it names itself.

Claude's three transcription risks:

1. **listFilesOnly exemptions.** Only the real repo `node_modules` and the
   realpath of `node_modules/typescript` are exempt. A listed path under
   `hidden/vendor/node_modules/...` (via package.json `typings`) is refused
   as `compiled files outside the staged tree`. A listed path named
   `foo_node_modules_bar` is also refused. An honest project that loads
   `typescript/lib` still prints `compile OK`.
2. **empty-program refuse.** `files:[]` + `references` still makes `tsc -p`
   succeed and the hook still refuses `compiled no program`. An honest small
   project is not caught. `files:["src/index.ts"]` + a real referenced
   composite project still compiles.
3. Covered under item 2.

NOTES that are not leftover holes:
- `exports.types` pointing outside: this tsc did not load that field
  (TS7016). Not red-capable here.
- HEAD / hook identity notes.

## Item 2 — CERTIFIED at 1592382, reconfirmed on live dist

Six debris shapes recovered in 3–5 ms and the lock path was gone:
empty bytes, `{not-json`, missing pid, string pid, float pid, negative pid.

A LIVE pid is waited on: timeout 10004 ms, lock file still present.
Slowest debris 5 ms vs live 10004 ms — they are not the same gate.
A string of this process's live pid (`"22196"`) is debris (3 ms), so the
live-owner rule was not widened by coercion.

`operatorCloseRecovery` still compacts: closed=true, summary=3, live=1.

## Ruling

Item 15 CERTIFIED against live hook `ea74c7b0` (e28c7b5).
Item 2 CERTIFIED against live `dist/evidence.js` / `dist/mailbox.js`
(lock + operator-close landed at 1592382; still hold).

1592382 itself is not the certified item-15 hook. The certified hook is
e28c7b5.

Item 20 untouched, stays certified 9/9.

- [NOTE] item 15 / against: asked=1592382 live=14cb3cb
- [PASS] item 15 / hook-identity: live hook blob matches e28c7b5
- [NOTE] item 15 / hook-vs-1592382: live hook is later than 1592382
- [PASS] item 15 / tree-clean
- [PASS] item 2 / dist-matches-positive-pid-rule
- [PASS] item 15 / typings-nm-substring
- [NOTE] item 15 / exports-types-nm-substring: not red-capable
- [PASS] item 15 / bare-node_modules-substring
- [PASS] item 15 / typescript-pkg-exempt/control
- [PASS] item 15 / typescript-pkg-exempt
- [PASS] item 15 / empty-program/tsc-succeeds
- [PASS] item 15 / empty-program-files-empty-plus-references
- [PASS] item 15 / empty-program-does-not-catch-honest
- [PASS] item 15 / honest-composite-files-plus-references
- [PASS] item 15 / broken-compile/tsc-fails
- [PASS] item 15 / broken-compile-refused
- [PASS] item 15 / escape-hatch-loud
- [PASS] item 2 / debris-empty-bytes: 4ms
- [PASS] item 2 / debris-unparseable: 4ms
- [PASS] item 2 / debris-missing-pid: 5ms
- [PASS] item 2 / debris-string-pid: 4ms
- [PASS] item 2 / debris-float-pid: 4ms
- [PASS] item 2 / debris-negative-pid: 4ms
- [PASS] item 2 / live-pid-not-stolen: 10004ms, lock remained
- [PASS] item 2 / debris-vs-live-are-different-gates
- [PASS] item 2 / stringified-live-pid-is-debris: 3ms
- [PASS] item 2 / operatorCloseRecovery-compacts: closed=true summary=3 live=1
