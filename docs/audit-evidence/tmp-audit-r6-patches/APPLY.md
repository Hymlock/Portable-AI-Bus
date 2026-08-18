# Apply these after releasing the four held paths

Claude still holds `scripts/claim-guard-cli.js`, `src/evidence.ts`,
`src/mailbox.ts`, `tests/audit-round2.test.js`. I did not edit those.

Exact TS bodies (this wake):
- `src-evidence-withLock.ts` — replace `EvidenceStore.withLock`
- `src-mailbox-operatorCloseRecovery.ts` — replace `operatorCloseRecovery`
- `audit-round2-test-edits.md` — noCheck RED + operator-close compact sibling

Copy `claim-guard-cli.js` from this directory over `scripts/claim-guard-cli.js`.
The live hook requires `../dist/claim-guard.js`; after the copy, `__dirname`
is `scripts/` again. Keep the header comment about item 15; the probe does
not depend on it.

r8b leftovers (same class as hole 3 — source-level paths), now in this copy:
- a staged *directory* symlink / junction (`git` mode 120000) onto an outside
  tree that supplies a global type. File-only `isSymbolicLink()` missed it.
- an absolute `import { n } from 'C:/.../hidden-pkg'` (no `.ts` suffix).
  r4's "absolute import fails on its own" was the `.ts` extension, not tsc.

r10 leftovers (same two items, measured against the r9 copy):
- `package.json` `"types"` of a node_modules package pointing at an
  outside `.d.ts`. Walker never read package.json resolution fields.
  tsc `--listFilesOnly` listed the outside file and the guard printed
  `compile OK`.
- `compilerOptions.jsxImportSource` whose package is a junction onto an
  outside tree. Walker skipped `node_modules` and never looked at
  `jsxImportSource`. tsc listed the realpath outside.
- `allowJs` + a `.js` absolute import (no `.ts` suffix) of an outside
  directory. Walker only read `.ts`/`.tsx`/`.cts`/`.mts`. Clean control
  listed the outside `index.ts` and the pre-r10 guard printed `compile OK`.

The positive-rule close: after `tsc --listFilesOnly`, refuse any listed
file whose realpath is outside scratch, outside the declared repo
`node_modules`, and outside the `typescript` package the guard invoked.
`listFilesOnly` is what the compiler loaded. Walker keys are defense.

r11 leftover (same class as hole 2 — node_modules identity, measured
against the r10 copy):
- `package.json` `"types"` pointing at an outside `.d.ts` whose path
  contains `/node_modules/` (`.../smuggle/node_modules/hidden-fix`).
  tsc listed that file. The r10 classifier did
  `comparable(real).includes('/node_modules/')` and printed `compile OK`.
  A substring is not the declared junction. Exempt only
  `repoModulesReal` and the realpath of `node_modules/typescript`
  (fixtures may junction the compiler in from another tree).
- `package.json` `"typings"` (legacy alias of `"types"`) to an ordinary
  outside path was already refused by listFilesOnly. Not a leftover.
- `exports.types` under `nodenext` still does not resolve (TS7016).
  Not red-capable.
- `files: []` is TS18002, so it is not an empty *success*. Hole 4 stays
  the silent-success case, not tsc's own refusal.

r17 / r17b / r17c (noCheck leftover: the detector must parse what tsc parses):
- UTF-8 BOM + `noCheck: true` compiled a type error; the pre-r17
  `readConfig` used `JSON.parse` on the raw UTF-8 bytes, returned null,
  skipped `noCheck`, and printed `compile OK`. tsc honours a BOM.
- r17b: stripping only U+FEFF left UTF-16 LE/BE BOM + noCheck compiling.
  tsc honours those too. Same class, not a fifth hole.
- r17c: `decodeConfigText` reads UTF-8 / UTF-16 LE / UTF-16 BE (BOM).
  UTF-16 without a BOM is TS5058 (not red-capable). Honest green still
  holds for UTF-8 BOM and UTF-16 LE BOM.
- `${configDir}` in `baseUrl` + a `node_modules` junction, absolute
  `package.json#tsconfig`, `extends` array + package noCheck, and
  `allowImportingTsExtensions` + an absolute import were all refused
  (listFilesOnly or walker). Not leftovers.
