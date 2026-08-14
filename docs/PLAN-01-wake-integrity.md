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

**AUDIT 03** — pending. Scope: `21a0db0` and `f4bc141`.

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

- **The envelope class** — 75 of 97 malformed events. `parsePlan` has no `undoTerminalStringWraps`;
  `extractGrokAnswer` does. All evidence is from one seat, whose provider runs through node-pty
  ConPTY — which crashed outright (`AttachConsole failed`) and killed an audit mid-flight.
- **Seat memory** — each wake is a fresh model session. Measured cost: the DELTA D, G and H briefs
  were re-sent three or four times each. Prior art: `D:\Projects\Cwars` reconstructive memory.
- **`bus-up.js:127`** hardcodes `--max-rounds 550`; it only survives because `ensureInitialized`
  takes `Math.max`. A fresh bus halts at the guard in `harness.ts:653` with mutating tools failing
  closed.
