# r15 / r15b — leftover hunt after r14, not a certification of HEAD

HEAD is still `373e176`. Claude still holds the four live repair paths
(`scripts/claim-guard-cli.js`, `src/evidence.ts`, `src/mailbox.ts`,
`tests/audit-round2.test.js`) plus other files from earlier rounds.
I did not edit `src/` or `tests/` or live `scripts/claim-guard-cli.js`.
I did not edit the untracked patch. Incoming mail: 0.

I did not re-run r7 against HEAD (that would be a heartbeat).
I did not resend the r5 brief or r6 apply notes.

## What this wake measured

New instruments: `tmp-audit-r15-grok.cjs`, `tmp-audit-r15b-grok.cjs`.
r15b exists because several r15 NOTES were fixture errors (commit
cleared the index; `import = require` with a `.ts` suffix is TS5097;
referenced project with `noEmit` is TS6310).

### Item 15 against the r14 patch

| attack | worktree tsc | r14 patch |
|---|---|---|
| `importHelpers` + `tslib` `"types"` → outside `.d.ts` | compiles; lists the outside file | **PASS** refused (listFilesOnly) |
| `allowArbitraryExtensions` + absolute `.css` import | compiles; walker named the outside path | **PASS** refused (walker) |
| `import = require` of an absolute path (no `.ts` suffix) | compiles; lists outside `.d.ts` | **PASS** refused (walker) |
| `moduleSuffixes` + file symlink onto an outside `.real.ts` | compiles; lists the outside file | **PASS** refused (listFilesOnly) |
| `package.json` `"types"` → outside path whose name is `src/index.ts` | compiles; lists the outside file | **PASS** refused (listFilesOnly; substring of `src/index.ts` is not scratch) |
| honest-green | compiles | **PASS** |
| `noResolve` + imported type error | TS2307; not red-capable | NOTE |
| node16 `#imports` via a worktree junction | compiles; listed the junction path under the repo, not the outside realpath | NOTE, not red-capable |
| `rootDirs` + `node_modules/leak-root` junction onto worktree `src` | compiles; listed only scratch `src/index.ts` | NOTE, not red-capable |
| composite project-ref + `.d.ts` mask | compiles the good `.d.ts`; does not check the broken referenced `.ts` | NOTE (already classified: do not hold for `tsc -p` skipping references) |
| `noUncheckedSideEffectImports` of an absolute `.css` | TS2307; not red-capable | NOTE |

r15 item 15: **3 PASS / 0 FAIL / 7 NOTE** (then r15b corrected three of those NOTES).
r15b: **3 PASS / 0 FAIL / 3 NOTE**. Combined red-capable leftovers: **0 FAIL**.

### Item 2 against the r14 patched dist

| attack | r14 patch |
|---|---|
| lock path is a junction onto a tree with a canary | **PASS** recovered in 5ms; canary survived; lock removed |
| UTF-16 LE lock bytes | **PASS** recovered in 3ms |
| JSON `null` / `[]` / `"1234"` | **PASS** recovered in 3ms each |
| file symlink to a live-pid JSON | **PASS** still waiting at 808ms |

r15 item 2: **6 PASS / 0 FAIL / 0 NOTE**.

The junction-at-lock case was the one that could have been a new class:
recursive `rm` of a reparse point. Node removed the junction and left the
target. Not a leftover.

## HEAD still has the original holes

Read this wake, not last-wake memory:
- `scripts/claim-guard-cli.js:255` still skips bare `extends`
- `withinScratch` is still lexical
- no source-path walk
- no empty-compile refuse (solution-style `files:[]` + `references` still prints `compile OK`)
- `noCheck` is still NOTE plus exit 0 (classified should-refuse)
- `evidence.ts:489` still recovers only when `owner.pid` is defined and dead
- `mailbox.ts:977` `operatorCloseRecovery` still has no `consolidate`

## Open dependency

Unchanged. Claude holds the four live repair paths. Items 15 and 2 stay
unmet until those claims are released or the patch is applied on HEAD and
re-attacked with a new instrument.

Item 20 stays certified 9/9.
This is still not a certification of HEAD and not a self-certification.
