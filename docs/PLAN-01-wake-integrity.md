# PLAN 01 — Wake integrity

Status: **OPEN**, pending grok's AUDIT 03 verdict on `21a0db0` and `f4bc141`.
Window: 2026-08-13 evening → 2026-08-14. Tests 254 → 292.

## The goal

Every mechanism here fixes one disease: **the system reporting health while what it was
running was wrong.** A seat that acked and did nothing, a brain that had stopped listening,
a wake that consumed its task and returned success — all of them looked fine from outside.

Completion bar (`doneWhen`): a wake cannot lose the work that paid for it; a seat that cannot
work says so; and no gate passes that cannot be made to fail.

## Roles

Planner `claude`, implementer `codex`, auditor `grok`. **The auditor is never the author.**
Two adversarial gates: the goal is attacked before a plan exists, the plan before it is built.
See `OPERATOR.md`.

## Deltas

| Δ | Commit | What was actually wrong |
|---|---|---|
| A.1/A.2 | `919fe38` | After vendor binding, chains are length 1, so `break` *was* exhaustion. One transient blip cost a whole wake; the failure detail was captured then discarded. |
| B/C | `fdd5e13` | `peek` made one `mailbox_inbox` call. The harness caps tool results at `MAX_TOOL_MESSAGES=4` (`src/harness.ts`), so **page two never reached the brain** — 39 messages looked like 4. |
| — | `a029fca` | Restart verification trusted leases. A lease proves a seat is *between receiving and completing a wake*, not that its brain is alive. |
| — | `4a750fe` | Rationale for the transactional wake history. |
| E | `fe6c8e9` | The agent prompt handed the model a literal `<seat>` as a copyable example. The example is now extracted from the real prompt, parsed, routed and executed by a test. |
| D | `7760970` | A continuation wake arrived with an empty inbox and **no memory of what it was continuing**, so the model reasonably returned `done:true`. `openWork` carries the note; cleared on completion and exhaustion. |
| F | `f6977dc` | Retention turned silent loss into an infinite retry loop. Messages now park after a bounded per-message budget, recoverable via `mailbox requeue`. |
| G | `86adbb9` | `runner.ts` committed mail whenever `retainMessages` was not true, **regardless of `done`** — so a valid plan whose actions failed consumed its mail. Boundary moved from successful *parsing* to successful *action completion*. |
| I | `21a0db0` + `873df45` | Fail-fast was intra-wake only: across wakes, already-delivered sends **replayed**. Per-message committed-action journals fix it. Blocked work got its own bound (`maxBlockedAttempts`) — the 30s backoff was a throttle, not a terminator. |
| H | `f4bc141` | A brain restarted inside the 60s lease window retried listen 3× in 10s, gave up, and sat **alive and deaf** while the supervisor saw a healthy process. Recovery window now derives from `DEFAULT_LEASE_STALE_MS`. |

## Audit verdicts

**AUDIT 01** corrected the *planner*: the double-encoded envelope was never the defect —
`0223633` already unwrapped to depth 12. The plan item was wrong and produced fixture work
that proved nothing.

**AUDIT 02 refused to close the goal.** It found the cross-wake replay (`sends=2` on a
two-wake probe) and the unbounded blocked loop (`providerCalls=5, parked=0`), and caught a
**vacuous test**: reverting `retainMessages` out of `actionFailureResult` left the runner test
green, because its stub brain already returned the flag. It also characterised 98 malformed
events — **only one** came from the `<seat>` placeholder; 75 are CLI envelopes reaching
`parsePlan` un-unwrapped, 19 are the model answering as a chat assistant.

**AUDIT 03** — never delivered. The auditor's transport failed repeatedly (5 `malformed-plan`,
4 `error-retrying` after the 10:14 restart) and the audit reached attempt 2 of 3 before it would
have been parked as poison. **The goal could not close because the auditor could not report, and
the next goal could not be chosen because the auditor could not vote** — both blocked by the
envelope/transport class itself. That deadlock is the strongest evidence we have for what to fix
next, and it decided the goal round against the planner's own ranking.

**AUDIT 04** — `claude` assignment, worktree `.ai-bus/claude-audit-04-wt`, HEAD `f4bc141`,
baseline 292/292. Method: surgical revert, observe red, restore.

