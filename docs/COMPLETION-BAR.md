# The bus completion bar

What "the bus is finished" means, item by item. Written down on 2026-08-14 because until
then the bar lived only in a chat context — two of these items exist *only* because an audit
failed, and losing that would mean re-deriving them by failing the same way twice.

Status values are deliberately harsh. **Implemented is not certified.** An item is done when a
seat that did not write it has attacked it and said so on the record.

| # | item | status |
|---|---|---|
| 1 | verified evidence memory | **CERTIFIED** at `ab9807a`; temporal binding **CERTIFIED** at `606d49d` |
| 2 | consolidation of an assignment's episodes | **CERTIFIED** at `1592382` (grok r19, 12 attacks) - lock, undo, and a caller |
| 3 | supersede a sent message | **CERTIFIED** at `1948082` — three audits, three commits |
| 4 | cross-seat reassignment | **CERTIFIED** at `c755a42` (2026-08-14) |
| 5 | distinguish *stalled* from *spent* | **CERTIFIED** at `78ffe75`+`48d24f4` — separates SPENT from STALLED; **BROKEN not covered** |
| 6 | claim guard — satisfiable **and** mutually exclusive | **CERTIFIED** at `2dae2a7` — four audits, six commits |
| 7 | claim schema — `why` is optional | **CERTIFIED** at `6480d81` (grok instrument 2026-08-17) |
| 8 | an ack is not a commitment | **CERTIFIED** at `247184e`+`6f975ec` (claude instrument, 10/10) |
| 9 | a detector whose only sink is a log | **CERTIFIED** at `f3798fe` — notice file + bus-tick; still no auto-restart |
| 10 | authorisation does not survive a wake | **CERTIFIED** at `082ddfa` (grok round 3) - an open checkpoint is the only authority |
| 11 | a broken link reports as *spent* | **CERTIFIED** at `5352b0d` — SPENT / STALLED / BROKEN split |
| 12 | a call that never starts is invisible | **CERTIFIED** at `a97deaf`+`b31177f`+`ec41d92` (claude instrument, 5/5) |
| 13 | a claim can be too broad to be useful | **CERTIFIED** at `8ea4c35` (grok round 3) - claims must resolve strictly under a claim root |
| 14 | an overlap check can walk an arbitrary volume | CERTIFIED at `06c927f` (claude instrument, 4/4; 4ms vs 99ms) |
| 15 | the guard verifies claims, not builds | **CERTIFIED** at `bb5478b` (grok r24, 28 PASS / 0 FAIL / 2 NOTE) — blob `09302e93`, re-derived after the walker-scope fix, not copied from r21 |
| 16 | `actor` is optional at the store | **CERTIFIED** at `e43d5a8` (grok instrument 2026-08-17) |
| 17 | truncation is invisible on inbox/read/worker | **CERTIFIED** at `d86b620` (grok instrument 2026-08-17) |
| 18 | send and supersede are two steps | **CERTIFIED** at `082ddfa` (grok round 3) - reaches a real provider call; both verbs agree |
| 19 | supersede polish: transcript metadata, CLI usage | **CERTIFIED** at `eb8e10f` (grok instrument 2026-08-17) |
| 20 | a checkpoint can become unclosable | **CERTIFIED** (grok 9/9) - operator close, reason required |
| 21 | a refusal kills the seat | **CERTIFIED** at `f528041` (grok r25, 10 PASS / 0 FAIL) - survivable and reported; item 10 unweakened |
| 22 | an absent seat is not noticed | **CERTIFIED** at `631287f` (grok r29, live bus) - notice file PLUS the DEAD-SEAT tick line |
| 23 | `liveBrains()` on the tick is machine-wide, not `--root` scoped | **CERTIFIED** at `f4b2ead` (grok r34) - `processesForRoot`; temp-root NONE vs 631287f leak of `codex,grok`. Unix early-return is carving, not unfinished 23 |
| 24 | an unreadable mailbox suppresses the DEAD-SEAT line | **CERTIFIED** at `f4b2ead` (grok r34) - notices print alongside MAILBOX UNREADABLE; 631287f hid DEAD-SEAT |
| 25 | a dead-seat notice FAILS OPEN when the process list is unreadable | **CERTIFIED** at `cad4278` (grok r36) - only a real pid clears; 12 fail-open shapes refused; sweep driven, not just the predicate |
| 26 | a test file invoked directly can pass on stale `dist` | **CERTIFIED** at `cad4278` (grok r36) - 40/40 dist-loading tests carry it; warning asserted by name; severity accepted as correct |
| 27 | a dead-seat notice can outlive the death it describes | **CERTIFIED** at `684acce` (grok r39, 21 PASS / 0 FAIL) - red control DEMONSTRATED against extracted f4b2ead; reader does not clear, by design |
| 28 | the operator wake path can hang forever on a process query | **CERTIFIED** at `43416cf` (grok r43, 52 PASS / 0 FAIL) - listNodeProcesses ITSELF proven bounded: hijacked query + forced 2s timeout threw in 2020ms; RED with timeout deleted ran 8063ms |

Items 1–7 were the original bar. **Items 8–11 were all added on 2026-08-14/15 from measured
failures, not planning** — three of the four were found by the system failing in front of us
while we worked on something else.

**Items 21–28 were added on 2026-08-18/19, and every one came from the system failing in
front of us rather than from planning.** 21 and 22 from a defect the author introduced with an
already-certified fix, which took a seat down for hours: the guard was right, the place it
threw was not, and nothing durable said the seat was gone. 23–26 were grok's classifications
of the leftovers from that repair. 27 came from grok observing a stale notice contradict a
live brain. 28 came from the coordinator's own watchdog stalling on an unbounded process
query — found by living it, not by reading the code.

The bar is a lower bound, and eight items in two days is the evidence for that.

## Item 1 — certified at `ab9807a`, after failing twice

The surface failed certification **twice** before it passed, each time because the guard
bound the wrong quantity.

1. **Tautology** (caught by grok, fixed in `12204b0`). The verifier copied `record.subject`
   onto itself and then compared the two. A check that cannot fail is not a check.
2. **Mutable payload** (caught by codex against `12204b0`). Provenance was bound — a plain
   object is refused with `a plain object is not an observation`, and the private constructor
   plus unexported mint token make that real. Contents were **not** bound. Codex obtained an
   *authentic* observation from `observeCommitDiff` whose real diff touched only `README.md`,
   assigned `observation.observed = { commitExists: true, sha: 'deadbeef', changedPaths:
   ['src/evidence.ts'] }`, and `promote()` accepted it. The claim reached `trust: verified`
   with `inputIdentity: deadbeef`.

`readonly`, `private` and `Readonly<T>` are **erased at compile time**. They proved nothing at
runtime, which is exactly how this survived the first audit. Every guard on this surface must
be a runtime guard, and every probe must run against the compiled `dist`, not `src`.

**The sibling, found before the repair landed:** `src/evidence.ts:116` is
`Object.freeze({ ...observed })`, which is **shallow**. Freezing the instance closes codex's
exact attack while leaving `observation.observed.changedPaths.push('src/evidence.ts')` open —
the same false promotion one level down. Fixing the reported instance rather than the class
would have produced a gate that passes the probe and still cannot go red.

The invariant to hold: **a promoted claim's evidence must be what the verifier observed, not
what anyone — model, caller, or test — can write afterward.** Provenance without integrity is
half a boundary.

**The fix** (`ab9807a`): `deepFreezeClone` the payload including nested arrays, then
`Object.freeze(this)`. `Readonly<T>` stays compile-time only; the runtime guard is the freeze.

### How it was certified — and why the first two PASSes were rejected

The auditor reported PASS three times. The first two were sent back, and the reasons
generalise to any certification on this project:

