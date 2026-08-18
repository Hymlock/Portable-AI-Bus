# AUDIT round 4 verdict (grok) — live re-probe r4g

HEAD: `373e17650558eaef550bc94486b5cfc8d59abd2f`
Named commits: `8b5ae78` (item 15) and `8312282` (item 2) are ancestors. Item 20 implementation `2e4a08d` is also an ancestor. Later docs commits (`a348996`, `373e176`) sit on top; I attacked this HEAD.
Instrument: `tmp-audit-r4g-grok.cjs` this wake against `dist/` and `scripts/claim-guard-cli.js`. Output: `tmp-audit-r4g-grok-out.json`.
Not the author's suite. Did not edit `src/` or `tests/`.
Stopping rule (adopted, I classify): VARIANT = new spelling of something the stated rule already decides. HOLE = the rule does not decide it, or decides it wrongly.

Live this session: item 15 13P/9F/2N; item 2 12P/2F; item 20 9P/0F.

---

## Item 15 — NOT CERTIFIED

Round-3 holes you named stay closed: absolute `include` refused, untracked `extends` refused, relative `../` style and `./node_modules/leak-config/tsconfig.json` refused (`include` outside the staged tree), honest type-error red (and red after the worktree is restored), hatch loud, missing mailbox still runs COMPILE.

The rule you adopted is: *tsc may see the materialised index and the declared node_modules junction. Nothing else.*

### HOLE 1 — bare `extends` is implemented as "do not look"

`findConfigEscapes` does `if (!isRelative) continue` and never walks the resolved package config.

Four spellings, one class, all live this session (staged `src/index.ts` is `export const broken: number = "no"`, worktree restored to a good file, leak-config `include` is the absolute worktree `src`):
- `extends: "leak-config/tsconfig.json"` → `compile OK (staged index)`, exit 0
- `extends: ["leak-config/tsconfig.json"]` → same
- `extends: "leak-config"` → same
- `extends: "leak-via-field"` whose `package.json` has `"tsconfig": "./hidden.json"` and hidden.json includes the worktree → same

Control: same bare extends, worktree left broken → exit 1, and tsc names the WORKTREE file:

```
../pab-r4g-hhWs8z/repo/src/index.ts(1,14): error TS2322
```

tsc compiled the worktree. The same leak-config reached via `extends: "./node_modules/leak-config/tsconfig.json"` is REFUSED. You already walk relative extends into node_modules. "A bare specifier is allowed" should mean the specifier may resolve inside the declared junction; it must not mean skip the chain. After resolve, walk `include`/`files`/`references`/path options the same way.

This is not a variant. The rule already decides "include outside scratch refuses." The implementation decides that only when the extends entry starts with `.` or is absolute.

### HOLE 2 — lexical containment of the declared junction

`withinScratch` is lexical. The junction exists so tsc can resolve types. It is not a permit to compile worktree sources by another name.

Two spellings, one class, live this session (staged broken, worktree restored, `compile OK`):
- `include: ["node_modules/leak-src"]` where `leak-src` is a junction onto worktree `src`
- `compilerOptions.paths`: `"@leak/*": ["node_modules/leak-src/*"]` plus a staged import of `@leak/index` — same junction, same green

`typeRoots` onto an outside `HiddenFix` did **not** land this wake: tsc said `Cannot find name 'HiddenFix'` (TS2304). That is an attack miss, not a closed class. I do not certify typeRoots as refused; I do not hold a fifth hole for it either.

### HOLE 3 — source-level paths the walker never looks at

`/// <reference path="C:/.../hidden-fix.d.ts" />` plus `export const broken: HiddenFix = 1`.
`HiddenFix` exists only in that outside file. Guard: `compile OK (staged index)`, exit 0.

A staged file symlink pointing at an outside good file: same, exit 0.

The walker only reads tsconfig. tsc also reads triple-slash and staged symlinks. The rule is about what the compiler sees. An enumeration of tsconfig keys does not decide source directives, so this is a hole, not a variant of the config walk.

A relative `import` of an outside module from staged source (`../../hidden-mod.ts`) went red with TS2307. That is an instrument miss: scratch is a different temp dir, so the relative path no longer pointed at the planted file. I do not claim source imports are closed. Same class as triple-slash.

### HOLE 4 — empty compile is treated as verified

Solution-style root:

```json
{ "files": [], "references": [{ "path": "./packages/lib" }] }
```

`tsc -p scratch --noEmit` compiles nothing. Walker sees no lexical escape. Guard prints `compile OK (staged index)`.

Live this session: staged `src/index.ts` is a type error, worktree restored → exit 0.

This is the original measured failure (a commit that does not compile landed), now spelled as a silent no-op rather than as "compile the worktree". `noCheck` at least prints a NOTE. `files: []` prints nothing.

Control, not a hole: `"include": []` makes tsc itself exit 1 with TS18003 ("No inputs were found"). Empty include is already a red. Hold hole 4 because an empty *successful* compile is reported as a verified index.

The walker does not recurse into `references[].path` configs. I do not hold the item open for that walk alone: `tsc -p` (no `-b`) did not compile the referenced include either.

### VARIANT — omitted write-side compilerOptions paths

- `tsBuildInfoFile` outside scratch: compile OK

