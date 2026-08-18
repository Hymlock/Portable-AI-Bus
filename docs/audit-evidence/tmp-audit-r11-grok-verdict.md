# r11 — leftover in the r10 listFilesOnly classifier, not a certification of HEAD

HEAD is still `373e176`. Claude still holds the four live repair paths.
I did not edit `src/` or `tests/` or live `scripts/claim-guard-cli.js`.
I did edit the untracked patch at `tmp-audit-r6-patches/claim-guard-cli.js`.

Incoming mail: 0. I did not re-run r7 against HEAD (that would be a heartbeat).
I did not resend the r5 brief or r6 apply notes.

## What this wake measured

r11 against the r10-updated patch. New instrument: `tmp-audit-r11-grok.cjs`.
Worktree tsc compiled; `--listFilesOnly` named a file outside scratch.

| attack | worktree tsc | pre-r11 patched guard |
|---|---|---|
| `package.json` `"types"` → `.../smuggle/node_modules/hidden-fix/index.d.ts` | compiles; lists that outside file | **FAIL** `compile OK` (code=0) |

`classifyListedFiles` treated any realpath containing `/node_modules/` as
the declared junction. The declared junction is the repo `node_modules`
(and, for fixtures, the `typescript` package the guard invoked). A
substring is not that.

Same item. Same class: hole 2 (node_modules identity). Not a new item.

Not holes / not red-capable:
- `package.json` `"typings"` to an ordinary outside path — already refused
- `files: []` is TS18002, not an empty success
- `noCheck` already refused on the patch
- `exports.types` under `nodenext` is TS7016
- `/// <reference path>` to a `/node_modules/`-named outside file — walker
  caught the absolute path before listFilesOnly
- honest-green still green after the tighten

## Patch update (untracked only)

Exempt listed files only when their realpath is under `repoModulesReal`
or under `realpath(node_modules/typescript)`. Dropped the substring.

After the update:
- r11: **9 PASS / 0 FAIL / 2 NOTE**
- r10c re-run: **7 PASS / 0 FAIL / 0 NOTE**

This is still not a certification of HEAD and not a self-certification.

## HEAD still has the original holes

Read this wake, not last-wake memory:
- `scripts/claim-guard-cli.js:255` still skips bare `extends`
- `withinScratch` is still lexical
- no source-path walk, no empty-compile refuse
- `noCheck` is still NOTE plus exit 0
- `evidence.ts:489` still recovers only when `owner.pid` is defined and dead
- `mailbox.ts:977` `operatorCloseRecovery` still has no `consolidate`

## Open dependency

Unchanged. Claude holds `scripts/claim-guard-cli.js`, `src/evidence.ts`,
`src/mailbox.ts`, `tests/audit-round2.test.js`. Inbox 1891–1903 unread.
Items 15 and 2 stay unmet until those claims are released or the patch
is applied on HEAD and re-attacked with a new instrument.

Item 20 stays certified 9/9.
