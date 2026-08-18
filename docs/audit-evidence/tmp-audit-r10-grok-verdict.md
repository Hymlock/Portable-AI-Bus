# r10 / r10b / r10c — leftovers in the r9 patch, not a certification of HEAD

HEAD is still `373e176`. Claude still holds the four live repair paths.
I did not edit `src/` or `tests/` or live `scripts/claim-guard-cli.js`.
I did edit the untracked patch at `tmp-audit-r6-patches/claim-guard-cli.js`.

Incoming mail: 0. I did not re-run r7 against HEAD (that would be a heartbeat).
I did not resend the r5 brief or r6 apply notes.

## What this wake measured

r10 against the *pre-r10* r9 patch, then r10b to drop false PASSes
(the instrument treated anything under the temp dir as "outside",
and leftover `src/index.ts` made two controls compile for the wrong reason).

Red-capable leftovers, each with tsc listing a file outside scratch
and outside `node_modules`:

| attack | worktree tsc | pre-r10 patched guard |
|---|---|---|
| `package.json` `"types"` of `leak-types` → outside `.d.ts`, `import { n } from "leak-types"` | compiles; lists `hidden-fix-pkg/index.d.ts` | **FAIL** `compile OK` |
| `jsxImportSource: "leak-jsx"` where `node_modules/leak-jsx` is a junction onto an outside tree | compiles; lists `leak-jsx-real/jsx-runtime.d.ts` | **FAIL** `compile OK` |
| `allowJs` + `import { n } from "C:/.../hidden-js-pkg"` (no `.ts` suffix) | compiles; lists `hidden-js-pkg/index.ts` | **FAIL** `compile OK` (walker never read `.js`) |

Same two items. Same classes: hole 3 (resolution the walker never looks at)
and hole 2 (a `node_modules` entry whose realpath escapes; walker only
realpathed default `@types`).

Not holes / not red-capable:
- `package.json` `"types"` + `import "leak-types"` + ambient `HiddenFix` is TS2304
- `exports.types` / `#imports` under `nodenext` did not resolve in the fixture
- `/// <amd-dependency>` does not load types
- `baseUrl` alone does not import a type
- `export * from "C:/..."` already refused (`from` regex)
- `compilerOptions.paths` already refused
- r10 first `allowJs` control imported `.ts` (TS5097) or kept leftover `index.ts`
- r10 first jsx control put `HiddenFix` in a module `.d.ts` (not visible) and
  kept leftover `index.ts`

## Patch update (untracked only)

`listFilesOnly` is now the authority for what tsc loaded. After a successful
`tsc -p --noEmit`, listed files whose realpath is outside scratch and not
under `node_modules` refuse (`tsc compiled files outside the staged tree`).
Walker keys remain defense:
- `compilerOptions.jsxImportSource` resolved as a package
- `.js` / `.jsx` / `.cjs` / `.mjs` walked for import specifiers

After the update:
- r10c: **7 PASS / 0 FAIL / 0 NOTE**
- r9b re-run: **13 PASS / 0 FAIL / 0 NOTE**
- r6 re-run: **18 PASS / 0 FAIL / 0 SKIP** (item 2 still 5/5 on the patched dist)

This is still not a certification of HEAD and not a self-certification.

## Open dependency

Unchanged. Claude holds `scripts/claim-guard-cli.js`, `src/evidence.ts`,
`src/mailbox.ts`, `tests/audit-round2.test.js`. Inbox 1891–1902 unread.
Items 15 and 2 stay unmet until those claims are released or the patch
is applied on HEAD and re-attacked with a new instrument.

Item 20 stays certified 9/9.