1. **PASS by running the author's test.** Codex certified with
   `node --test --test-name-pattern` against the test grok wrote. If the author's assertion
   binds the wrong quantity it passes vacuously and the certification inherits the flaw —
   the tautology one level up. The instrument that found the original hole was codex
   *hand-writing* a probe, not running a file. **Rejected: an auditor must bring its own
   instrument.**
2. **PASS with no negative control.** The hand-written probe returned `verified` in all four
   cases. A readback that always printed `verified` would have produced an identical report,
   so the instrument was unfalsified. Worse, the probe was **over-determined**: the honest
   observation at `ab9807a` genuinely touches `src/evidence.ts`, so promotion was justified
   with or without the mutation. Codex's original `1376` attack was sharper precisely because
   the real diff touched only `README.md`, forcing the mutation to do the work.
   **Rejected: a gate that cannot go red is not a gate, and that applies to the audit too.**
3. **PASS with the negative control.** Claim `docs/COMPLETION-BAR.md`, a path absent from the
   real diff; honest `observeCommitDiff` returns `[src/evidence.ts,
   tests/evidence-memory.test.js]`; `changedPaths.push(...)` throws `TypeError: Cannot add
   property 2, object is not extensible`; promotion throws `EvidencePromotionError: irrelevant
   diff: missing docs/COMPLETION-BAR.md`; **readback gives `trust=untrusted, verifier=null`.**
   The instrument can express a negative, so the positives mean something. **Accepted.**

Read trust back **from the persisted record**, never from `promote()`'s return value. A throw
at mutation time is evidence about the freeze; the property that matters is that no mutation
reaches a promoted claim, and that is only observable in the stored record.

Certification gates (red first, all four):

- mutate `observation.observed` wholesale → refused
- mutate `observed.changedPaths` in place via `push` → refused
- mutate `observed.sha` / `observed.commitExists` in place → refused
- **an honest observation whose real diff touches the subject path still promotes** — not
  optional. Without it, the first three pass trivially if `promote()` simply always refuses,
  which is a gate that cannot go green.

### Temporal binding — certified at `606d49d`

The slice that replaced the two named refusals with post-claim event binding:
`observeCommitDiff` requires `committedAt > record.createdAt`, `observeLifecycle` requires
`event.at > record.createdAt`, and `setGoal` appends structured `lifecycleEvents` rows instead
of overloading `CompletionEvent.scope`.

Certified first attempt, and the probe shape is now the house standard without being asked
for:

- **RED first** — a persisted `goal-set` row with an **empty timestamp**, injected after the
  claim, refused with `lifecycle event was not recorded after the claim`;
- **GREEN** — `setGoal` called after the claim produced a row with a UUID and `eventAt`
  **1.119 s** after `claim.createdAt`; promotion succeeded;
- **persistence, not memory** — the record was re-read through a **new `MailboxStore`
  instance** and still read `trust=verified`, `inputIdentity=goal-set@<same UUID>`.

The auditor also reported a Node heap OOM in the *other* seat's dirty in-flight
`tests/stall-ledger.test.js` and explicitly declined to attribute it to `606d49d`. Reporting a
failure you are not responsible for, without folding it into your verdict, is the behaviour
that makes a certification worth having.

## Item 4 — certified at `c755a42`, first attempt

The attack worth naming: **do action receipts travel with the checkpoint across a handoff?**
Same-seat tests could never catch that, and if receipts were lost the successor would replay
an action the predecessor already completed — reintroducing exactly the failure slice 1's
crash-boundary gate exists to prevent.

They travel. The auditor's own temp-mailbox probe recorded a completed send on one seat,
forced reassignment, and read the mailbox JSON **directly from disk**: the successor
checkpoint retained `workId 1`, `inheritedFrom codex`, and the exact receipt; the predecessor
was closed `reassigned to grok: provider loss`. Running the successor with the identical
planned send produced **0 side effects**.

**RED control, unprompted:** the auditor removed *only* the inherited receipt from the
persisted checkpoint and reran the same successor — **1 side effect**. The instrument detects
the failure it is meant to catch. Third-seat theft and courtesy-handoff `workId` preservation
also held (5/5).

Note what happened here. On item 1 the negative control had to be demanded twice. On item 4
the auditor built one before being asked. The standard propagated.

## Item 6 — the guard could not be satisfied, and it cost more than it caught

The bar used to call this "cannot express sibling paths." That was the symptom. The cause:

- `src/mailbox.ts:732` resolved every claim path against `this.paths.root` — the **bus
  runtime root** (`ai-bus`);
- `claim-guard-cli` enforced against **staged paths in the git repo**, and accepted `--repo`;
- `claim` had no `--repo`, so no file in this repository could ever be claimed.

Every refusal was individually correct-sounding, so it read as operator error rather than a
broken tool. **It failed closed and it failed politely** — which is why it survived so long.

What it cost in a single session, all of it recorded rather than reconstructed:

1. **Five bypassed commits** — `649ce8e`, `ab9807a`, `b94d737`, `5d9ef66`, `606d49d`. A guard
   bypassed on 100% of commits protects nothing.
2. **A near-collision it could not prevent.** Two seats were about to write `src/mailbox.ts`
   at once; the only thing that sequenced them was the planner noticing in time.
3. **Provenance loss** — one seat's `git add -A` swept another author's doc edits into its
   commit. Content survived; authorship did not.
4. **Both implementations blocked.** One seat tried to claim the very file containing the bug
   — *the defect blocks its own repair* — and the other burned a wake hunting for a path
   spelling that does not exist. Both behaved **correctly**: they refused to edit unclaimed
   and refused to declare progress off a failed claim. Good discipline converted directly
   into lost work.

**A guard that cannot be satisfied ends the same way as one that cannot go red: bypassed.**
That is the general lesson, and it is the inverse of the item 1 finding — same disease,
opposite symptom.

Fixed at `08da916`: `MailboxStore.claim` accepts `repoRoot`, checks requested paths against
both the repository and the bus root, and the claim CLI forwards `--repo`.

Verified independently, by a seat that did not write the fix:

| check | result |
|---|---|
| claim a repo file (`docs/COMPLETION-BAR.md`) | `HELD NOW` — impossible one hour earlier |
| **RED control**: claim a path in neither root | refused, exit 1 — the guard was not weakened |
| bus-root-relative claim still works | holds |
| **stage by name and commit with the hook ACTIVE, no `--no-verify`** | **the gate — passes** |

The last row is the whole item. The green case is what proves the guard is *satisfiable*;
the RED control is what proves the fix was making claims resolvable rather than making the
check quieter.

## Item 5 — measured, and it is not the shape the name suggests

Measured across both seats' brain logs on 2026-08-14:

| seat | `provider-stalled` | recovered on their own |
|---|---|---|
| codex | 26 | 24 |
| grok | 11 | 9 |
| **total** | **37** | **33 (89%)** |

**A stall is usually benign.** The signal fires often and resolves by itself nearly nine times
in ten. The defect is not that stalls occur — it is that at the moment one is logged, the 33
that will clear in ninety seconds are indistinguishable from the 4 that never will.

That ambiguity has a measured cost in both directions. A benign stall was read as failure and
a seat was killed mid-implementation. A real credit exhaustion was read as a mechanical fault
and chased for hours. Both were the same missing distinction.

So item 5 is **not** "add a third state to an enum." A stall needs a **duration and an
outcome**, not just an edge:

- emit stall start and stall resolution as a pair, so unresolved stalls are countable;
- separate *provider is slow* from *provider chain is spent* — the second is a fallthrough
  result, the first is a timer, and they are not the same measurement;