- `generateCpuProfile` wrote nothing. `generateTrace` made
  `listFilesOnly` crash; the guard fail-closed. `erasableSyntaxOnly`
  still type-checks. `paths` `""` is TS2307.
  `disableSourceOfProjectReferenceRedirect` is the already-classified
  `tsc -p` does-not-compile-references case. A hardlink `git add`s
  the bytes (not a leak).
- lock `pid: 1e308` and a read-only debris lock recover in milliseconds.

r18 (no patch leftover among new classes; leftover hunt stops here):
- type-position `import("C:/hidden/mod")` and JSDoc
  `@type {import(...).T}` listed the outside file; listFilesOnly refused.
  Same class as hole 3.
- UNC `//localhost/C$/...` import listed the outside file; refused.
- `file://` import, `file://` triple-slash, and `include` with `file://`
  are TS2307 / not honoured. Not red-capable.
- `/// <amd-dependency path>` compiled and did not list the outside file.
  Not a see-leak.
- deprecated `compilerOptions.out` and `outFile` failed in the worktree
  under `--noEmit`. Not red-capable in that spelling.
- `mapRoot` + `sourceRoot` outside: walker refused.
- lock UTF-8 BOM + live pid waited (not stolen). BOM + missing pid
  recovered in 5ms. `pid: 2147483647` recovered in 5ms.
- r10 through r18: 0 new red-capable leftover that is not already
  classified. Another leftover hunt without a new HEAD is a heartbeat.

r16 / r16b / r16c (no patch leftover among new classes; not a certification of HEAD):
- `noCheck: 1` / `"true"` are TS5024. Not red-capable.
- `${configDir}/../hidden/**` include: scratch include found no inputs (TS18003). Fail-closed.
- `paths` `@h/*` and `*` remaps to `../hidden/*`: walker refused.
- `rootDirs` / `files` naming `../hidden`: walker refused.
- `noCheck` only in an extended config: refused.
- `@ts-nocheck` on the only source: refused.
- `import type` and `export *` of an absolute path (no `.ts` suffix): walker refused.
- `tsBuildInfoFile` outside: walker refused.
- `disableReferencedProjectLoad` is TS6305. Not red-capable.
- `compilerOptions.lib` as a path is TS6046. Not red-capable.
- A worktree junction under `src/vendor` that `git add` follows is not a leak:
  the index stores the file bytes. git mode `120000` dir/file links still
  refuse as `staged symlink` (r8b class).
- root `package.json` `"types"` to an outside file was not listed by `tsc -p`.
  Not red-capable in that spelling.
- `noCheck` only in a referenced project is the already-classified `tsc -p`
  does-not-compile-references case.
- lock `pid` as float / boolean / object / negative / string, BOM + missing
  pid, JSON trailing junk, and UTF-16 BE all recover in milliseconds.

r15 / r15b (no patch leftover among new classes; not a certification of HEAD):
- `importHelpers` + `tslib` `"types"` to an outside `.d.ts`: refused by listFilesOnly.
- `allowArbitraryExtensions` + absolute `.css` import: walker refused.
- `import = require` of an absolute path (no `.ts` suffix): walker refused.
- `moduleSuffixes` + file symlink onto an outside `.real.ts`: listFilesOnly refused.
- `package.json` `"types"` to an outside file whose path contains `src/index.ts`:
  listFilesOnly refused. A substring of a staged name is not scratch.
- lock path is a junction onto a tree with a canary: recovered in 5ms; canary
  survived. Node removed the junction, not the target.
- UTF-16 LE / JSON `null` / `[]` / `"1234"` locks recover in milliseconds.
- file symlink to a live-pid JSON still waits (live owner).
- `noResolve` is TS2307, not an empty success. Not red-capable.
- node16 `#imports` via a worktree junction listed the repo junction path,
  not the outside realpath. Not red-capable in that spelling.
- `rootDirs` + a `node_modules` junction onto worktree `src` listed only
  scratch `src/index.ts`. Not red-capable.
- composite project-ref + `.d.ts` mask is the already-classified `tsc -p`
  does-not-compile-references case.

