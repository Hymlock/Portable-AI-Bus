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

---

# PLAN 02/03 — the transport outage (same day, afternoon)

Closing PLAN 01 did not leave a working bus. Fixing the wake path exposed a second class of fault
below it: **every provider call was being mangled or stalled by the process transport.** All of it
was mechanical, and none of it was model behaviour — which matters, because the seats had been
blamed for it all day.

| commit | what was actually wrong |
|---|---|
| `221eafe` | `pty.spawn` used `cols:120, rows:40`. ConPTY passes bytes cleanly until output fills the **visible screen buffer** (120×40 = 4800), then scrolling injects CR/LF every 122 bytes — *inside quoted JSON strings*. grok's 53 KB, 56 KB and 60 KB reports were shredded; its 163-byte acks always arrived. Data moved off the PTY to a file; ConPTY kept only as process host so console grandchildren stay hidden. |
| `5367202` | A dead child was not detected, so it cost the full 600 s backstop. Now 180 ms, while a genuinely slow 3 s child is still not reaped early. |
| `526a587` | Wrapper commands (`.cmd`/`.ps1`) could not launch at all: the capture wrapper called `child_process.spawn` with no `shell`, which Node has refused for `.cmd`/`.bat` since the CVE-2024-27980 fix. Returned 255 in ~118 ms. |
| `71d2ae3` | grok's CLI was **upgraded**. `-p` is an alias for `--single <PROMPT>` and consumes the next token, so the schema must precede it. Without a headless flag the CLI opens its Build TUI and waits for keystrokes until the backstop. |
| `b13e734` | PowerShell 5.1 mangles embedded double quotes passing to a native exe, so `--json-schema` arrived as `{type:...` and was rejected at column 2. Wrappers now launch through `cmd.exe /c` with `\"` escaping. |
| `a1931d1` | Message bodies were silently truncated at 4,000 chars when the wake prompt was built. Now marked with the omitted byte count and the durable mailbox path. |
| `64b3d45`, `81809dc`, `f853181` | The prompt-budget ceiling; see below. |

## The diagnosis that was wrong three times

Recorded because the pattern cost more than any single bug:

- **"The `<seat>` placeholder explains the malformed events."** It explained **one of 98**.
- **"The supervisor wedged for six hours."** It had not; a planner tool call was blocked on a
  permission prompt and nothing was being sent.
- **"We hand every provider a TTY, so CLIs start interactive."** Measured: `isTTY=undefined`.
  Retracted before it caused a transport rewrite.
- **"The argv ceiling took both seats off the bus."** The ceiling is real and reproducible at 40,000
  characters, but sampling the live processes gave command lines of 4,735 and 5,545 bytes. Withdrawn
  in `81809dc`.

Two were right (the viewport, the CLI upgrade); two were wrong. Every correction came from running
the thing and reading the bytes, never from further reasoning.

## AUDIT 06 — planner-as-auditor, and what it found

grok's balance was exhausted (`402 Payment Required`, confirmed once its arguments finally reached
the API), so the auditor assignment moved to `claude`. **Less independent than grok's would have
been, and recorded as such.** Method: surgical source-only reverts, tests kept.

A first attempt used `git revert`, which removed each fix **and its tests together** — green proved
nothing, and the test count dropping 312 → 310 is what exposed it. `git checkout <commit>^ -- <src>`
is the method.

- `b13e734` and `71d2ae3` — **real gates.** Reverting either source file fails a specific test.
- `64b3d45` — **no gate at all.** Reverting 12 KiB → 32 KiB left the suite green, because every
  truncation test used a body larger than any candidate limit.
- Writing the missing gate **failed at 12 KiB**, revealing that the limit is per *field* while a
  wake carries both a message and open work: a saturated prompt reached ~24.6 KB. Now **8 KiB**.
- Two truncation tests asserted `/8 UTF-8 bytes omitted/` while the true count at 12 KiB was
  `20488` — which contains that substring. **Passing by regex accident.**
  `WAKE_FIELD_LIMIT_BYTES` is now exported and the expectation derived.

## `760c17c` — stalled calls no longer starve delivery

A brain would report `provider-chain: healthy`, then a real call would run long and the seat would
**receive nothing** until the backstop. Unread climbed 5 → 6 → 7 while the seat reported `grok=ok`.
Every "deaf brain" restarted on 2026-08-14 was this, and it was misdiagnosed three times before it
was measured.

Fixed by running a cursor-based, abortable receive lifecycle alongside each provider wake, with
distinct `seat-listening` / `provider-thinking` / `provider-stalled` / `provider-exited` / late-mail
events so a healthy provider chain can no longer masquerade as participation. **316 tests.**

The hazard attached to the approval held: acknowledgement still commits **exactly the batch
presented before the model call**, so mail arriving during thinking stays unread for the next wake.
Fixing deafness by reintroducing silent loss was the obvious way to get this wrong.

**Audit status: INCONCLUSIVE, and recorded as such.** Reverting all three source files made the
suite **hang past ten minutes** rather than fail with a red assertion. A hang is consistent with the
gate binding — a delivery test waiting forever for mail that never arrives is the defect reproducing
— but it is **not** a red assertion and is not claimed as one. Codex's own RED evidence and 316 green
stand; independent revert-to-red on this commit was not achieved.

Two process notes from that attempt, both mistakes worth not repeating:

- **The revert was done in the LIVE TREE.** When the command timed out, three reverted source files
  were left staged. It was caught on the next check and restored, but a crash at that moment would
  have left the repo silently broken. grok used a **git worktree** for exactly this reason.
- **A hang is a worse failure mode than a red.** It costs ten minutes and proves less.

## Still open

- **grok is out of credits**, not broken. Nothing here restores it; every technical fault it was
  blamed for is fixed. Its own "I am out of providers" message was correct about its state and
  wrong about its evidence, and the planner dismissed it.
- **A stalled provider call starves the listen loop** — a seat that cannot answer also cannot
  receive, and accumulates unread work while reporting a healthy provider chain.
- ~~A restarted brain does not drain retained mail until new mail arrives.~~ **WRONG — this defect
  did not exist.** The implementer checked before building and found the drain-before-listen
  implementation already satisfied both directions, then added the regression coverage instead of
  inventing a source rewrite (`bc94e5a`, 318 tests). What was actually observed — codex holding 3
  unread at 11:29 and grok 5 at 12:13 — was the **starvation bug** (`760c17c`): those brains were
  wedged in stalled provider calls and never reached the listen loop at all. One defect, two
  symptoms, filed as two bugs by the planner.
- **`node-pty` is fragile under concurrent `npm install`** — destroyed three times in one day via
  `EBUSY` on `conpty.node`, leaving a half-deleted module and "ConPTY unavailable" on every call.
  Stop the brains, remove `node_modules/.node-pty-*`, then install.

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
