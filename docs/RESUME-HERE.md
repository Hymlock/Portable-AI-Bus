# Resume here

## State at 2026-08-19 — 27 of 28 certified

HEAD `0032b05` on branch `claude/portability`. Suite **569 pass, 0 fail**. Fresh clone
verified: `npm ci` + `npm run check` green, 0 vulnerabilities. Tree clean, claims empty.
**Nothing has been pushed.**

`docs/COMPLETION-BAR.md` is authoritative. Item **28 is the only uncertified item**, waiting
on grok's ruling about whether its evidence is sufficient — see below, because the honest
answer is "the author doubts it".

### The two things waiting on a human

1. **The push.** `Portable-AI-Bus` on GitHub is **PUBLIC**. Hymlock chose "scrub then push to
   a branch" *before* it was known the repo was public and before the first personal-data scan
   turned out to be wrong. He has not answered since. It is the only irreversible step here and
   the only route to knowing whether any of this works on Linux — every check so far is Windows.
2. **Ensouled**, once 28 certifies. Verified 2026-08-19: repo clean at `3cb072b`, harness
   present, `validate_parity_exe_vs_source.py` genuinely red-capable (1 known-good, 7
   known-bad fixtures) and **still never run against the real executable**.

### Item 28 — read this before certifying it

The product fix is real: `spawnSync` in `bus-processes` had no timeout, on the operator wake
path, so a wedged `powershell` stopped the heartbeat rather than degrading it. Both branches
are now bounded at 10s, and the condition tests `error` first because a timeout returns
`error` set with a **null status** — the pre-existing `status !== 0` check would have
swallowed it.

The **evidence** is a pair, and its limit is written into the test: it shows the option is
present, and that an option of that shape bounds a hanging child. It does **not** show
`bus-processes` being interrupted mid-query.

A behavioural version was attempted and was **vacuous**: Node 24 will not resolve a bare
command to a `.cmd` without a shell, so a fake `powershell` on PATH never ran and `spawnSync`
returned `ENOENT` in 1ms — indistinguishable from a working timeout. It was deleted rather
than shipped. Grok has three options from the author (accept source-level; find an
interposition he missed; assert the observable consequence instead) and the author leans on
the third while noting his judgement about his own gates is the thing under suspicion.

### The rule that made this terminate

Grok's, after rejecting a weaker one the author proposed:

- A **VARIANT** is a new spelling of something the stated rule already decides.
- A **HOLE** is an attack the rule does not decide, or decides **wrongly**.
- **The auditor classifies. The author may argue; the author may not decide.**
- Rules are stated **positively** — every round lost was lost to enumerating bad cases, and
  an enumeration always has an edge.

### What actually kept going wrong

**A check reported success without the thing under test having been exercised.** Five times in
two days, every one in an *instrument* rather than in the code:

- `git stash push -- src` stashed nothing (src was clean) — the "unfixed" run was fixed code
- a suite ran green against a stale `dist` while `tsc` was failing
- a regex revert silently did not match; `fail=0` was read as "cannot go red"
- a pre-publication scan asked what *changed* when the question was what a push makes *public*
- a fake `powershell` that never ran, reported as a passing timeout

A sixth followed, and it is the one that names the class: the author told grok its assignment
anchor was stale and it was re-deriving certified items. It was not. Its checkpoint was
`#2011` — *audit 25/26/27/28* — and it was working them in order. That was diagnosed from the
**prose of a verdict** instead of from the checkpoint, which is one command away. Retracted at
`#2023`.

**The shape underneath all six: asserting from a READABLE SURFACE instead of the DURABLE
RECORD underneath it.**

| what was read | what should have been read |
|---|---|
| the prose of a verdict | the open checkpoint |
| `git diff origin/main..HEAD` | the whole tree a push publishes |
| a passing gate | whether the build happened |
| `git stash push` output | whether anything was stashed |
| one process-list snapshot | two |
| a fast `spawnSync` return | whether the fake binary ever ran |

Every durable mechanism on this project — checkpoints, claims, notice files, red controls,
loaded-code markers — exists because that failure is the expensive one. They caught all six,
*eventually*. The remaining gap is that "eventually" has meant **after** the author had already
said something out loud.

`tests/helpers/red-control.js` now refuses to measure until a mutation is **confirmed applied**
and refuses to return until the restore is **byte-exact**. Use it. It was written after the
fourth instance and caught the fifth.

### Live machinery notes

- The supervisor restarts a dead brain in ~5s; `dead-seats.json` is for *exhausted* budgets and
  correctly stays absent for a single death. Observed live, twice, unstaged.
- A single process-list snapshot is **not** evidence of death — the author reported a transient
  restart as an absence. Measure twice.
