# Resume here — state at machine shutdown, 2026-08-15 ~10:50

Written before a house move. Everything is committed; nothing is at risk. This is where to
pick up.

## Restart the bus first

```
node scripts/bus-restart.js --root "c:\Users\hymlo\Downloads\Projects\ai-bus" \
  --workdir "c:\Users\hymlo\Downloads\Projects\ai-bus" \
  --claim-repo "c:\Users\hymlo\Downloads\Projects\Portable-AI-Bus" --brains codex,grok
```

Then check `.ai-bus/runtime/stale-code.json` is absent and both brains report matching
loaded-code markers. `--claim-repo` is **not optional** — without it no seat can claim a repo
path (item 6).

## Two known traps on this machine

1. **`npm install` wiped `node_modules/.bin`** (all 42 shims), which broke `tsc`, `npm run
   compile`, `npm test` and every compiling hook for about two hours. Repaired by running
   `npm install` again. If `tsc is not recognized` appears, that is this.
2. **`node-pty` half-installs**, leaving `prebuilds/ src/ third_party/` and no entry point.
   Every provider then fails. It happened three times on 2026-08-14/15. Fix:
   `npm install node-pty`, verify with `node -e "require('node-pty')"`. Item 11 now reports
   this correctly as **BROKEN** rather than "out of providers".

## Bar status — 8 of 20 certified

| certified | at |
|---|---|
| 1 verified evidence memory + temporal binding | `ab9807a`, `606d49d` |
| 3 supersede a sent message | `1948082` |
| 4 cross-seat reassignment | `c755a42` |
| 5 stalled vs spent | `78ffe75`+`48d24f4` (BROKEN not covered) |
| 6 claim guard | `2dae2a7` |
| 8 an ack is not a commitment | `247184e`+`6f975ec` |
| 9 detector whose only sink is a log | `f3798fe` |
| 11 broken link reports as spent | `5352b0d` |

**Implemented, NOT certified** — needs an auditor who did not write it:

- **12** a call that never starts is invisible — `a97deaf` + `b31177f` + `ec41d92`. Parent-clock
  fix independently confirmed by claude against a harsher case than codex's (sibling 120 ms
  late vs a 25 ms threshold → breach recorded). Conhost leak verified flat by codex over 50
  real calls (147→147, 148→148).
- **16** actor required at store — `e43d5a8`
- **17** truncation visible — `d86b620`
- **19** supersede polish — `eb8e10f`
- **`bd79ae1`** — grok's AttachConsole + runner orphan-reap, committed by claude to preserve it.
  **Not verified.** See the commit message.

**Open**: 2 (consolidation — the real remaining work), 7, 10, 13, 14, 15, 18, 20.

## Do this first when you come back

1. **The suite hangs.** `npm test`, and even `node --test tests/process-host.test.js
   tests/stall-ledger.test.js`, ran past ten minutes on 2026-08-15. Unresolved: either the
   honest cost of gates exercising 30 s thresholds and never-returning spawns, or a real defect
   in the sibling tests. **Settle this before trusting any green.** Last known-good full run was
   **437 pass** at `ec41d92`.
2. **Certify `bd79ae1`** or revert it. Previous good state is `ec41d92`.
3. **Item 18** — atomic superseding send. Codex's design is accepted and written up in
   `COMPLETION-BAR.md`; nothing is implemented.

## Rules that were earned, not assumed

- **A gate that cannot go red is not a gate** — and one that cannot be *satisfied* gets
  bypassed. Both ended with a check that was not checking.
- **A capability no caller can invoke is not implemented.** Item 3 passed 377/377 while
  unreachable from every layer.
- **When you add a field to a record, every reader of it is part of the change.** Nearly every
  defect tonight was two halves of one system disagreeing.
- **The auditor is never the author**, and an auditor must bring its **own instrument** — the
  instrument itself can be wrong. Claude's audit probe was wrong twice before it was right.
- **A red control is the instrument working, not a defect.** Do not hold an item open because
  its negative control is red.
- **Do not run the suite while a seat is verifying.** Claims protect files; nothing protects
  test runs, and they share temp dirs, ports and spawned processes.

## Seats

`codex` is **out of credits**. `grok` was working but stalling frequently. With codex spent,
claude audited grok's work and grok was assigned codex's — that keeps the invariant without
either seat certifying itself.