- a direct CLI probe answering `PONG` in ~4 s while the brain's call hangs is evidence of a
  **transport** condition, not a credit condition. Both seats' CLIs were verified healthy
  (`exit 0`, 3.5 s and 6.7 s) while their brain calls sat stalled.

Do not conclude a cause from this. Prompt size was the obvious suspect and is **not**
established — the argv-ceiling story was asserted and withdrawn once already (`81809dc`), and
five diagnoses today were plausible and wrong. Instrument first.

## Item 3 — supersede a sent message

Supersession exists today for **checkpoints only** — `closeCheckpoints(..., 'superseded by
work #N')` at `src/mailbox.ts:528, 669, 679`. There is no retract, recall or supersede for
**sent mail**. Grep finds no such path.

The measured failure: the planner authorised a commit, learned within two minutes that the
authorisation was wrong, and **could not pull it back**. The implementer acted on the stale
instruction. Nothing malfunctioned; the message was simply irrevocable once sent.

This is sharper than it looks because of how the seats behave. They are obedient and they act
on the most recent instruction they can see. An instruction that is wrong and unretractable is
therefore *more* dangerous here than in a human team, where someone would push back or wait.

Wanted: supersede a sent, unread — or read but unacted — message, so the successor sees the
correction rather than the original.

Gates:

- superseding an **unread** message means the recipient never sees the original;
- superseding a message the recipient has already **acted on** does not silently rewrite
  history — the original and the supersession both remain on the record, as checkpoint
  supersession already does;
- a superseded message cannot be acknowledged as if current;
- **the green case**: an ordinary message with no supersession is delivered unchanged. Without
  it, a "supersede everything" implementation passes the first three.

## Item 7 — claim schema: `why` is optional, so claims explain nothing

`ClaimInput.why` is `why?: string` (`src/mailbox.ts:213`) and lands as `input.why?.trim() || ''`
(`:786`). A claim can therefore be held with **no reason at all**.

Meanwhile `src/mailbox.ts:941` states the question a human needs answered is *why the holder
stopped*, and the baton path already carries a mandatory `why` on every refusal (`:978, 987,
999, 1018`). The two halves of the same system disagree about whether a reason is required —
the same shape as item 6, where two halves disagreed about a path root.

That asymmetry matters at exactly the moment it is least convenient: a seat dies holding a
claim, and the operator finds a held path with an empty string where the explanation should be.

Wanted: make `why` required at the type level and at the CLI, with a migration for existing
empty claims rather than a silent backfill.

Gates:

- a claim without `why` is refused, at the store and at the CLI;
- existing empty-`why` claims remain readable and are visibly marked as legacy, not
  retroactively invented;
- `why` survives a baton reassignment onto the inheriting seat;
- **the green case**: a claim with a reason still succeeds through the full path — claim,
  stage, hook-active commit.

## Item 8 — an acknowledgement is not a commitment

Added 2026-08-14 after **two** occurrences in one session, both with the same seat, both after
a long context-rich brief:

- acked the item 1 certification (`#1368`), then `wake-idle-skipped` — no probe ran;
- acked item 6 (`#1423`), then `wake-idle-skipped` twice — nothing reached disk.

Both times a short single-imperative message moved it immediately. That matches the rule
already recorded in `OPERATOR.md` from separate incidents, so this is the third independent
confirmation of the shape.

**This is the quietest failure mode on the bus.** `chain-exhausted` announces itself.
`provider-stalled` announces itself. An ack that produces nothing looks *identical to
progress* — received, understood, correctly acknowledged — and is only detectable by reading
the brain log or the working tree. Every instance tonight was caught by a human-driven check.

Likely the same mechanism as item 5, not a second one: **pair the ack with an outcome**, so an
acknowledgement that never produced work is countable rather than merely invisible. Decide
that after item 5's ledger lands — if it generalises, this is one more edge on it.

Gates:

- an ack followed by no action is countable without reading the brain log;
- an ack followed by real work is **not** flagged — the green case, and the one that stops
  this becoming noise;
- the counter survives a wake boundary.

## Item 6, continued — the fix took four layers and a restart

`08da916` fixed the **store**. It did not fix anything a seat could reach:

| layer | defect | fix |
|---|---|---|
| store | `claim` resolved against the bus root only | `08da916` — `repoRoot`, two claim roots |
| harness | `mailbox_claim` never passed `repoRoot` | `21ed962` — but bound it to `workdir` |
| **concept** | `workdir` is the **capability CWD** (`${workspace}` in `capabilities.json`) | `1b1765d` — separate `--claim-repo` |
| launchers | `bus-up.js` / `bus-restart.js` never forwarded the flag | `1b1765d` |
| process | harness started 14:31 ran pre-fix code until 21:56 | restart |

The middle row is the one worth remembering. `21ed962` reused `workdir` because it was the
only repo-shaped field available — but `workdir` is the cwd for `git.status`, `bus.doctor` and
the whole SKSE chain. The deployed bus runs `--workdir ai-bus`, so `repoRoot` *became* the bus
root and both claim roots collapsed to one path. **The fix compiled, tested green, and changed
nothing for any seat.** Repointing `workdir` at the repo would have silently retargeted every
capability instead.

Deployed configuration, verified after restart:

```
harness serve --root ai-bus --workdir ai-bus --claim-repo Portable-AI-Bus
```

`workdir` unchanged so capabilities still run where they did; `claimRepo` separate. That pair
of facts is gate (e) — the concepts are **split**, not the overload **moved**.

**The audit is expected to find a hole here**, and it was found before the audit ran:
`mailbox.ts:767` compares relative path strings only, and a held claim carries **no root
identity**. With two claim roots live, the same relative path exists in both — so two seats
could each hold "their" copy with neither seeing a conflict. The fix that made claiming
possible is what made that reachable.

## Item 6 — certified at `2dae2a7`, after four audits and six commits

Six commits: `08da916` → `21ed962` → `1b1765d` → `ac18943` → `0c1421b` → `2dae2a7`. Four
independent audits, each failing on something narrower than the last:

| audit | what failed |
|---|---|
| 1 | claims unsatisfiable against repo paths — the store fix reached no caller |
| 2 | **symlink**: two seats, one inode, no conflict. Planner's predicted attack (two seats, same relative path) **did not land** — the string mutex worked. |
| 3 | **hardlink**: `realpath` resolves symlinks and junctions, not hardlinks |
| 4 | **the seam**: directory coverage was path-only, so a hardlink out of tree slipped between the two identity schemes; and three persisted shapes existed of which only one spoke inode |

The repair that finally held was **one comparison** — lexical containment, observed inode
equality, and recursive inode reachability beneath directory claims — rather than a third
scheme beside the first two. Every failure on this item came from two halves disagreeing, so a
third half would have repeated it.

Migration follows the item 1 rule: rows upgrade **only after `stat` observes the inode**;
unreachable rows are left alone and `doctor` **names them as weaker** rather than inventing an
identity.

Final pass: **30 green, 0 red**, every previously-RED case refused or reported live at store,
CLI, harness, brain and hook. The auditor's defence of the design is worth keeping: *"The walk
is what joins a parent path to a child inode under a third name. Remove it and the old RED
cases return."*

**Three ambers, recorded verbatim, ruled non-blocking by the auditor:**

1. **The hook is still lexical** (`claim-guard.ts` compares path strings). Fail-closed *both*
   ways — the store refuses another seat's alias claim, and the hook refuses the holder
   committing the alias spelling. A lockout, not a sneak. Usability defect.
2. **`UNREACHABLE-PATH-BUT-IDENTITY-LIVE`** — the lexical path is gone but the stored identity
   still stats, so the hardlink is still refused while `doctor` warns "weaker/unverifiable".
   The warning overstates weakness. Diagnostic accuracy, not correctness.
