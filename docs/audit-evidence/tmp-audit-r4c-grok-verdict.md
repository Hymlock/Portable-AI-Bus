# AUDIT round 4 verdict (grok)

HEAD: `373e17650558eaef550bc94486b5cfc8d59abd2f`
Named commits: `8b5ae78` (item 15) and `8312282` (item 2) are ancestors.
Instrument: `tmp-audit-r4-grok.cjs` + `tmp-audit-r4b-grok.cjs` + live re-verify `tmp-audit-r4c-grok.cjs` against `dist/` and `scripts/claim-guard-cli.js`.
Not the author's suite. Did not edit `src/` or `tests/`.
Stopping rule (adopted, I classify): VARIANT = new spelling of something the stated rule already decides. HOLE = the rule does not decide it, or decides it wrongly.

Live r4c this session: 12P / 9F / 1N / 0S.

---

## Item 15 — NOT CERTIFIED

Round-3 holes you named stay closed: absolute `include` refused, untracked `extends` refused, relative `../` include refused, honest type-error red, hatch loud. Same-package leak via `extends: "./node_modules/leak-config/tsconfig.json"` is refused (`include` outside the staged tree).

The rule you adopted is: *tsc may see the materialised index and the declared node_modules junction. Nothing else.*

### HOLE 1 — bare `extends` is implemented as "do not look"

`findConfigEscapes` does `if (!isRelative) continue` and never walks the resolved package config.

Three spellings, one class, all live this session:
- `extends: "leak-config/tsconfig.json"` → `compile OK (staged index)`, exit 0
- `extends: ["leak-config/tsconfig.json"]` → same
- `extends: "leak-config"` → same

Each: staged `src/index.ts` is `export const broken: number = "no"`, worktree restored to a good file, leak-config's `include` is the absolute worktree `src`.

Control: same bare extends, worktree left broken → exit 1, and tsc names the WORKTREE file:

```
../pab-r4c-8sS1I5/repo/src/index.ts(1,14): error TS2322
```

So tsc compiled the worktree. That is the round-3 hole, decided wrongly for the bare spelling.

The same leak-config reached via `extends: "./node_modules/leak-config/tsconfig.json"` is REFUSED. You already walk relative extends into node_modules. "A bare specifier is allowed" should mean the specifier may resolve inside the declared junction; it must not mean skip the chain. After resolve, walk `include`/`files`/`references`/path options the same way.

This is not a variant. The rule already decides "include outside scratch refuses." The implementation decides that only when the extends entry starts with `.` or is absolute.

### HOLE 2 — `include` of a node_modules junction to the worktree

`include: ["node_modules/leak-src"]` where `leak-src` is a junction onto worktree `src`. `withinScratch` is lexical, so `scratch/node_modules/leak-src` looks inside. tsc follows the junction, compiles the restored worktree, prints `compile OK (staged index)`.

The declared junction exists so tsc can resolve types. It is not a permit to compile worktree sources by another name. Lexical containment is not the rule you wrote.

### HOLE 3 — source-level paths the walker never looks at

`/// <reference path="C:/.../hidden-fix.d.ts" />` plus `export const broken: HiddenFix = 1`.
`HiddenFix` exists only in that outside file. Guard: `compile OK (staged index)`, exit 0.

A staged file symlink pointing at an outside good file: same, exit 0.

The walker only reads tsconfig. tsc also reads triple-slash and staged symlinks. The rule is about what the compiler sees. An enumeration of tsconfig keys does not decide source directives, so this is a hole, not a variant of the config walk.

### VARIANT — omitted write-side compilerOptions paths

From r4 on this same HEAD (not re-run this wake; still unfixed):
- `tsBuildInfoFile` outside scratch: compile OK, `leak.tsbuildinfo` written outside.
- `mapRoot` / `sourceRoot` outside: compile OK. Neither hides a type error.

Same class as `outDir` / `declarationDir`, which you already walk. Add the keys. Do not hold the item open on these alone.

### Declared consequences, classified

- **narrowing `exclude`**: keep printed. Honest projects exclude. Not a hole.
- **`noCheck: true`**: I classify this as should-refuse. A staged switch that disables typechecking is the hook turning itself off from inside the artifact. A green plus a NOTE is the original measured failure (a commit that does not typecheck landed). Printed is not enough. You asked; that is the call.

Project references via a *subdir* tsconfig are not auto-picked. Staged `node_modules` failed closed on the claim half. Those are not holes.

---

## Item 2 — NOT CERTIFIED

