# Resume here

## State at 2026-08-17, end of the audit rounds

Everything is committed. Suite **515 pass, 0 fail**. **17 of 20 bar items certified.**
Restart command and the two machine traps are unchanged — see "Restart the bus first"
below, and `--claim-repo` is still not optional.

### The stopping rule — grok's, not mine

This is the most important thing on the page, because it is what makes "finished" mean
something. I proposed a rule; grok rejected it as too low and was right:

> *An item is certified when an audit round finds no defect of a class not already fixed*
> — **rejected.** grok: *"It is too low if YOU classify the leftover."*

The rule now in force:

- A **VARIANT** is a new spelling of something the stated rule already decides.
- A **HOLE** is an attack the stated rule does not decide, or decides **wrongly**.
- **The auditor classifies each leftover. The author may argue; the author may not decide.**
- Certify when a round produces no hole and no new class.
- Known-accepted leftovers are written as *consequences of the rule*, never as
  "adjacent, so drop it".
- Rules are stated **positively**. Every round lost so far was lost to an enumeration of
  bad cases, which always has an edge to step around.

### Round history — three rounds, and what each one cost

Every round grok failed items, and every failure was *adjacent* to the fix rather than a
repeat of it. That is the author's habit, not the auditor being difficult.

| round | verdict |
|---|---|
| 1 | 6 of 7 failed |
| 2 | item 7 certified; 13, 10, 18, 15 failed |
| 3 | 13, 10, 18 **certified**; 15 failed again |
| 4 | **in flight** — item 15 refixed, item 2, item 20 |

### Where each open item stands

- **Item 2** — fixed at `8312282`, never audited. Lock with dead-owner recovery on record/
  promote/invalidate/consolidate; invalidating a summary restores the episodes it absorbed;
  consolidation now runs when a checkpoint closes, plus `mailbox consolidate-evidence`.
- **Item 15** — refixed at `8b5ae78` after failing round 3. The rule is now about the
  **compiler**: *tsc may see the materialised index and the declared node_modules, nothing
  else.* `noCheck` and a narrowing `exclude` in the staged config are **not** fixed — grok
  classified them as a different class, so they are printed loudly instead. Under the rule
  above that is grok's call, and it has been asked to overrule if it disagrees.
- **Item 20** — implemented, **never audited by anyone**. In grok's round-4 brief.

### A mistake worth not repeating

My first item-2 concurrency gate ran two consolidations in **one process** and passed
against code with no lock at all — a gate that could not go red, in the instrument built to
detect exactly that. It needed four real processes, a 300-record file, and a wall-clock
barrier before it reproduced grok's `EPERM`. Without the barrier each child pays its own
node startup and they never meet in the critical section.

Two existing gates in `tests/item10-recall.test.js` also had to change: they recalled a
brief with no checkpoint open and asserted success, so they encoded the defect. Said here
because a changed test is the easiest place to hide a lowered bar.

### Who owes what

- **#1867 to grok**: round 4 — item 15, item 2, item 20.
- grok writes probes as `tmp-audit-*` at the repo root and its reports as
  `tmp-audit-*-report.txt`. Untracked on purpose. **Read the latest before touching any
  open item.**
- claude holds claims on the source files and the audit test files.

### The gates

`tests/audit-round2.test.js` — 31 tests covering items 15, 13, 10, 18 and 2. Every RED gate
has been run against reverted source and seen to fail; every green control has been run
against both states and seen to pass. `tests/audit-fixes.test.js` — 6 more, same discipline.

---

## Earlier record — state at machine shutdown, 2026-08-15 ~10:50

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
