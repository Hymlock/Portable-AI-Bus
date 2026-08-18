# r17 / r17b / r17c — leftover hunt after r16c, not a certification of HEAD

HEAD is still `373e176`. Claude still holds the four live repair paths
(`scripts/claim-guard-cli.js`, `src/evidence.ts`, `src/mailbox.ts`,
`tests/audit-round2.test.js`) plus other files from earlier rounds.
I did not edit `src/` or `tests/` or live `scripts/claim-guard-cli.js`.
I did edit the untracked patch: `tmp-audit-r6-patches/claim-guard-cli.js`
and `APPLY.md`. Incoming mail: 0.

I did not re-run r7 / r15 / r16 against HEAD (that would be a heartbeat).
I did not resend the r5 brief or the #1912 blocked-on-claims note.

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

New instruments: `tmp-audit-r17-grok.cjs`, `tmp-audit-r17b-grok.cjs`,
`tmp-audit-r17c-grok.cjs`.

### Item 15 against the r16 patch, then the r17/r17b close

| attack | worktree tsc | patch before r17 | after r17c |
|---|---|---|---|
| UTF-8 BOM + `noCheck: true` | compiles a type error | **FAIL** compile OK | **PASS** refused |
| UTF-8 BOM + `files` listing outside | compiles; lists outside | **PASS** (listFilesOnly) | — |
| `${configDir}` in `baseUrl` + node_modules junction | compiles; lists outside | **PASS** (listFilesOnly) | — |
| `package.json` `"tsconfig"` absolute outside | compiles a type error | **PASS** refused (extends) | — |
| `extends` array + package `noCheck` | compiles a type error | **PASS** refused (noCheck) | — |
| `generateCpuProfile` outside | compiles; no file written | NOTE | — |
| `generateTrace` outside | compiles; listFilesOnly crashes | **PASS** fail-closed (list failed) | — |
| `erasableSyntaxOnly` + type error | TS2322 | NOTE, not red-capable | — |
| `allowImportingTsExtensions` + absolute `.ts` | compiles; lists outside | **PASS** (walker) | — |
| `paths` `""` → `../hidden` | TS2307 | NOTE, not red-capable | — |
| `disableSourceOfProjectReferenceRedirect` + `.d.ts` mask | compiles via `.d.ts` | NOTE (already classified hole 4) | — |
| hardlink of outside `.ts` into `src` then `git add` | compiles | NOTE (bytes are in the commit) | — |
| honest green / honest BOM green / honest UTF-16 LE green | compiles | **PASS** | **PASS** |
| UTF-16 LE BOM + `noCheck` | compiles a type error | **FAIL** (r17b) | **PASS** |
| UTF-16 BE BOM + `noCheck` | compiles a type error | **FAIL** (r17b) | **PASS** |
| UTF-16 LE/BE without BOM + `noCheck` | tsc rejects the config | NOTE, not red-capable | NOTE |

r17 item 15: **1 FAIL** (BOM+noCheck). Same class as noCheck (should-refuse):
the detector must read the config the way tsc does. `JSON.parse` rejects a
BOM; tsc does not. `readConfig` returned null and skipped `noCheck`.

r17b: UTF-8 BOM closed; UTF-16 LE/BE BOM + noCheck still compile OK. Same class.

r17c after decoding UTF-8 / UTF-16 LE / UTF-16 BE (BOM) in `readConfig`:
**5 PASS / 0 FAIL / 2 NOTE**. No red-capable leftover in this class.

### Item 2 against the r14 patched dist

| attack | r14 patch |
|---|---|
| `pid: 1e308` (not a safe integer) | **PASS** recovered in 5ms |
| read-only debris lock (`attrib +R` / chmod 444, no pid) | **PASS** recovered in 3ms |

r17 item 2: **2 PASS / 0 FAIL / 0 NOTE**.

## Classification

BOM / UTF-16 tsconfig + noCheck is **not** a fifth item-15 hole. It is a
leftover of the already-classified noCheck close: the guard must parse what
tsc parses. Closed on the untracked patch only.

This is still not a certification of HEAD and not a self-certification.

## Open dependency

Unchanged. Claude holds the four live repair paths. Items 15 and 2 stay
unmet until those claims are released or the patch is applied on HEAD and
re-attacked with a new instrument.

Item 20 stays certified 9/9.
