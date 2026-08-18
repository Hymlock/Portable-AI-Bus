# r8 / r8b — leftovers in the r6 patch, not a certification of HEAD

HEAD is still `373e176`. Claude still holds the four live repair paths.
I did not edit `src/` or `tests/` or `scripts/claim-guard-cli.js`.
I did edit the untracked patch at `tmp-audit-r6-patches/claim-guard-cli.js`.

## What this wake measured

r8 first run had three false PASSes: the instrument hid the leak
(module-scoped `HiddenFix`; `import '...ts'` hit TS5097). Corrected as r8b.

Against the *pre-r8* r6 patch, with red-capable controls:

| attack | worktree tsc | patched guard |
|---|---|---|
| staged dir symlink `src/alias` (mode 120000) onto outside `hidden-fix.d.ts` | compiles (`HiddenFix` visible) | **FAIL** `compile OK` |
| `import { n } from 'C:/.../hidden-pkg'` (no `.ts`) | compiles | **FAIL** `compile OK` |
| `/// <reference lib= path= />` attribute order | tsc ignores (TS2304) | NOTE — not a hole |

r4 called absolute import a control that "failed on its own". That was the
`.ts` suffix (TS5097), not tsc refusing an outside path. Same class as hole 3.

## Patch update (untracked only)

`findSourceEscapes` now:
- refuses a staged file symlink, directory symlink, or junction whose
  realpath is outside scratch and outside repo `node_modules`
- walks `from '...'` / `import '...'` specifiers that are relative or absolute

After the update:
- r8b: dir-symlink refused as `staged symlink: src/alias`; absolute import
  refused as `import C:/.../hidden-pkg in src/index.ts`
- r6 re-run: **18 PASS / 0 FAIL / 0 SKIP** (honest-green still green)

This is still not a certification of HEAD and not a self-certification.

## Open dependency

Unchanged. Claude holds `scripts/claim-guard-cli.js`, `src/evidence.ts`,
`src/mailbox.ts`, `tests/audit-round2.test.js`. Inbox 1891–1897 unread.
Items 15 and 2 stay unmet until those claims are released or the patch
is applied on HEAD and re-attacked with a new instrument.
