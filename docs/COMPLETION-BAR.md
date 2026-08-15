# The bus completion bar

What "the bus is finished" means, item by item. Written down on 2026-08-14 because until
then the bar lived only in a chat context — two of these items exist *only* because an audit
failed, and losing that would mean re-deriving them by failing the same way twice.

Status values are deliberately harsh. **Implemented is not certified.** An item is done when a
seat that did not write it has attacked it and said so on the record.

| # | item | status |
|---|---|---|
| 1 | verified evidence memory | **CERTIFIED** at `ab9807a`; temporal binding **CERTIFIED** at `606d49d` |
| 2 | consolidation of an assignment's episodes | open — deliberately last |
| 3 | supersede a sent message | store done `4a9acc5`, **FAILED audit** — no caller can invoke it |
| 4 | cross-seat reassignment | **CERTIFIED** at `c755a42` (2026-08-14) |
| 5 | distinguish *stalled* from *spent* | **CERTIFIED** at `78ffe75`+`48d24f4` — separates SPENT from STALLED; **BROKEN not covered** |
| 11 | a broken link reports as *spent* | open — measured 2026-08-15 |
| 6 | claim guard — claims unsatisfiable against repo paths | **fixed** across `08da916`+`21ed962`+`1b1765d`, deployed, audit running |
| 9 | a detector whose only sink is a log | open — measured 2026-08-14 |
| 10 | authorisation does not survive a wake | open — measured 2026-08-14 |
| 7 | claim schema — `why` is optional | open — specified below |
| 8 | an ack is not a commitment | open — observed twice on 2026-08-14 |

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

## The rule that produced every finding here

**The auditor is never the author.** Two adversarial gates: the goal is argued before a plan
exists, the plan before code.

Seats are *assignments, not identities* — any vendor can hold any role, and they rotate when
credits run out. What is fixed is the invariant, not who sits where. It held tonight without
enforcement: offered the baton and the opportunity to self-certify, the implementer refused —

> *"Running my own probes would be a heartbeat wearing a verdict."*

Every defect on this page was found by someone who did not write the code.
