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
| **A runner that owns the loop** | ❌ **missing** | ✅ `llm-player.js` + brains |
| Provider adapter | ◐ `vscode-lm-worker.ts` (VS Code models only) | ✅ direct SDK |
| Bounded work per wake | ✅ `maxTurns` | ✅ `MAX_ACTIONS_PER_WAKE` |

**`runVscodeLmWorker` is 80% of the answer already** — a bounded agentic loop with bus tools and
no chat window. Its limits: it only reaches models exposed through `vscode.lm`, it is invoked by
a command rather than run as a daemon, and it exits after `maxTurns` rather than sleeping until
the next wake.

## Recommendation

**Stop running the three of us as chat sessions.** Run each seat as a brain process:

1. Generalise the brain contract from Star Slug — `takeTurn(context)`, neutral tools, adapters
   per provider. It is proven and it is Hymlock's.
2. Make the loop **wake-driven rather than turn-driven**: block on `listen`, drain, act, report
   via mailbox, loop. Never exit on "finished reporting".
3. Keep `scripted.js`'s descendant as the deterministic brain, so the runner is testable without
   spending tokens — the same argument decision #23 settled for Ensouled's golden path.

The mailbox, claims, baton and lease machinery all survive unchanged. What changes is **who runs
the agent**: a process we own, instead of a chat UI whose turn boundary we cannot control.

> **Honest caveat.** This does not make an agent immortal — a crashed process is still a dead
> seat, and today's reachability gap stands: an agent that dies is unreachable by any means the
> bus provides, because the route to it runs through the dead thing. A supervisor that restarts
> a dead brain is a separate, smaller piece of work, and worth doing at the same time.
