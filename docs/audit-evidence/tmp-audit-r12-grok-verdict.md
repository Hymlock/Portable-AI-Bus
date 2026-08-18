# r12 / r12b — leftover hunt on the r11 patch, plus hole 4's remaining red spelling

HEAD is still `373e176`. Claude still holds the four live repair paths.
I did not edit `src/` or `tests/` or live `scripts/claim-guard-cli.js`.
I did not edit the untracked patch. Incoming mail: 0.

I did not re-run r7 or r11 (those would be heartbeats).
I did not resend the r5 brief or r6 apply notes.

## What this wake measured

New instruments: `tmp-audit-r12-grok.cjs`, `tmp-audit-r12b-grok.cjs`.

### Hole 4 on HEAD is still red, but only as a solution root

Bare `files: []` is TS18002. Empty `include` / `exclude **/*` / default include with no `.ts` are TS18003. Those spellings are no longer a silent success on this tsc, so they do not keep hole 4 open by themselves.

The original hole-4 spelling still compiles and still fools HEAD:

| attack | tsc -p | tsc -b | HEAD hook | r11 patch |
|---|---|---|---|---|
| `{ files: [], references: [{ path: "./packages/lib" }] }` with a type error in the referenced project | succeeds (does not compile the reference) | TS2322 on the broken file | **FAIL** `compile OK` | **PASS** `tsc compiled no program source` |

That is hole 4 as stated: an empty *success* reported as a verified index. Not a new class.

### r12 leftover hunt against the r11-updated patch

| attack | worktree tsc | r11 patch |
|---|---|---|
| `typesVersions` remap to an outside `.d.ts` | compiles; lists the outside file | **PASS** refused (listFilesOnly) |
| `preserveSymlinks` + `node_modules/leak-src` junction onto worktree `src` | compiles | **PASS** refused |
| `resolveJsonModule` + absolute `.json` import | compiles; lists the outside file | **PASS** refused |
| `package.json` `"main"` to an outside `.d.ts` (no `"types"`) | compiles; lists the outside file | **PASS** refused |
| empty `include` / `exclude **/*` / include nomatch | TS18003 | NOTE (tsc itself fails) |
| `exports.types` under `bundler` | TS7016 | not red-capable |
| `#imports` under `bundler` | TS7016 | not red-capable |
| `compilerOptions.plugins` | tsc -p ignores plugins | not red-capable |
| `customConditions` | compiles; did not list the outside file (used in-package types) | not red-capable |
| honest-green | compiles | **PASS** |

r12: **12 PASS / 0 FAIL / 15 NOTE**. No leftover on the r11-updated patch among these classes.

r12b: **7 PASS / 1 FAIL / 2 NOTE**. The FAIL is HEAD hole 4, not the patch.

`default-no-ts` was an instrument error (staged `README.md` with no claim) — ignore those two PASSes as evidence about empty compile.

## HEAD still has the original holes

Read this wake, not last-wake memory:
- `scripts/claim-guard-cli.js:255` still skips bare `extends`
- `withinScratch` is still lexical
- no source-path walk
- no empty-compile refuse (solution-style `files:[]` + `references` still prints `compile OK`)
- `noCheck` is still NOTE plus exit 0
- `evidence.ts:489` still recovers only when `owner.pid` is defined and dead
- `mailbox.ts:977` `operatorCloseRecovery` still has no `consolidate`

## Open dependency

Unchanged. Claude holds `scripts/claim-guard-cli.js`, `src/evidence.ts`,
`src/mailbox.ts`, `tests/audit-round2.test.js`. Inbox 1891–1905 unread.
Items 15 and 2 stay unmet until those claims are released or the patch
is applied on HEAD and re-attacked with a new instrument.

Item 20 stays certified 9/9.
This is still not a certification of HEAD and not a self-certification.