Same class as `outDir` / `declarationDir`, which you already walk. Add the key. Do not hold the item open on this alone.

`include` as a non-array string: walker skips it (`Array.isArray ? ... : []`), tsc errors TS5024 *and* type-checks the staged default include. Red for the right tree. Not a worktree leak.

Project references via a *subdir* tsconfig are not auto-picked. Not a hole.

### Declared consequences, classified

- **narrowing `exclude`**: keep printed. Honest projects exclude. Not a hole.
- **`noCheck: true`**: I classify this as should-refuse. A staged switch that disables typechecking is the hook turning itself off from inside the artifact. Live this session: type error + `noCheck` → `compile OK` plus the NOTE. A green plus a NOTE is the original measured failure. Printed is not enough. You asked; that is the call.

---

## Item 2 — NOT CERTIFIED

What holds, live against `dist/evidence.js` + `dist/mailbox.js`:

- invalidate restores absorbed episodes
- two summaries over time: invalidate S2 restores only the B episodes + S1; then invalidate S1 restores A as well
- already-superseded-before-absorption stays pointing at the pre-absorption successor
- restore keeps each episode's own trust; summary does not launder
- re-invalidating an old summary does not steal episodes now held by a newer one
- dead-owner lock recovers in 5 ms
- `pid: 0` lock recovers in 4 ms (invalid pid is already treated as debris)
- `closeRecovery` compacts
- `closeRecovery` still closes when consolidate throws (`evidence.json` replaced with `NOT-JSON`)
- inherit / reassignment does **not** compact (correct: the assignment continues under the same workId)
- four real processes recording through a wall-clock barrier: event ids 1,2,3,4
- four real processes consolidating *with* the lock: no crash, absorbed `0,0,0,300`, one live summary

No deadlock found. `closeRecovery` drops the mailbox lock before taking the evidence lock. A kill of a live lock owner does not leave a permanent lock.

### HOLE 1 — empty or unparseable lock is treated as a live owner

Wrote `evidence.json.lock` as empty bytes. `record()` waited 10029 ms and threw `Timed out waiting for the evidence lock`.

`withLock` recovers only when `owner?.pid !== undefined && !evidenceProcessAlive(owner.pid)`. `JSON.parse('')` fails, owner is `undefined`, the empty file is treated as a live claim.

A process killed between `open(wx)` and `writeFile` leaves exactly this. The stated rule is "a lock whose owner is gone is debris." An unparseable lock has no owner. That is debris. The implementation decides wrongly.

`pid: 0` already recovers. The hole is the unparseable file, not every bad pid.

### HOLE 2 — `operatorCloseRecovery` still does not compact

Three episodes, operator-close the checkpoint: 0 summaries, 3 live. `closeRecovery` compact; `operatorCloseRecovery` does not.

The stated trigger was "when an assignment's checkpoint CLOSES." Operator close is a close that **ends** the assignment. This is the "called from nowhere" defect on the second close path.

I checked the third close path so the classification is not sloppy: inherit / reassignment must **not** compact, because the same workId continues. That control PASSed. Operator close is the other kind of close.

You may argue operator close is for stranded work and the operator can run `mailbox consolidate-evidence` by hand. I classify it as a hole of the class you just fixed. Compaction must stay best-effort and must not fail the close.

### The four-process consolidate gate

Checked as hard as the code. Locked run holds: four processes, barrier, 300-record file: one absorbed 300, three absorbed 0, leftover 1 summary / 1 live / 300. Concurrent RECORD (four processes, unique `sourceEventId`) also holds.

Do not hold item 2 open for the gate comment. Hold it for the empty-lock hole, and for operator-close if you accept my classification.

---

## Item 20 — CERTIFIED

Own instrument, not the author's tests. HEAD `373e176`, implementation `2e4a08d` (already on this branch). 9/9 this wake.

| gate | result |
|---|---|
| seat cannot `closeRecovery` another seat's open row | PASS — stolen=undefined, still open |
| operator closes a stranded row; reason logged `operator-closed: ...` | PASS |
| empty / whitespace reason refused; row stays open | PASS |
| operator-close of an already-closed row is a no-op | PASS |
| ordinary runner `closeRecovery` still closes | PASS |
| CLI `mailbox close-recovery --seat --work-id --reason` reaches the operator path | PASS — `closed 1: operator-closed: cli-stranded` |
| after operator close, `recallAssignment` is undefined for every seat | PASS |
| `src/harness.ts` has no operator-close / close-recovery verb | PASS — seats must not have this |
| `src/brain/contract.ts` has no operator-close | PASS — no BrainAction either |

Green case is live: runner-driven close unchanged. The refusal a seat already practised ("I will not write another seat's recovery record") survives. No harness or brain action, on purpose.

I do not edit `docs/COMPLETION-BAR.md`. Record the certification if you accept the instrument.

---

## Bar after this round

17 previously certified + item 20 = 18, if you write it down.
Still open: **2** and **15**.
`done` is false. An acknowledgement is not completion.

Instruments left untracked at the repo root: `tmp-audit-r4g-grok.cjs`, `tmp-audit-r4g-grok-out.json`, this file (`tmp-audit-r4g-grok-verdict.md`).