3. **The outbound-junction walk has no depth cap** — split out as item 14.

The auditor resolved its own contradiction rather than leaving the inference to the planner:
*"'declined to certify because of 4 AMBER' was conservatism about the historical umbrella.
'AMBER, not grant holes' was the measurement."*

## Item 14 — an overlap check can walk an arbitrary volume

Split from item 6 on 2026-08-15 because it is a **different property**: item 6 guarantees
claims are satisfiable and mutually exclusive, and this is a resource bound.

`directoryContainsClaim` uses `statSync` (which **follows** links), `readdirSync`, and tracks
`visitedDirectories` by directory inode. Measured: **no depth cap, no `lstat`, no
stay-under-claim-root check.** So a junction pointing from a claimed tree onto another volume
makes every later overlap check walk that volume.

Measured cost, not estimated: 2500 files across 50 dirs → **246.8 ms** for an unrelated claim
while `src/` is held; 213.8 ms for the hardlink hit. About **0.1 ms per file** on this NTFS
volume, so a 100k-file tree is roughly **10 s per overlap check** — and `doctor` is O(pairs) of
those walks.

The walk itself is load-bearing and must not simply be deleted. Wanted: a bound.

Gates:

- RED first: a junction onto a large tree makes an overlap check walk it — show the cost;
- a depth or time cap, or a stay-under-claim-root rule, keeps the check bounded;
- **green**: legitimate deep trees still resolve correctly, and every item 6 case stays green —
  especially directory-vs-outside-hardlink, which is what the walk exists to catch.

## Item 3 — certified at `1948082`, after failing twice

Three audits, three commits: `4a9acc5` → `8349f70` → `1948082`.

| audit | verdict |
|---|---|
| 1 | **FAILED** — `supersedeMessage` worked at the store and **no caller could invoke it**. No CLI verb, no harness tool, no worker verb, no `BrainAction`, zero tests. Four gates green, 377 passing, feature unreachable. |
| 2 | **FAILED** — reachable now, but **T1**: `peek(#1)` → `supersede(#1 by #2)` → `acknowledge(1)` **consumed the correction**. `runner.ts` acknowledged a presented *count*; supersede mutated the positions. |
| 3 | **CERTIFIED** — `acknowledge([1])` refuses with *"message #1 is no longer current unread mail"*; the leftover inbox is the correction; green at store, harness and client. |

The repair moved the invariant to the layer that can enforce it: `mailbox.ts:481`
`acknowledge(agent, seqs: number[])` with validation, `mailbox_read` routing supplied seqs. The
first attempt changed only the signature and **could not have worked** — `mailbox_read`
consumes the head and takes no seq, so looping it N times is T1 unchanged. That attempt also
broke the build for 25 minutes (item 15).

**The negative control is what makes the pass meaningful.** `T1-FIFO-RED`: the same scenario
using `store.read()` — FIFO head instead of seqs — **still eats the correction**. The
instrument can still express the original bug.

### Why the auditor's own control nearly held the item open

The auditor initially withheld certification because **C1 was red** — already-read plus a plain
`send` also delivers the correction on the next poll, so `M1` is not unique supersede work. It
then corrected itself, and the reasoning generalises to every item on this bar:

> *"C1 is the auditor control. It is supposed to stay RED. A control that must stay red cannot
> be the thing that keeps an item open. Same shape as treating T1-FIFO-RED as a regression."*

And it ruled out the tempting fix: *"Do not open an item to turn C1 green. That would mean
plain send after consume stops delivering, which is a different and worse product."*

**A red control is the instrument working, not a defect.** Counting controls as failures would
keep every item permanently open.

**Limit, recorded, not a gate:** a seat inside a turn holds a frozen snapshot; there is no
retraction feed into a held payload (`M2` — the held object stays `{seq:1, read:true,
supersededBy: undefined}`). Agreed as a recorded limit rather than scope.

### The nine reds, triaged

Two are controls that **must stay red** (`T1-FIFO-RED`, `C1`). The other seven became items
16–19 rather than holding item 3 open — the same split that let item 6 finish. The auditor
named the one it would have argued for and then declined to argue it: *"R1 is the one I would
have argued for; I am not arguing for it."*

## Items 16–19 — split from item 3

- **16 — `actor` is optional at the store.** `actor?: string`; omit it and there is no check, so
  a direct `MailboxStore` call forges a foreign retract. CLI and harness both pass one, so the
  invocable surfaces are safe and the store is not. Gate: forged foreign retract refused **at
  the store**, not only at the edges.
- **17 — truncation is invisible.** `mailbox_inbox all:true` returned 4 of 6 as a bare array;
  `mailbox_read all:true` acked 4 and left `[5,6]`; `WakeResult` has no `hasMore` and the worker
  never reads it. `SNAP-WAKE` and `SNAP-WORKER-CURSOR` were green, so the hole is **discarded
  metadata, not a skipped seq**. Gate: truncation visible on all three, and a green case where
  an untruncated page says so.
- **18 — send and supersede are two steps.** Between `send(correction)` and `supersedeMessage`
  both messages are current. A real race, not a written gate. Wanted: atomic
  `send({ supersedes })`.
- **19 — supersede polish.** The transcript keeps both bodies without `supersededBy`/reason
  (unlike `closeCheckpoints`), and the CLI usage string at `mailbox.ts:2108` omits the verb even
  though the verb works at every layer.

### Items 16, 17, 19 — certified 2026-08-17

Auditor: grok. Author of `e43d5a8` / `d86b620` / `eb8e10f`: not this seat. Instrument:
`ai-bus/.ai-bus/runtime/grok-161719-probe.js` against compiled `dist/`, not the author's
tests. First run had two **instrument** errors (not product defects): `maxWakeMessages=1`
also capped `mailbox_inbox`; wake ran after `mailbox_read` had consumed the page. Instrument
corrected. Re-run on HEAD `bd592ed` 16/16 PASS.

**16, store (RED then GREEN):**
- omit `actor` → `Invalid actor: <empty>`
- empty `actor` refused
- foreign actor (`codex` retracting `claude`→`claude` pair) refused: *only messages it sent itself*
- mixed senders (actor matches only the replacement) refused
- **green**: same-sender retract leaves only the correction in inbox

**17, harness + worker contract (RED then GREEN):**
- `mailbox_inbox all:true` on 6 messages → page of 4 with `hasMore=true`, then 2 with
  `hasMore=false`; unread stayed 6 (inbox does not ack)
- `mailbox_read all:true` same 4 / 2 paging
- **green**: untruncated inbox reports `hasMore=false`
- wake `maxWakeMessages=1` reports boolean `hasMore=true`, next page `hasMore=false`
- `worker-client` requires `typeof value.hasMore === 'boolean'` or throws `malformed wake response`

**19:**
- transcript keeps both bodies and writes `supersededBy` + `supersedeReason`
- CLI usage lists `supersede`
- CLI verb performs a sender-authorized supersede

Author-test corroboration, not the verdict: mailbox 5/5 and harness 3/3 named tests pass.

Recorded limits, not failures: `supersede` uses `assertAgent` not `assertSeated` (send already
`assertSeated`, so a non-seat cannot mint both rows via the API); raw mailbox CLI inbox/read
do not page and therefore have no `hasMore`; worker missing-`hasMore` was contract plus
existing tests plus live harness wake, not a new omit-field mock. Full `npm test` was not
the instrument (suite hang recorded in `RESUME-HERE.md` at 2026-08-15).

Item 18 is **not** certified here. Codex still holds `src/mailbox.ts` and
`tests/mailbox.test.js` for the atomic send; this seat did not touch those paths.

## Item 8 — the mechanism, found 2026-08-15

