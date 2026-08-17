# Resume here

## State at 2026-08-17 (latest — the section below this one is the older 2026-08-15 record)

Everything is committed. Suite **485 pass, 0 fail**. Restart command and the two machine
traps are unchanged — see "Restart the bus first" below, and `--claim-repo` is still not
optional.

### Where the work stands

grok audited the last six bar items and failed six of seven. Five are now FIXED:

| item | commit | the attack it was written against |
|---|---|---|
| 15 | `0472056` | staged type error + clean working tree printed `compile OK`; now compiles the INDEX via `git checkout-index` |
| 7 | `6480d81` | the brain path sent `why \|\| 'unstated'`, inventing a reason; now refuses |
| 13 | `6480d81` | a junction named `everything` pointing at the root passed the lexical check; now refused by realpath IDENTITY |
| 10 | `6480d81` | after `reassignBaton` the inheriting seat could not recall its own brief; recall now follows the baton |
| 18 | `6480d81` | `supersedes` existed only on `MailboxStore.send` — every caller surface dropped it; now wired through all nine |

Gates: `tests/audit-fixes.test.js`, six tests. All six were run against the reverted source
(`git stash push -- src`, rebuild) and **all six fail there**. Each has a green control.

### The one item still open — item 2

**Item 2 (evidence consolidation) is NOT fixed.** It is the next thing to do, and it is mine.
grok named three holes, all still present:

1. `invalidate(summary)` orphans the absorbed rows, so current facts vanish with the summary.
2. No lock — two processes consolidating at once crash with `EPERM`.
3. `consolidate` is **called from nowhere**. Same defect class as item 18: the store is not
   the feature.

Start at `src/evidence.ts` (`consolidate`, `invalidate`) and `tests/item2-consolidation.test.js`.

### Who owes what

- **#1842 to grok**: audit the five fixes above. grok was told explicitly not to edit `src/`
  or `tests/`, and not to touch item 2.
- **claude holds claims** on the seven source files plus `tests/audit-fixes.test.js`. Release
  them or re-claim after restart; claims survive in `state.json`.
- Baton is with **grok** as of `#1841`.

### Bar status

13 certified (1, 3, 4, 5, 6, 8, 9, 11, 12, 14, 16, 17, 19). 7 awaiting audit
(2, 7, 10, 13, 15, 18, 20) — of which five are the fixes just sent to grok, item 20 was never
audited, and item 2 is not yet fixed. `docs/COMPLETION-BAR.md` is authoritative.

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
