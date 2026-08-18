# r18 leftover hunt after r17c — not a certification of HEAD

HEAD is still `373e176`. Claude still holds the four live repair paths
(`scripts/claim-guard-cli.js`, `src/evidence.ts`, `src/mailbox.ts`,
`tests/audit-round2.test.js`) plus other files from earlier rounds.
I did not edit `src/` or `tests/` or live `scripts/claim-guard-cli.js`.
Incoming mail: 0.

I did not re-run r7 / r15 / r16 / r17 (that would be a heartbeat).
I did not resend the r5 brief or copy #1912.

## What this wake measured

This wake re-read HEAD, not last-wake memory.

HEAD still has the original holes:
- `scripts/claim-guard-cli.js:255` still skips bare `extends`
- `withinScratch` is still lexical `path.relative`
- walker never reads source-level paths
- no empty-compile refuse (solution-style `files:[]` + `references` still prints `compile OK`)
- `noCheck` is still NOTE plus exit 0 (classified should-refuse)
- `evidence.ts:489` still recovers only when `owner.pid` is defined and dead
- `mailbox.ts:977` `operatorCloseRecovery` still has no `consolidate`

New instrument: `tmp-audit-r18-grok.cjs`. New classes only.

### Item 15 against the r17c patch

| attack | worktree tsc | patch |
|---|---|---|
| type-position `import("C:/hidden/mod")` | compiles; lists outside | **PASS** refused |
| JSDoc `@type {import("C:/hidden/mod").T}` + allowJs/checkJs | compiles; lists outside | **PASS** refused |
| `file://` URL import | tsc failed | NOTE, not red-capable |
| UNC `//localhost/C$/...` import | compiles; lists outside | **PASS** refused |
| `/// <amd-dependency path>` | compiles; did not list outside | NOTE (not a see-leak) |
| `/// <reference path="file://...">` | tsc failed | NOTE, not red-capable |
| `compilerOptions.out` outside (deprecated) | tsc failed | NOTE, not red-capable |
| `compilerOptions.outFile` outside | tsc failed | NOTE, not red-capable |
| `mapRoot` + `sourceRoot` outside | compiles | **PASS** refused (walker) |
| `include` with `file://` URL | tsc failed | NOTE, not red-capable |
| honest green | compiles | **PASS** |

r18 item 15: **5 PASS / 0 FAIL / 5 NOTE**. No red-capable leftover in this class.

### Item 2 against the r14 patched dist

| attack | r14 patch |
|---|---|
| UTF-8 BOM + live pid | **PASS** waited 411ms; lock kept |
| UTF-8 BOM + missing pid | **PASS** recovered in 5ms |
| `pid: 2147483647` (dead) | **PASS** recovered in 5ms |

r18 item 2: **3 PASS / 0 FAIL / 0 NOTE**.
BOM + live pid is not stolen. Unparseable-as-debris does not eat a
BOM-prefixed live owner on this patch.

## Classification

None of these is a new hole. Type-position `import()` and JSDoc
`import()` are hole-3 spellings; listFilesOnly already decides them.
UNC is a path specifier the walker may miss; listFilesOnly refused.
`file://` is not honoured by this tsc. Write-side `out` / `outFile`
failed in the worktree (not red-capable here); `mapRoot`/`sourceRoot`
already walked.

This is still not a certification of HEAD and not a self-certification.

## Stopping rule for leftover hunts

r10 through r18 against the untracked patch: **0 new red-capable
leftover that is not already classified**. Another leftover hunt
without a new HEAD is a heartbeat. I will not run r19 until the four
claims are released or a new HEAD exists.

## Open dependency

Unchanged. Claude holds the four live repair paths. Items 15 and 2 stay
unmet until those claims are released or the patch is applied on HEAD
and re-attacked with a new instrument. Item 20 stays certified 9/9.

Gates unmet. `done` is false. An acknowledgement is not completion.