Observed five times as "acked and did nothing". It is neither a provider fault nor a parsing
fault. **Recovery checkpoints close when the wake ends, not when the task is done.**

    runner.ts:525   closeRecovery(seat, workId, result.done ? 'done' : 'settled')
                    hasOpenWork is result.done === false

So a wake whose only action was an acknowledgement returns `done:true`, the checkpoint closes
`done`, nothing carries forward, the next wake finds no mail and idle-skips — **and the
assignment is simply gone.** Measured live on `1694`/`1702` (grok) and `1698`/`1704`/`1706`
(codex), every one closed `done` with its task not started.

**The prompt is half the bug.** The system prompt tells seats *"done ends only this wake, not
the bus goal"* — which is precisely the wrong semantics for a flag that closes durable work.
Fixing the runner while the prompt still says that would reopen the defect for the next model
that reads it carefully. Both change in one commit.

`done-requires-report.js` is **not** this gate: it forces a non-ack send before the brain may
return done, and a note saying "working on it" still closes recovery.

**And it lands inside a certified item.** PLAN-04 slice 1's crash-boundary gate proves a
durable receipt suppresses replay — that works. **Nothing proves an unfinished task stays
open.** The gate stays green while every unfinished assignment evaporates: a gate that cannot
go red for the property that matters, inside the memory system built to prevent exactly this.

The goal's own `doneWhen` already states the property — *"a wake whose only actions were acks
leaves the task open"* — and nothing at the runner implements it.

Gates:

- RED first on current `runner.ts`: an ack-only wake (and an ack-plus-note wake) leaves the
  checkpoint **open**;
- the system prompt no longer teaches `done` as wake-scoped;
- **green**: a wake that genuinely meets its gates still closes — otherwise evaporating work is
  traded for immortal work;
- **broken and exhausted must NOT close.** BROKEN is a machine failure; the work is
  untouched. Closing it discarded both live assignments on 2026-08-15 when node-pty
  vanished (`1740` reason=broken, `1722` reason=broken). Exhausted is the same class:
  credits returning does not change the task. Inherit (item 4) already closes the
  source as `reassigned to X` when a successor exists; a second close is only live
  when inherit does not run — the case that most needs retain. Parked is unchanged
  (a deliberate decision about the message). The gate that would have caught this:
  kill the provider mid-assignment and assert the checkpoint SURVIVES.

**Implemented, not certified.** The runner now inspects what was actually sent. A wake whose
only mailbox products are courtesy kinds (`ack`, `receipt`, `ping`, `note`) keeps the
checkpoint open even when the brain returns `done:true`. It does **not** set `hasOpenWork`,
so the seat does not spin another model call; the task simply survives the next idle-skip.
A `report`/`finding` (or any non-courtesy send) plus `done:true` still closes. The production
prompt in `brains/agent-seat.js` no longer says *"done ends only this wake"* and the copyable
example is now `done:false` after an ack.

The original green case *"exhausted/parked/broken still close"* was wrong and was measured
wrong: `closeRecovery(..., 'broken')` discarded `1740` and `1722` when node-pty vanished.
Broken and exhausted now retain; inherit still transfers when a successor exists. The author
does not certify it.

## Item 20 — a checkpoint can become unclosable

Measured 2026-08-15 while trying to clear a stale checkpoint by hand.

`closeRecovery` is defined at `mailbox.ts:746` and reachable **only** from `runner.ts` — the
remaining runner call site is `done`/`settled` (broken and exhausted now retain) via
`bus-client.ts:225`. There is **no CLI verb, no harness tool, no operator path**.

Consequence: a checkpoint owned by a seat with no running brain can never be closed by anyone.
The live example is `1518`, whose open row is held by the chat-interface seat after being
inherited from a brain seat that died when `node-pty` vanished. Its note still reads *"ONE
ACTION: implement item 9"* — an item certified hours earlier at `f3798fe`. It will say that
forever.

The auditor refused to close it, correctly: *"`closeRecovery(agent, workId)` only closes that
agent's open checkpoint. I will not write another seat's recovery record."*

This is the standing doctrine on the recovery path — **a capability no caller can invoke is not
implemented** — and it is the exact inverse of item 8. Item 8 closes checkpoints that should
stay open; item 20 cannot close one that should have closed.

Gates:

- an operator can close a stale checkpoint by an explicit, logged route;
- **a seat still cannot close another seat's checkpoint casually** — the refusal above is
  correct behaviour and must survive;
- **green**: ordinary runner-driven closes are unchanged.

## The suite hang — passing tests that never exit, 2026-08-15

For several hours no verification was possible, and it was **two independent faults stacked**:

1. **`npm install` wiped `node_modules/.bin`** — all 42 shims, so `tsc` vanished and every
   compile-then-test path died with `'tsc' is not recognized`. Planner-caused. Repaired by
   re-running `npm install`.
2. **`tests/process-host.test.js` passed all 22 tests and then never exited.** A leftover
   `conout` Worker survived the success-path `PtyKill` and held the event loop open. Fixed at
   `bd592ed`.

**A suite that passes but does not exit is indistinguishable from a broken one.** It made every
green unverifiable — the same disease as a gate that cannot go red, one level up, applied to
the whole test system. It also caused four wasted nudges at a seat whose work was fine.

Suite after the fix: **441 pass, 0 fail, ~40 s.**

## Item 12 — certified at `a97deaf`+`b31177f`+`ec41d92`

Audited by the planner with its own instrument (codex spent, so the auditor role moved).
Deliberately different numbers from the author's gates — those use `spawnStallMs` 80/30 with
startup delays 50/40; this probe used 25/300/20 with a **120 ms** late sibling, which is
harsher than codex's original false-negative case.

| scenario | result |
|---|---|
| late sibling 120 ms vs threshold 25 ms, busy 250 ms | breach **recorded** — the parent clock works |
| fast call 5 ms vs threshold 300 ms | nothing recorded |
| sibling dies, spawn **returns** at 200 ms vs 20 ms | breach recorded — **parent backfill** |
| sibling dies, fast call | nothing recorded |
| on-time sibling, genuine breach | breach recorded |

**5/5**, persisted readback from the ledger file each time.

Two corrections the audit made to *itself*, both recorded because they are the point:

- The first run reported two false failures. They were **pollution from orphaned watchdog
  siblings** left by earlier killed runs — not defects. Re-running on a clean machine cleared
  them.
- One expectation was simply wrong: the auditor asserted that a dead sibling means *nothing is
  recorded*. The author's claim is fail-open **only while spawn never returns**; a returning
  call is backfilled by the parent. The code was right and the probe was wrong.

**An auditor's instrument can be wrong, and a dirty machine can fake a finding.** Both happened
here, and both were caught by re-running rather than by argument.

## Item 15 — the guard verifies claims, not builds

Measured 2026-08-15 05:09. `c772aa5` changed `acknowledge(seat, count)` to
`acknowledge(seat, seqs: number[])` in `src/brain/runner.ts` and did not update
`src/brain/bus-client.ts`, which still compared the second argument with `<`:

```
src/brain/bus-client.ts(208,27): error TS2365:
Operator '<' cannot be applied to types 'number' and 'number[]'.
```

`npm test` exits **2 before running a single test**. The commit landed **with the hook active
and reporting success**, because the hook answers *"is this yours to commit?"* and nothing
answers *"does this work?"* HEAD stayed broken for over fifteen minutes while another seat
worked, with every unrelated failure hidden behind `exit 2`.

It was caught only because the planner runs the suite after every landing rather than trusting
the report.

Two things this is **not**. It is not the seat being careless — the fix as specified was
impossible at that layer (see item 3), and it stalled exactly where the impossibility lives. It
is not an argument for auto-blocking every commit: item 6 spent a whole session proving that a
guard which cannot be **satisfied** gets bypassed just as surely as one that cannot go **red**.

