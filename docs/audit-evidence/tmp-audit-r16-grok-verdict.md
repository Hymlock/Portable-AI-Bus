# r16 / r16b / r16c — leftover hunt after r15, not a certification of HEAD

HEAD is still `373e176`. Claude still holds the four live repair paths
(`scripts/claim-guard-cli.js`, `src/evidence.ts`, `src/mailbox.ts`,
`tests/audit-round2.test.js`) plus other files from earlier rounds.
I did not edit `src/` or `tests/` or live `scripts/claim-guard-cli.js`.
I did not edit the untracked patch. Incoming mail: 0.

I did not re-run r7 / r15 against HEAD (that would be a heartbeat).
I did not resend the r5 brief or r6 apply notes.

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

New instruments: `tmp-audit-r16-grok.cjs`, `tmp-audit-r16b-grok.cjs`,
`tmp-audit-r16c-grok.cjs`. r16b exists because r16 item 2 called
`store.claim` (API is `store.record`). r16c exists because r16b's
`src-vendor-junction` FAIL was git following a junction and storing
`src/vendor/leak.ts` as a regular index blob.

### Item 15 against the r14/r15 patch

| attack | worktree tsc | patch |
|---|---|---|
| `noCheck: 1` / `noCheck: "true"` | TS5024; not red-capable | NOTE |
| `${configDir}/../hidden/**` include | compiles in worktree | **PASS** (scratch include found no inputs; fail-closed) |
| `paths` `@h/*` → `../hidden/*` | compiles; lists outside | **PASS** refused (walker paths) |
| `paths` `*` → `../hidden/*` | compiles; lists outside | **PASS** refused (walker paths) |
| `rootDirs` includes `../hidden` | compiles; lists outside | **PASS** refused (walker rootDirs) |
| `files` lists `../hidden/x.ts` | compiles; lists outside | **PASS** refused (walker files) |
| `noCheck` only in extended config | compiles a type error | **PASS** refused (noCheck via extends) |
| `@ts-nocheck` on the only source | compiles a type error | **PASS** refused |
| `disableReferencedProjectLoad` + relative import | TS6305; not red-capable | NOTE |
| `import type` from an absolute path | compiles; lists outside | **PASS** refused (walker) |
| `export *` from an absolute path (no `.ts` suffix) | compiles; lists outside | **PASS** refused (walker) |
| `compilerOptions.lib` as a path | TS6046; not red-capable | NOTE |
| `tsBuildInfoFile` outside | compiles | **PASS** refused (walker) |
| junction `src/vendor` followed by `git add` | compiles; index stores the file | NOTE (not a leak: bytes are in the commit) |
| git mode `120000` dir/file link onto outside | — | **PASS** refused (`staged symlink`) |
| `mklink /D` staged | — | **PASS** refused (`staged symlink`) |
| root `package.json` `"types"` outside | compiles; did not list outside | NOTE, not red-capable |
| `noCheck` only in a referenced project | `tsc -p` compile OK | NOTE (already classified with hole 4) |
| honest-green | compiles | **PASS** |

r16 item 15 after r16b/r16c corrections: **red-capable leftovers: 0 FAIL**.

### Item 2 against the r14 patched dist

| attack | r14 patch |
|---|---|
| `pid: 1.5` / `true` / `{}` / `-5` / `"1234"` | **PASS** recovered in 3–5ms |
| UTF-8 BOM + missing pid | **PASS** recovered in 3ms |
| JSON + trailing junk | **PASS** recovered in 3ms |
| UTF-16 BE lock bytes | **PASS** recovered in 3ms |

r16 item 2 after r16b: **8 PASS / 0 FAIL / 0 NOTE**.

## Open dependency

Unchanged. Claude holds the four live repair paths. Items 15 and 2 stay
unmet until those claims are released or the patch is applied on HEAD and
re-attacked with a new instrument.

Item 20 stays certified 9/9.
This is still not a certification of HEAD and not a self-certification.