- `STALE-CODE codex` is currently accurate: codex runs a pre-commit wrapper and has no model
  (`model unavailable; receipt only`). Do not read its acks as progress.

---

## Earlier record — 19 of 20, item 15 still open

HEAD `e28c7b5`. Suite **523 pass, 0 fail**. Claims empty. No tracked file dirty (the ~150
untracked `tmp-audit-*` files are grok's probes and reports — deliberately kept).

**Item 15 was the only item outstanding.** Round 21 is with grok (`#1936`). Everything else
is certified by an auditor that did not write it.

### Standing commitment in force

I make **no edits to `src/`, `scripts/` or `tests/` until grok rules on item 15.** r20 read
22 PASS / 0 FAIL and grok declined to certify anyway, because my uncommitted edits appeared
mid-wake — it was measuring one artifact and reporting on another. Its refusal was correct.
Docs are not covered by this and may still be edited.

### The stopping rule — grok's, not mine

- A **VARIANT** is a new spelling of something the stated rule already decides.
- A **HOLE** is an attack the stated rule does not decide, or decides **wrongly**.
- **The auditor classifies. The author may argue; the author may not decide.**
- Rules are stated **positively** — every round lost was lost to an enumeration of bad
  cases, and an enumeration always has an edge to step around.

My own proposal was rejected as too low, and it was: it let the author classify the
leftovers, which would have certified item 15's class while it was still open.

### Round history

| round | verdict |
|---|---|
| 1 | 6 of 7 failed |
| 2 | 7 certified; 13, 10, 18, 15 failed |
| 3 | 13, 10, 18 certified; 15 failed |
| 10–18 | **blocked** — claude held the four repair paths and went dark for 8 hours |
| 19 | **2 and 20 certified**; 15 had one hole (substring exemption) |
| 20 | 22 PASS / 0 FAIL; 15 not certified — tree changed mid-wake |
| 21 | in flight |

### The two findings worth not re-deriving

**The substring that sat under its own lesson.** `classifyListedFiles` exempted anything
where `comparable(real).includes(comparable(scratchRoot))`. `<scratch>x/index.d.ts` is a
*different directory* that merely starts with the same characters, and a `package.json`
`"types"` naming it was loaded by tsc while the hook printed `compile OK`. It sat **three
lines under a comment saying a substring match is not a permit**, with `pathContains`
already defined and used on the two lines above. Fixed at `ebd70ec`.

**The scratch root was never resolved.** `mkdtempSync(os.tmpdir())` is lexical; every file
tsc lists is realpathed. Where tmpdir is itself a link — `/var` → `/private/var` on macOS,
a redirected TEMP or junction on Windows — every legitimate staged file resolves outside
its own scratch tree. Fail-closed, so not a leak, but it is **item 6's failure**: on macOS
this would have refused every commit, and a guard that cannot be satisfied gets bypassed
just as surely as one that cannot go red. This machine's tmpdir is not a link, so nothing
in 523 tests would have shown it. Fixed at `e28c7b5`; the gate reproduces macOS on Windows
with a junction.

### Mistakes recorded on purpose

- **The 8-hour block was mine.** I held four repair paths and my monitor died unnoticed.
  Grok measured holes for nine rounds and could not fix them, reporting BLOCKED each time.
  The bus worked; the seat did not.
- **A gate of mine could not go red.** The first item-2 concurrency gate ran two
  consolidations in one process and passed against code with no lock at all. It needed four
  real processes, a 300-record file and a wall-clock barrier before it reproduced grok's
  `EPERM`.
- **Two gates encoded the defect.** `item10-recall.test.js` recalled a brief with no
  checkpoint open and asserted success; a test asserting exit 0 on `noCheck` did the same.
  Both changed, both called out — a changed test is the easiest place to lower a bar quietly.

### Where the evidence lives

`tests/audit-round2.test.js` (38) and `tests/audit-fixes.test.js` (6). Every RED gate has
been run against reverted source and seen to fail; every green control against both states
and seen to pass. Grok's reports are `tmp-audit-r*-verdict.md` at the repo root — **read the
newest before touching item 15.**

---

## Earlier record — state at machine shutdown, 2026-08-15 ~10:50

Written before a house move. Everything is committed; nothing is at risk. This is where to
pick up.

## Restart the bus first

```
node scripts/bus-restart.js --root "c:\Users\<you>\Downloads\Projects\ai-bus" \
  --workdir "c:\Users\<you>\Downloads\Projects\ai-bus" \
  --claim-repo "c:\Users\<you>\Downloads\Projects\Portable-AI-Bus" --brains codex,grok
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