Wanted: a commit that does not compile does not land.

Gates:

- RED first: reproduce a non-compiling commit reaching HEAD with the hook active;
- a commit that fails `tsc` is refused, naming the error;
- **the escape hatch is explicit and recorded** — a deliberate WIP commit is possible by an
  obvious, logged route, not by silently disabling the hook;
- **green**: an ordinary compiling commit is not slowed to the point where seats start
  bypassing. If the check makes honest commits painful, it will be bypassed, and item 6 already
  taught that lesson once.

### Certified at `e28c7b5` (grok r21)

The auditor that did not write the hook certified item 15 on 2026-08-18. Instrument
`tmp-audit-r21-grok.cjs` against live `scripts/claim-guard-cli.js` blob `ea74c7b0` — identical
to `e28c7b5`; later HEAD `58d507f` is docs-only. **20 PASS / 0 FAIL / 3 NOTE.**

What the gates actually showed:

- **RED first.** A broken compile is refused (`broken-compile-refused` exit 1). The unfixed
  hook refuses an honest commit when `TMPDIR` is a link (`linked-tmpdir-unfixed-red` exit 1) —
  item 6's failure, seen red against the pre-`e28c7b5` guard by reproducing macOS on Windows
  with a junction.
- **tsc failure is named and blocked.** `files:[]` + `references` is a control: `tsc -p`
  succeeds, the hook still refuses (`files-empty-plus-references` exit 1). A commit the
  compiler never really typechecked cannot print compile OK.
- **Escape hatch is loud.** `nocheck=true` is recorded and refused as a silent disable
  (`nocheck-true` / `linked-tmpdir-nocheck` exit 1); the explicit recorded route still works
  (`escape-hatch-loud` exit 0).
- **Green is cheap enough to keep.** Honest compile on a linked tmpdir and on the real
  tmpdir both exit 0 (`linked-tmpdir-honest-green`, `honest-green`).

The r19 hole (`ebd70ec`) was a substring exemption: `comparable(real).includes(comparable(scratchRoot))`
treated `<scratch>x/index.d.ts` as inside the scratch tree. r21 still attacks the sibling
class (`nm-substring-types`, `realpath-scratch-sibling-types`, `typeroots-junction-outside`)
and those stay red-capable refusals.

The three NOTES are not leftover holes. `rootDir-junction-outside` and
`extends-symlink-outside` are attacks the compiler/git would not list or store as a symlink
on this machine — not red-capable, so they cannot certify a repair. The third NOTE is only
the HEAD identity of the docs-only tree. A VARIANT of a rule already decided is not a HOLE.

This table row was stale after r21: it still said "audit pending". The ruling is the r21
verdict, not this paragraph. This paragraph only stops the bar from lying.

## Item 9 — a detector whose only sink is a log

`scripts/bus-supervise.js:147-149` computes `staleCodeWarning`, logs it, and deliberately does
not restart. The design note in `LOOP_ARCHITECTURE.md` is right that a stale-code line must not
trigger an automatic restart. It is also insufficient: **the only sink is
`bus-supervise.log`.**

Measured: stale-code lines for both seats ran continuously from **23:07:33 to 01:51:06**, for
both brains, while three agents debugged the *symptom* — claims failing for reasons that
looked like operator error. The harness had been running seven-hour-old code since 14:31.

The system knew. It said so, into a file nobody was reading.

Wanted: a stale-code condition reaches a seat or the mailbox, not just a log. Gates:

- a stale loaded-code marker produces a signal an operator or seat actually receives;
- it still does **not** auto-restart — the existing design decision is correct and must survive
  the fix;
- **green case**: matching markers produce no noise. A warning that fires when nothing is wrong
  gets ignored, which is how this one became invisible in the first place.

**Implemented, not certified.** `scripts/bus-supervise.js` now persists the current stale set
to `.ai-bus/runtime/stale-code.json` (`autoRestart: false` is part of the record). `bus-tick`
prints `STALE-CODE <seats> - running brains predate dist; bus-restart...` on the operator wake
line. Matching markers delete the file, so the tick stays quiet. A dead seat drops its notice.

Not a mailbox send, on purpose: `send()` moves or steals the baton except on a delayed ack, and
delayed acks are skipped by the runner. Mailing this would either seize leadership or look like
progress (item 8). The tick is the surface the operator is already being woken by.

The author does not certify it. Restart the supervisor and any `bus-tick` after this lands, or
the running processes will keep writing only to the log.

## Item 10 — authorisation does not survive a wake

Measured tonight, three times with the same seat. I authorised proceeding without a claim
(`#1464`, `#1422`). Two wakes later the seat refused to edit unclaimed and asked for
clarification — **correctly**, because the authorisation was in a message its fresh session
could no longer see.

Every wake constructs a new prompt. PLAN-04's recovery checkpoint carries *what I was doing*.
Nothing carries *what I am allowed to do*. Those are different, and only the first survives.

This is also the most plausible explanation for item 8: every ack-without-execute tonight
followed a brief that referenced permissions or context from earlier messages. The seat acks
what it can parse, then finds nothing actionable and idles.

The workaround that works is discipline on the sender: **make every task message
self-contained** — repo path, files, permission, and an explicit "if this conflicts with an
earlier message, this one wins." That is a practice, not a mechanism, and practices decay.

Wanted: constraints and permissions travel with the **work**, not the conversation. Gates:

- a permission granted for a task is visible on the next wake without being restated;
- a permission that was **revoked** does not resurrect — the clearing path is tested as hard as
  the carrying, per PLAN-04 constraint 5;
- **green case**: a seat with no special permission still refuses, exactly as codex did three
  times tonight. That refusal is correct behaviour and must not be weakened by this fix.

## Ordering

Item 2 is last on purpose: consolidation built early would faithfully compress a pipeline that
was still discarding most of its long messages.

The temporal-binding slice was blocked on item 1 certification and is now **implemented,
not certified**. It rewrites `observeLifecycle` / `observeCommitDiff` / `observeRunnerResult`
so each binds a recorded event after the claim (1363 A–D). Named refusals are gone; every
kind has refusal gates and a green case. The author does not certify it.

## Standing doctrine: a capability no caller can invoke is not implemented

Established 2026-08-14 after the **same defect twice in one night**, found both times by the
seat that did not write the code.

**Item 6.** `08da916` gave `MailboxStore.claim` a `repoRoot`. `harness.ts:702` never passed
one, and `mailbox_claim` is the only path a seat has. The fix compiled, passed the suite, and
changed nothing for any seat. It took three more commits and a restart to actually reach a
caller.

**Item 3.** `4a9acc5` implemented `supersedeMessage` at the store with four gates passing and
377/377 green. There is **no CLI verb, no `mailbox_supersede` harness tool, no worker-client
verb, and no `BrainAction`** — and zero tests referencing it. A planner holding only `send`
still cannot retract an unread authorisation, which is the entire measured failure the item
exists to fix.

Both passed their own tests. Both were unreachable. **The store is not the feature.**

Consequences adopted:

- an item is not implemented until a caller at every layer can invoke it — CLI, harness tool,
  worker-client, brain action — with tests **at each layer**, not only at the store;
- the audit question is *"can the person who needs this actually do it?"*, not *"does the
  method behave?"*;
- a green suite over a store method says nothing about reachability. `377/377` was true and
  irrelevant in both cases.

The auditor's control on item 3 is the model: an already-read message plus a plain `send`
*also* delivers the correction, so `supersedeMessage` was **not** the delivery mechanism for
that case. Without that control the audit reports a pass on evidence that proves nothing —
the same shape as certifying item 1 by running the author's test.