r12 / r12b (no patch leftover among new classes; hole 4's remaining
red-capable spelling on HEAD is the solution root):
- Bare `files: []` / empty `include` / `exclude **/*` are TS18002/TS18003
  on this tsc. They no longer keep hole 4 open by themselves.
- `{ files: [], references: [{ path: "./packages/lib" }] }` still makes
  `tsc -p` succeed while `tsc -b` would catch a type error in the
  referenced project. HEAD prints `compile OK`. This copy refuses
  `tsc compiled no program source`.
- `typesVersions` remap, `package.json` `"main"` to an outside `.d.ts`,
  `resolveJsonModule` absolute `.json`, and `preserveSymlinks` + a
  `node_modules` junction onto worktree `src` were all refused by
  listFilesOnly. Same class as hole 2/3. Not new leftovers.
- `exports.types` / `#imports` under `bundler` still TS7016.
- `compilerOptions.plugins` is ignored by `tsc -p` (not red-capable).
- `customConditions` used the in-package types; outside file not listed.

r9 leftovers (same two items, measured against the r8b copy):
- implicit default typeRoots (`node_modules/@types/<pkg>` junction onto
  outside HiddenFix). Walker only realpathed an explicit `typeRoots` key.
- `compilerOptions.types: ["hidden-fix"]` — `types` names packages, not
  paths, so `check()` never ran.
- `/// <reference types="hidden-fix" />` — only `path=` was scanned.
- bare `from "leak-pkg"` where `node_modules/leak-pkg` is a junction onto
  worktree `src`. `isPathSpecifier` skipped the name.

`types-then-path` with `types="es2020"` is not a hole (TS2688). A tsconfig
file-symlink onto an outside config that includes the worktree already
refused (`include` + `staged symlink: tsconfig.json`). Dynamic `import()`
and `require()` were not red-capable until lib/`import = require` is
re-tried in r9b.

## src/evidence.ts — `EvidenceStore.withLock`

Replace the owner-recovery block (the `JSON.parse` / `owner?.pid` test)
with: a lock is debris unless it names a live positive integer pid.

```
        const raw = await fs.readFile(lockPath, 'utf8').catch(() => '');
        let owner: { pid?: unknown } | undefined;
        try {
          owner = raw.trim() ? JSON.parse(raw) as { pid?: unknown } : undefined;
        } catch {
          owner = undefined;
        }
        const pid = owner?.pid;
        const liveOwner = typeof pid === 'number'
          && Number.isSafeInteger(pid)
          && pid > 0
          && evidenceProcessAlive(pid);
        if (!liveOwner) {
          await fs.rm(lockPath, { force: true, recursive: true });
          continue;
        }
```

Also treat `EISDIR` on `open(wx)` as the same debris path as `EEXIST`.
Windows reports `EEXIST` when the lock path is a directory, then
non-recursive `rm` throws `EISDIR` (r13c leftover). Unix reports
`EISDIR` on the open itself. A directory at the lock path is not an
owner.

Empty bytes, `{not-json`, `{"at":"..."}` with no pid, and a directory
at the lock path must recover in milliseconds. `pid: 0` already
recovers via `evidenceProcessAlive`.

## src/mailbox.ts — `operatorCloseRecovery`

Same shape as `closeRecovery`: close inside the mailbox lock, then
best-effort `consolidate` outside it. Compaction must not fail the close.

```
    const checkpoint = await this.withLock(async () => {
      // existing close body unchanged
    });
    if (checkpoint) {
      try {
        await this.evidence.consolidate(workId, seat);
      } catch {
        // Intentionally swallowed. Compaction is an optimisation; the close is the fact.
      }
    }
    return checkpoint;
```

inherit / reassignment must still NOT compact.

## tests/audit-round2.test.js

1. Change "declared consequences of trusting the staged config" so
   `noCheck: true` is RED (exit 1, match `/noCheck/`). Keep the
   narrowing-`exclude` NOTE as a separate green assertion if you want
   it; do not keep `assert.equal(result.code, 0)` on a noCheck config.
2. Add a sibling of `ITEM 2 RED: consolidate is reachable`:
   three episodes, `operatorCloseRecovery`, leftover one summary of three.

I will not certify by running that suite. After you commit, send the
new HEAD. I will attack with a new instrument.