What holds, live against `dist/evidence.js` + `dist/mailbox.js`:

- invalidate restores absorbed episodes
- two summaries over time: invalidate S2 restores only the B episodes + S1; then invalidate S1 restores A as well (r4c live)
- already-superseded-before-absorption stays pointing at the pre-absorption successor (r4)
- restore keeps each episode's own trust; summary does not launder (r4)
- re-invalidating an old summary does not steal episodes now held by a newer one (r4)
- dead-owner lock recovers in 4 ms (r4)
- `closeRecovery` compacts (r4c live)
- `closeRecovery` still closes when consolidate throws (evidence.json replaced with `NOT-JSON`) (r4c live)
- four real processes recording through a wall-clock barrier: event ids 1,2,3,4 (r4)
- four real processes consolidating *with* the lock: no crash, one live summary (r4)

No deadlock found. `closeRecovery` drops the mailbox lock before taking the evidence lock. A kill of a live lock owner does not leave a permanent lock.

### HOLE 1 — empty or unparseable lock is treated as a live owner

Wrote `evidence.json.lock` as empty bytes. `record()` waited 10020 ms and threw `Timed out waiting for the evidence lock`.

Same class, live this session: malformed JSON `{not-json` waited 10016 ms and timed out.

`withLock` recovers only when `owner?.pid !== undefined && !evidenceProcessAlive(owner.pid)`. `JSON.parse('')` fails, owner is `undefined`, the empty file is treated as a live claim.

A process killed between `open(wx)` and `writeFile` leaves exactly this. The stated rule is "a lock whose owner is gone is debris." An unparseable lock has no owner. That is debris. The implementation decides wrongly.

### HOLE 2 — `operatorCloseRecovery` still does not compact

Three episodes, operator-close the checkpoint: 0 summaries, 3 live. `closeRecovery` compact; `operatorCloseRecovery` does not.

The stated trigger was "when an assignment's checkpoint CLOSES." Operator close is a close. This is the "called from nowhere" defect on the second close path.

You may argue operator close is for stranded work and the operator can run `mailbox consolidate-evidence` by hand. I classify it as a hole of the class you just fixed. Compaction must stay best-effort and must not fail the close.

### The four-process consolidate gate

Checked as hard as the code (r4 on this HEAD).

Crash half: REAL. Unlocked four-process copy of `consolidateUnsafe` (temp+rename, no lock, same 300-record file, same barrier): one child crashed, three reported `absorbed=300`. The one-process gate you threw away could not go red; this one can.

Lost-update half: cannot go red. After that unlocked run the leftover file was still **1 summary of 300, 1 live**. Last-write-wins deletes the earlier summaries with the overwritten file. Your assertions (`summaries.length === 1`, `live.length === 1`, `consolidatedFrom.length === 300`) are the LWW shape. The comment that they catch a silent lost update is wrong. Concurrent RECORD (four processes, unique `sourceEventId`) is the lost-update instrument, and it holds.

Do not hold item 2 open for the gate comment. Hold it for the empty-lock hole, and for operator-close if you accept my classification.

---

## Item 20 — CERTIFIED

Own instrument, not the author's tests. HEAD `373e176`, implementation `2e4a08d` (already on this branch).

| gate | result |
|---|---|
| seat cannot `closeRecovery` another seat's open row | PASS — stolen=undefined, still open |
| operator closes a stranded row; reason logged `operator-closed: ...` | PASS |
| empty / whitespace reason refused; row stays open | PASS |
| operator-close of an already-closed row is a no-op | PASS (r4) |
| ordinary runner `closeRecovery` still closes | PASS (r4) |
| CLI `mailbox close-recovery --seat --work-id --reason` reaches the operator path | PASS (r4) |
| after operator close, `recallAssignment` is undefined for every seat | PASS |
| `src/harness.ts` has no operator-close / close-recovery verb | PASS — seats must not have this |

Green case is live: runner-driven close unchanged. The refusal a seat already practised ("I will not write another seat's recovery record") survives. No harness or brain action, on purpose.

I do not edit `docs/COMPLETION-BAR.md`. Record the certification if you accept the instrument.

---

## Bar after this round

17 previously certified + item 20 = 18, if you write it down.
Still open: **2** and **15**.
`done` is false. An acknowledgement is not completion.

Instruments left untracked at the repo root: `tmp-audit-r4-grok.cjs`, `tmp-audit-r4b-grok.cjs`, `tmp-audit-r4c-grok.cjs`, matching `-out.json` / `-report.txt` / verdict files.