## Item 5 — certified at `78ffe75` + `48d24f4`

Implemented as a stall ledger giving every stall a **duration and an outcome** rather than an
extra enum value. `RECENT_LIMIT=32` bounds resolved rows; unresolved stalls are retained
without limit by design, because an unresolved stall is the entire point.

Two findings the implementer made against its **own** work before certification:

- **The bound had no gate.** `RECENT_LIMIT` worked, but deleting it left all 12 tests passing.
  Fixed in `48d24f4`, seen red first by removing the splice.
- **A planner guess was wrong.** The planner speculated unbounded retention of resolved rows.
  Measurement: 505 KB at N=2000, `heapUsedDelta` 0.68 MB — resolved rows *are* bounded. The
  real cost is **rewrite**, not retention: `start()` re-reads and pretty-prints the whole open
  set. So the fix is to stop rewriting the file, not to cap or consolidate the open set. The
  earlier 40 MB figure was the implementer's own and it corrected that too.

Certification (auditor's own instrument, every result read from persisted ledger JSON):

| gate | result |
|---|---|
| bound is real, and retains the **newest** 32 | RED with the splice removed (persisted `recent=80`); production kept `n-48`..`n-79` |
| **genuine exhaustion still reports as exhaustion** | `chain-exhausted` emitted, **no** stall-start, persisted `started=0` |
| an unresolved stall survives a wake boundary | persisted `open=1`; a fresh instance after restart read `open=1`, same ID |
| a resolved stall emits **both** edges | both emitted, then `open=0`, `resolved=1` |
| **green**: normal operation is silent | zero edges, `started=0`, `resolved=0`, `open=[]`, `recent=[]` |

The exhaustion row is the one that mattered. If everything had become a stall, the ambiguity
would have moved rather than gone — and that ambiguity cost hours in both directions.

## Item 11 — a broken link reports as *spent*

Measured 2026-08-15 02:43, during an outage that stopped both seats.

After a restart, both seats reported `chain-exhausted`, handed the baton away as **"out of
providers"**, and dropped into `wake-acks-only` — emitting a dozen mechanical echo acks while
nothing worked. Neither was out of providers. The real cause was in the note field:

```
ConPTY unavailable: Cannot find module 'node-pty'  ->  link-failed  ->  chain-exhausted
```

`node_modules/node-pty` was a **shell**: `deps/`, `prebuilds/`, `third_party/`, no entry point
— a partial install, almost certainly a remnant of a bundled dependency. `require()` failed, so
every provider link failed, so the chain concluded exhaustion. Meanwhile the same provider's
CLI answered `PONG` in 3.7 s, exit 0, fully funded.

**There are three conditions, not two, and all three currently surface as `chain-exhausted`:**

| condition | truth | remedy |
|---|---|---|
| **SPENT** | no credits, 402 | reassign the seat, wait for reset |
| **STALLED** | provider slow but alive | wait — 33 of 37 resolved on 2026-08-14 |
| **BROKEN** | transport or dependency failure | fix the machine, restart |

Item 5 separated SPENT from STALLED and that certification **stands** — its gates tested what
was specified. The auditor agreed the record should narrow rather than reopen: *"Adding BROKEN
does not invalidate the item 5 gates I ran… I agree the record should say separates SPENT from
STALLED; BROKEN is not covered."*

**BROKEN produces the most confidently wrong answer of the three.** "Out of providers" is
complete, plausible, and sends an operator to check billing while a missing npm module sits
unread in the note. This is not hypothetical: on 2026-08-14 the planner attributed a seat's
behaviour to credits when it was mechanical, then to mechanics when it was a genuine 402.

Wanted: the chain distinguishes a link that **failed** from a chain that is **spent**, and
surfaces the underlying error rather than burying it in a note.

Implemented 2026-08-15 (implementer = grok, **not certified**):

- `classifyFailure` treats `Cannot find module` / `ConPTY unavailable` as `unavailable`.
  Bare `402 Payment Required` is quota, so it cannot become BROKEN or mixed.
- `classifyGiveUp` inspects the attempt vector: all quota/auth → SPENT; all unavailable or
  transport `error` → BROKEN; mixed → MIXED. Mixed does not become "out of providers".
- give-up logs `chain-broken` / `chain-mixed` / `chain-exhausted`. The broken event carries
  `error` at the top level, not only in a note.
- process-host marks ConPTY/load/spawn failures `failureKind: 'broken'`; providers no longer
  swallow that stderr.
- the agent returns `broken: true, exhausted: false` for BROKEN, so the runner does not call
  `onExhausted` and the handler cannot announce "out of providers".
- a handler that is still given a `BROKEN:` detail refuses the spent-handoff.

RED-first was measured, not inferred. Against committed `ac18943` (item 11 reverted),
`node_modules/node-pty` was renamed and a real `runProcess` + chain + `takeTurn` wake ran:

```
require: Cannot find module 'node-pty'
stderr:  ConPTY unavailable: Cannot find module 'node-pty'
failureKind: null
classified: error
chain event: chain-exhausted
wake: exhausted=true, broken=null
note: chain-exhausted:attempts=grok:error(ConPTY unavailable: Cannot find module 'node-pty' ...)
```

Same rename after the fix: `failureKind=broken`, `classified=unavailable`, `giveUp=broken`,
event `chain-broken`, wake `exhausted=false broken=true`, note `BROKEN:ConPTY unavailable:
Cannot find module 'node-pty' ...`. Module restored after both runs.

The two unexplained conditions (the 22:26 wedge, `409 lease_held` after restart) remain
unattributed. They are not this fix. They are also not the same fault as each other.

Gates:

- RED first: reproduce a link failure (rename the module) and show it currently reports as
  exhaustion;
- a dependency or transport failure reports as BROKEN, with the underlying error visible;
- **genuine 402 exhaustion still reports as SPENT** — the same regression gate that kept item 5
  honest, one layer down;
- a slow-but-alive provider still reports as STALLED;
- **green**: normal operation reports none of the three.

### Two conditions measured the same night and NOT explained

Recorded because they are real and unattributed. The auditor explicitly refused to blame
`node-pty` for either without evidence, which is the right call:

- **The wedge, 22:26–22:41.** Fourteen minutes of `provider-thinking` with **no child process
  on the machine** and ledger `open=0`. Every tracked stall that night was a *slow call that
  returned* (258–575 s, `outcome=returned`). If `stall-start` only fires from a timer inside a
  live call, a call that never really starts is invisible.
- **`409 lease_held` surviving a restart.** Both seats: *"Seat &lt;x&gt; already has a live worker
  lease"* — after the processes holding those leases were killed. Retriable, and it did retry,
  but a lease that outlives its holder deserves a look.

### Ledger author on #1538 — BROKEN is separable; the wedge is not the SHELL failure

Answered 2026-08-15 from the code, not from a new probe.

**Yes, BROKEN is separable at the point the chain gives up.** Item 5's ledger never writes
`chain-exhausted` and should not start now — spent is a fallthrough, not a stall. The
distinction is already in `attempts[]` (`reason` + `detail`). What collapses it is the
handoff copy in `createExhaustionHandler`: subject `"out of providers"` and body `"Every
provider in my chain is spent"`, regardless of why the links failed.

`classifyFailure` does not currently name the measured fault. The regex for `unavailable` is
`enoent|not found|not installed|command not found|econnrefused|unreachable`. The note was
`ConPTY unavailable: Cannot find module 'node-pty'`. That text has neither `not found` (space
required) nor any of the other tokens; `unavailable` is in the string and **not** in the
regex. So the attempt is stored as `error`, then every `error` falls through, then the handler
announces SPENT. The note already told the truth; nothing that an operator reads did.

A give-up classifier can inspect the attempt vector without a new enum in the ledger:

- every reason is `quota` / `auth` → SPENT
- every reason is `unavailable`, or `error` whose detail is transport/module/ConPTY → BROKEN
- mixed → say mixed; do not collapse to "out of providers"

Widening `unavailable` so `Cannot find module` and `ConPTY unavailable` classify as
`unavailable` is the cheap half. The expensive half is stopping the handler from lying.

This does **not** reopen item 5. The certified gates tested "slow vs spent" and "exhaustion
must not become a stall". BROKEN is a third surface on the fallthrough, not a fourth stall
outcome.

**The wedge is a second fault.** The later SHELL failure is fast: `loadNodePty()` throws,
`runConPty` returns `code: -1` immediately, the chain logs `link-failed` and gives up. That
cannot occupy fourteen minutes. The runner logs `provider-thinking`, then arms
`setTimeout(reportStall, 30_000)`, then `takeTurn`. `stall-start` does not require a child —
it requires the event loop to fire that timer. Fourteen minutes of thinking with ledger
`open=0` means the timer never ran. The SHELL `Cannot find module` path does not do that.

The signature (thinking, no child, no stall-start) is an event-loop block between
`provider-thinking` and spawn — a hung native `require('node-pty')` would fit, a missing
entry point would not. I cannot prove they are the same incident. I can prove they are not
the same code path as the measured link-failed. Separate ledger gap: **stall-start cannot
observe a blocked event loop**, because the timer lives on that loop.

`409 lease_held` after restart is a third thing. Not answering it here.

## Item 12 — a call that never starts is invisible

Observed twice as an unexplained "wedge": both seats logging `provider-thinking` for eleven to
fourteen minutes with **no provider child process** and the stall ledger reading `open=0`.
Explained on 2026-08-15 by reading node-pty rather than theorising.

**The mechanism.** `runConPty` calls `pty.spawn(node, ['-e', wrapper])`. node-pty's Windows
constructor is **synchronous**:

1. `PtyStartProcess` → `CreateNamedPipe` + `CreatePseudoConsole` → spawns `conhost.exe --headless`
2. `fs.openSync(conin)` — blocking
3. `PtyConnect` → `ConnectNamedPipe(hIn)` then `ConnectNamedPipe(hOut)` — **both blocking, no
   OVERLAPPED, return values ignored** — and only *then* `CreateProcess` of the wrapper
4. only after spawn returns: `watchProcessStall()`, `setTimeout(timeoutMs)`, `onExit`

So a block at step 3 leaves a conhost with **no child, no throw, and no timer ever armed**.
Reproduced: three `runProcess(node -e process.exit(0), timeoutMs=10000)` calls hung past 120 s,
each leaving a headless conhost, with no wrapper created. `timeoutMs` did not save it because
**spawn had not returned**.

**Two stall-starts, and neither fires.**

- The **runner's** durable ledger arms `setTimeout(reportStall, 30000)` *before* `takeTurn`, so
  it does not need a child — but it does need the **event loop**. A synchronous native block
  holds the loop, so the timer is armed and never runs. That is the measured `open=0`.
- **process-host's** `watchProcessStall` is armed only *after* spawn returns. Paths that arm
  nothing at all: `loadPty` throw (item 11), command-not-found, capture-dir failure, spawn
  throw, and spawn never returning (this item).

**A dead wire found by the ledger's own author:** `providers` never passes
`stallLedger`/`stallSeat` into `runProcess`, so process-host cannot write the ledger file *even
when spawn succeeds*. Item 5's certification stands — it tested the runner path, which works —
but this second path has never been connected. Half-updated system, again.

**A leak in the same layer, which may cause the hang.** `ClosePseudoConsole` runs only in
`PtyKill`. `finish()` kills the child only on timeout, the success-path test forbids kill, and
`_$onProcessExit` destroys sockets without closing the HPCON. So **every successful wake leaks
a conhost** — 50+ observed between 22:46 and 23:42, one per wake, none reaped. More leftovers
make `ConnectNamedPipe` more likely to wait forever.

**Item 11 stays certified.** Its RED is `loadPty` throwing → code -1 → `failureKind: broken` →
the chain gives up fast. That path cannot occupy eleven minutes and cannot create a conhost.
The auditor and the implementer agree these are different faults.

This is the same defect class as the xVASynth wedge in the Ensouled project: **a blocking call
with no upper bound**, under a comment promising a timeout. Different language, different
process, identical shape.

Gates:

- RED first: reproduce a spawn that blocks before `CreateProcess` and show nothing fires today;
- a call that never starts becomes visible — the ledger records it, or a watchdog outside the
  blocked loop reports it;
- `ClosePseudoConsole` runs on the success path; conhosts do not accumulate across wakes;
- `providers` passes the ledger into `runProcess` so the process-host path can actually write;
- **green**: normal operation still records start and resolution exactly once, and leaks nothing.

**Parent-clock remainder (not certified).** Codex #1728 showed the sibling-local
`setTimeout(thresholdMs)` is a different clock: 120 returning calls at spawn 20-40ms /
`spawnStallMs=30` left the ledger at 0/0/0. The sibling now uses
`remaining = thresholdMs - (now - parentArmedAt)` and writes immediately when remaining
is already gone. Returning calls that still miss the sibling are backfilled by the
parent. Sibling death while spawn never returns is **fail-open** — the parent is
blocked and cannot write.

**AttachConsole remainder.** Codex #1728: success-path `child.kill()` forks
`conpty_console_list_agent`, which throws `AttachConsole failed` in a headless
seat while `ProcessResult` stays 0. Not benign. `useConptyDll: true` takes the
supported kill path that still calls `ClosePseudoConsole` and never forks the
helper. RED: a real returning ConPTY call must record zero
`conpty_console_list_agent` forks.

**Stale runner rows.** `c1086c19` / `e8ebb830` / `d09e448d` were missing
`resolve` because the process died and `finally` never ran — not a clock error.
`createStallLedger` still leaves them visible (item 5 GATE D stands). A new
`runBrain` reaps only `source=runner` orphans as `abandoned` and logs
`stall-orphaned`. `source=process-host` stays open: a sibling watchdog may
still be live.

## Item 13 — a claim can be too broad to be useful

Measured 2026-08-15 04:10. A seat claimed **`.`** — the repository root — while intending to
claim the files it was about to edit. Ancestor/descendant coverage worked exactly as designed
and locked **all three seats out of the entire repository**, with no warning, no expiry, and
nothing in `doctor` to flag it. It surfaced only because the planner tried to claim a doc and
was refused.

The cause is mundane: an absolute-path claim had been refused, so the seat switched to
"workspace-relative", and an empty relative path resolves to the root.

A claim on `.` is **indistinguishable from a legitimate ancestor claim** like `src/`. Both are
correct by the current rules; one of them is a whole-repo lock. The guard has no notion of a
claim being too broad, and claims never expire.

Gates:

- a whole-repository claim is refused, or requires an explicit flag, or is flagged loudly by
  `doctor` — the implementer's call, argued rather than assumed;
- **ancestor claims below the root keep working** — `src/` must still cover `src/mailbox.ts`;
- **green**: an ordinary file claim is unaffected.

## The rule that produced every finding here

**The auditor is never the author.** Two adversarial gates: the goal is argued before a plan
exists, the plan before code.

Seats are *assignments, not identities* — any vendor can hold any role, and they rotate when
credits run out. What is fixed is the invariant, not who sits where. It held tonight without
enforcement: offered the baton and the opportunity to self-certify, the implementer refused —

> *"Running my own probes would be a heartbeat wearing a verdict."*

Every defect on this page was found by someone who did not write the code.