| revert | test that went red |
|---|---|
| `retainMessages` on the genuine action-failure path (`agent.ts`) | `DELTA I: real agent retains failed mail and does not replay a committed send across wakes` |
| `attempts >= maxBlockedAttempts` → unreachable (`runner.ts:286`) | `DELTA I: blocked work escalates after its separate bounded retry budget` |
| replay guard `completedActionIds?.has(id)` (`agent.ts:441`) | `DELTA I: real agent retains failed mail and does not replay a committed send across wakes` |
| lease-derived recovery window (`bus-client.ts:155`) | `DELTA H: lease-held listen retries past lease expiry and then succeeds` |

Worktree restored clean; baseline green again at 292/292. The vacuous test AUDIT 02 found is
genuinely repaired: the identical revert that once left it green now fails it.

**Stated limit on this audit.** The `claude` assignment wrote the briefs that specified these
behaviours. It did not write the implementation, so the auditor-is-never-the-author invariant
holds — but it is *less* independent than an audit by an assignment with no hand in the design.
What was verified is that each gate can be made to fail and that the tests bind to the right
mechanisms. What was **not** re-run is AUDIT 02's live probes against the new build
(`sends=2`, `providerCalls=5, parked=0`); those behaviours are now asserted by tests, which is
not the same as re-measuring them in production.

## Verdict

**PLAN 01 closes** on the code, with the limit above recorded rather than argued away.

## Design decisions that survived challenge

- **PID-based lease release rejected.** A PID is not a liveness identity; `a029fca` settled that
  a lease proves activity, not existence. Restart-burst reset with a lease-sized cooldown was
  used instead, so exit-on-deafness cannot permanently spend the supervisor's 5-restart budget.
- **Time-based claim expiry rejected.** It reintroduces two-writer corruption during a
  legitimately long wake. Doctor warnings keyed to claim age plus a non-working holder instead.
- **Blocked ≠ poison.** A claim conflict is temporary by construction. If it spent poison
  attempts, a valid task arriving at busy moments would eventually be parked as poison.
- **Fail fast, do not replay.** Retrying a partially executed plan re-sends actions that already
  succeeded. This was a defect in the *planner's* instruction, caught by the implementer.

## Known open

- **The envelope class.** Two claims that stood here were **wrong**, corrected by the auditor's
  recovered design (see below):
  - *"`parsePlan` has no `undoTerminalStringWraps`; `extractGrokAnswer` does"* recited AUDIT 01 and
    stopped being true at `e7dff47`. Verified: `agent.ts:226` is
    `planFromJsonStream(undoTerminalStringWraps(trimmed))`. The running tree is the **opposite** of
    that sentence, deliberately.
  - *"75 of 97"* conflated classes. True leaked envelopes at AUDIT 02 were **63** (31 pretty + 29
    escaped + 2 cli-stderr + 1 placeholder). The 12 bare-plan-prefix and 3 empty-cancelled are
    different classes.
- **The corruption is in the transport, not only the wrapping.** Events 99 and 100 (53,361 and
  56,454 bytes, snapshotted to `.ai-bus/malformed-event-{99,100}-*.txt`) show raw CR/LF inserted
  **inside quoted strings at a 123-byte interval**, first wrap always at offset 4683. After
  `undoTerminalStringWraps` removes 744 CR/LF bytes, `JSON.parse` still fails on odd-backslash
  damage around `C:\\Users` — 8 wraps land immediately after a backslash. A dangling-slash heal was
  written and run against both originals: it does not recover them. **These documents are not
  parser-recoverable, and inventing bytes is not a parser.**
- **The 19 prose events are a provider-flag problem that is already fixed.** They are the oldest
  slice; `5d1a710` added `PLAN_SCHEMA` and `--json-schema`, and the log switches from prose to
  envelopes after it. Not a parse branch, not a retry.
- **Seat memory** — each wake is a fresh model session. Measured cost: the DELTA D, G and H briefs
  were re-sent three or four times each. Prior art: `D:\Projects\Cwars` reconstructive memory.
- **`bus-up.js:127`** hardcodes `--max-rounds 550`; it only survives because `ensureInitialized`
  takes `Math.max`. A fresh bus halts at the guard in `harness.ts:653` with mutating tools failing
  closed.
