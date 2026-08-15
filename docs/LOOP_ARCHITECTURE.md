# Why the loop keeps breaking, and the fix that already exists

*(2026-08-09. Hymlock: "We have to stop the loop breaking because the agents are having to
report in the chat window, which apparently requires them to stop whatever they're doing at the
end of the report." That diagnosis is correct, and the fix is in his own Star Slug harness.)*

## The actual cause

Portable-AI-Bus currently coordinates **chat sessions**. A chat session's unit of work is a
*turn*, and a turn ends when the agent finishes speaking. So:

> **Reporting and stopping are the same act.** An agent cannot say "here is what I found" and
> keep working, because saying it *is* the end of its turn.

Every stall this project has diagnosed follows from that, and no amount of listener policy fixes
it. A listener keeps the *seat* attended; it does not stop the *turn* from ending. We proved
that today — my listener was live and I still went silent, because silence was the turn boundary,
not a lapse.

## The fix, already built and running in `Star Slug`

`Star Slug/.harness/` runs LLM players that **do not have turns**. Three pieces:

### 1. `lib/brains/claude.js` — the model is driven by API, not by a chat window

```js
const Anthropic = require('@anthropic-ai/sdk');
const { SYSTEM_PROMPT, TOOLS, executeTool, screenshot } = require('./contract');
const MAX_ACTIONS_PER_WAKE = 30;
```

A **manual agentic loop** against the Messages API. The process owns the loop, so "reporting" is
just a tool call or a log line — it ends nothing. Bounded by `MAX_ACTIONS_PER_WAKE` rather than
by a conversation.

### 2. `lib/seat-wakes.js` — the agent sleeps and is woken by events

```js
const WAKE_REASONS = new Set([
  'turn', 'chatMention', 'dialog', 'reactionWindow',
  'tradeResponse', 'gameOver', 'removedFromRoom'
]);
```

`waitForWake()` blocks; `pullSeatNotifications()` drains. **The agent is a long-lived process
that idles and resumes** — exactly what our `listen` gives a *seat*, but here it gives the
*agent*, which is the part that matters.

### 3. `lib/brains/contract.js` — provider-neutral tools, including real UI control

`observe`, `legal_actions`, `act`, **`look` (screenshot)**, **`click` / `click_at`** via
Playwright. The screenshot and window-manipulation tooling Hymlock remembered is here, and the
contract is explicit that screenshots are for *verification*, with a structured `observe` as the
primary sense — the same "facts over guesses" principle as `docs/advanced-systems.md`.

The brain contract is one method:

```js
async takeTurn(context) -> { done: boolean, capped?: boolean }
```

Provider adapters translate; game-facing logic stays neutral. `scripted.js` is a deterministic
brain for testing — the fake-LLM tier, arrived at independently.

## What Portable-AI-Bus already has, and what it is missing

| Piece | Bus today | Star Slug |
|---|---|---|
| Durable mailbox, claims, baton | ✅ better | — |
| Wake signal | ✅ `listen`, wake-on-exit | ✅ `waitForWake` |
| **A runner that owns the loop** | ✅ `brain/runner.ts` (**built** — see below; this row read "missing" for a day after it shipped) | ✅ `llm-player.js` + brains |
| Provider adapter | ◐ `vscode-lm-worker.ts` (VS Code models only) | ✅ direct SDK |
| Bounded work per wake | ✅ `maxTurns` | ✅ `MAX_ACTIONS_PER_WAKE` |

**`runVscodeLmWorker` is 80% of the answer already** — a bounded agentic loop with bus tools and
no chat window. Its limits: it only reaches models exposed through `vscode.lm`, it is invoked by
a command rather than run as a daemon, and it exits after `maxTurns` rather than sleeping until
the next wake.

## BUILT 2026-08-09 — `src/brain/`

Hymlock approved the direction, so this is no longer a recommendation. What shipped:

| File | Role |
|---|---|
| `brain/contract.ts` | `takeTurn(context) -> {done, capped}`, neutral `BrainTools`, `WakeContext` |
| `brain/runner.ts` | **the wake loop** — drain, wake, act, loop. Never exits on `done` |
| `brain/bus-client.ts` | binds the runner to the harness **in process**, via `waitForMailbox` / `callSeatTool` |
| `brain/cli.ts` | staged as `.ai-bus/bin/brain/cli.js`; long-lived wake runner plus echo brain |
| `brains/agent-seat.js` | packaged project-neutral brain with seat/vendor identity enforcement |

```bash
node .ai-bus/scripts/bus-up.js --root . --console grok
```

`--root` locates coordination state; provider processes use it as their worktree unless
`--workdir <repository>` is supplied. This matters for a shared/central Bus: a brain can receive
mail from one root while its model inspects and edits a different checkout.

### The one property everything else serves

`WakeResult.done` means **this wake's work is finished**. It does *not* mean the agent is
finished, and the runner must never treat it that way. That is stated on the type rather than
in a comment, because conflating the two IS the chat-session bug.

A request for user clarification is also not goal completion. The brain sends the question,
records the open dependency, finishes only the current wake, and resumes when an answer arrives.

Proved by sabotage: reintroducing `if (result.done) break;` turns **three tests red**, including
`a brain reporting done does NOT end the runner`. A regression guard that has never been red is
decoration.

### Verified live on the real bus

```
brain-loaded    {brain: echo}
wake-complete   {reason: startup, done: true}
claude inbox    from hymlock: "echo #159: brain smoke 2"
process         STILL ALIVE after echoing
```

It woke on mail, reported, and kept running — which is the thing a chat session cannot do.

### Other properties, each with a test

- **Drain before listening.** `listen` returns instantly while mail is unread and only holds a
  lease while genuinely blocked, so a listen-without-drain loop spins, exits, and leaves the
  seat unattended *while reporting success*. This project hit that twice; the runner now makes
  it structurally impossible.
- **A throwing brain does not kill the process.** One bad message must not become a dead seat.
- **A per-wake budget caps a runaway brain without ending it.**
- **Graceful stop** on SIGINT/SIGTERM, with `brain.stop()` called.
- **Echo-on-receipt is the default brain's behaviour**, so a seat is never silent by accident.

### Wake delivery is a transaction

For transactional clients the runner peeks the oldest unread message without consuming it,
presents it to the model, executes the plan, and acknowledges the message only after a usable
result. `retainMessages` aborts that commit boundary. This is why one sequence can appear in
several wake records without being a second send.

Unusable results consume a per-message poison budget and eventually park the original record.
Claim conflicts are different: the action executor reports them as retriable `BLOCKED`, the
runner backs off, and `maxBlockedAttempts` advances without touching the poison counter. Either
limit can park a record so FIFO delivery is no longer wedged; parking preserves the record and
reason for explicit operator requeue.

Successful actions before a later refusal enter a process-local committed-action journal keyed
by message and stable action identity. Retrying retained mail skips those entries, preventing a
second send or mutation. Committing or parking the message settles the journal.

`done: false` creates `openWork`, which is supplied to immediate continuation wakes even after
the assigning message has committed. This state deliberately belongs to the running process:
completion/exhaustion clears it, and a RESTART drops it rather than pretending volatile model
context is durable.

### A live process must also be able to hear

Listen failures back off and retry through a complete lease-stale interval, allowing a restarted
brain to wait out its predecessor's lease. Terminal failure or exhaustion of that recovery
window exits the process. The supervisor can then replace it instead of accepting an alive but
deaf brain as progress. Restarts are burst-bounded, followed by a lease-length cooldown and a
fresh burst; this avoids both hot loops and permanent abandonment.

The supervisor also compares each live brain's loaded-code marker with the current dist tree.
A `stale-code` line is evidence that a process predates the build, but it never triggers an
automatic restart: liveness supervision does not guess whether an operator wants a code rollout.
The same condition is persisted to `.ai-bus/runtime/stale-code.json` and repeated on the
`bus-tick` line, because a warning that lives only in `bus-supervise.log` is a detector whose
only sink is a file nobody is reading.

### Supervisor now built

The original reachability gap is closed by `scripts/bus-supervise.js`: a crashed process is
detected and replaced under the bounded burst policy above. The runner still cannot survive its
own process being killed; recovery belongs to the independently running supervisor.

## Original recommendation (kept for the reasoning)

**Stop running the three of us as chat sessions.** Run each seat as a brain process:

1. Generalise the brain contract from Star Slug — `takeTurn(context)`, neutral tools, adapters
   per provider. It is proven and it is Hymlock's.
2. Make the loop **wake-driven rather than turn-driven**: block on `listen`, drain, act, report
   via mailbox, loop. Never exit on "finished reporting".
3. Keep `scripted.js`'s descendant as the deterministic brain, so the runner is testable without
   spending tokens — the same argument decision #23 settled for Ensouled's golden path.

The mailbox, claims, baton and lease machinery all survive unchanged. What changes is **who runs
the agent**: a process we own, instead of a chat UI whose turn boundary we cannot control.

> **Historical caveat (since resolved).** At recommendation time a crashed process was still a
> dead seat. `scripts/bus-supervise.js` now owns that separate recovery boundary; the caveat is
> retained here because it explains why supervision is intentionally outside the runner.

---

## Provider chains — same-vendor transport failover without identity fraud

The Bus can continue through other funded seats when one vendor is exhausted. The exhausted
seat itself must not impersonate another model: Grok remains xAI, Codex remains OpenAI, and
Claude remains Anthropic.

`resolveProvider` let a seat **choose** a provider. That was not enough — a seat still dies when
its one provider is exhausted. `resolveChain` lets a seat **degrade**:

```ts
const provider = resolveChain([
  { kind: 'cli' },                     // subscription, costs nothing extra
  { kind: 'api' },                     // ANTHROPIC_API_KEY, if present
  { kind: 'exec', exec: { command: 'other-vendor-cli', args: ['-p', '{prompt}'] } }
]);
```

A Claude seat may use several Anthropic authentication transports. Cross-vendor chains remain a
library capability for explicitly neutral callers, but the packaged named-seat brain rejects them.

### Two distinctions that carry the design

**`exhausted` is not `isError`.** A bad answer and *no providers left* look identical unless you
separate them — and if they were the same, a seat with nothing left would look like a seat
having a bad day, and the baton would never move. `exhausted: true` is the signal that should
trigger `reassignBaton`.

**An empty answer is a failure.** A silent success and a broken provider are indistinguishable
downstream, and misreading silence is the mistake this project has made repeatedly.

### Falling through is constrained by seat identity

Within an allowed same-vendor chain, classified failures may advance to the next transport.
When that vendor is exhausted, the seat reports exhaustion and can hand off the baton to another
seat. It never silently consumes that other seat's wallet.

Twelve tests, and the fall-through was **verified by sabotage**: replacing it with `break` turns
three of them red.

The packaged brain validates every configured provider kind against the seat's vendor and fails
closed on a mismatch. Tests cover all three defaults and adversarial cross-vendor overrides.
