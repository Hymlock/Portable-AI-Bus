# Portable AI Bus: Plain English Guide

## What this is
Portable AI Bus helps you coordinate **more than one AI coding assistant** on the same repository without them silently overwriting each other.

It stages a small control kit into the repo (`.ai-bus/`) and gives you:

1. **Shared workflow files** — plan, handoff, review, status
2. **A mailbox** — durable messages and path “claims” between agents
3. **Optional advanced tools** — a local harness server and build adapters (for example SKSE)

It does **not** create a magical always-on multiplayer AI chat. Someone (you, or an agent session you already started) still has to act on the next message.

## Normal human path
1. Install or F5-run the extension.
2. Open your project folder.
3. In VS Code Chat, talk to **`@ai-bus`**.
4. Say **`initialize the bus for this repo`**.
5. Start a task, watch status, and point each AI at the handoff docs + mailbox.

You can do the same from the Command Palette: search for **Portable AI Bus**.

## The files you will see
After initialize:

- `.ai-bus/` — the portable kit (keep it; it is the local brain of the bus)
- `docs/ai-plan.md` — the plan
- `docs/ai-handoff.md` — exact instructions for the implementer
- `docs/ai-review.md` — review feedback
- `docs/ai-status.md` — where the workflow is right now
- Standing orders for each assistant, for example:
  - `AGENTS.md` (Codex)
  - `CLAUDE.md` (Claude Code)
  - `GROK.md` (Grok / Kilo)

## Mailbox in plain terms
Agents can leave each other notes that survive reloads:

- **Send** a message to `codex`, `claude`, or `grok`
- **Read** their inbox
- **Claim** a file or folder while they edit it
- **Release** the claim when done

If two agents claim overlapping paths, the second claim is refused. That is intentional.

There is also a configurable **halt policy** so two bots cannot congratulate each other forever and so review checkpoints can be intentional. Four triggers are available:

| Trigger | Default | What happens |
|---------|---------|--------------|
| Hard `maxRounds` cap | 32 | The triggering message is saved, then the bus halts |
| Explicit rounds | none | Halt after selected rounds such as 6, 12, and 20 |
| Every N rounds | off | Halt at recurring checkpoints such as every 12 rounds |
| Structured completion | step: continue; goal: halt | Record a summary and evidence, then apply the matching policy |

Use Command Palette → **Configure Round, Step, and Goal Halting**, **Record Step Completion**, or **Record Goal Completion**. Completion is never guessed from ordinary model prose; someone must record it explicitly. **Resume Workspace Bus** clears the current halt but preserves the configured policy and history. If the hard round cap caused the halt, add more rounds with the mailbox CLI before sending again.

### Commands humans use
- `@ai-bus mailbox status`
- `@ai-bus inbox for grok`
- Command Palette → **Mailbox Send / Claim / Release**

### Commands agents use
```bash
node .ai-bus/bin/worker-client.js status --root . --seat grok
node .ai-bus/bin/worker-client.js read --root . --seat grok --all
node .ai-bus/bin/worker-client.js send --root . --seat grok --to codex --kind note --subject "..." --body "..."
node .ai-bus/bin/worker-client.js claim --root . --seat grok --paths src/foo.ts --why "fixing bug"
node .ai-bus/bin/worker-client.js release --root . --seat grok --paths src/foo.ts
```

These commands require the harness and the matching seat credential. They prevent a seat from pretending to be another agent. The raw `mailbox.js` commands below are operator controls:

```bash
node .ai-bus/bin/mailbox.js configure-halting --on-step false --on-goal true --at-rounds 6,12 --every-rounds 12
node .ai-bus/bin/mailbox.js complete-goal --agent operator --summary "Goal verified" --evidence "npm test,VSIX smoke"
node .ai-bus/bin/mailbox.js resume --add-rounds 12
```

## Suspend, resume, remove
- **Suspend** — put the overlay away; state stays under `.ai-bus/runtime/`
- **Resume** — bring the overlay back
- **Remove** — uninstall the bus from this repo (including the local `.ai-bus` copy)

Existing project files are not adopted merely because their names match a template. The bus records only files it created, keeps destructive ownership evidence outside the repository, preserves customized files on removal, and refuses unsafe symlink/junction paths or conflicting files created during suspension.

If this VS Code window started a harness, Suspend and Remove stop that owned harness first. Closing the extension or removing the workspace folder does the same. The extension does not stop a harness owned by another window or one you started separately in a terminal.

## Providers
The bus can detect which assistants you already use (markers like `AGENTS.md`, `CLAUDE.md`, `GROK.md`, `.kilo`).

If it is unsure, it installs the recommended set: **Codex + Claude + Grok**.

You can force the list in settings: `portableAiBus.providers`.

You can assign planning, implementation, and review independently with `portableAiBus.workflow.plannerSeat`, `portableAiBus.workflow.implementerSeat`, and `portableAiBus.workflow.reviewerSeat`. These are seat IDs, not required model brands.

## Optional: Language Model worker inside VS Code
There is a command **Run Language Model Worker**. It is:

- **Off by default**
- Started **only when you run it**
- Limited to a small number of turns and an allowlisted tool set

It uses whatever models VS Code already exposes through its language-model API.
**Unify** (or any other model provider extension) is **optional** — install it if you want those models; Portable AI Bus does not require it and does not store its secrets.

Important: this is **not** “send requests forever in the background.” There is no supported autonomous background `sendRequest` loop.

## Optional: Harness (advanced)
Operators can start a local server:

```bash
node .ai-bus/bin/harness.js serve --root .
```

It only listens on your machine (`127.0.0.1`). Agents authenticate with tokens stored in your user profile (not in the git repo). Details live in `OPERATOR.md`.

You can also manage it from the Command Palette:

- **Portable AI Bus: Start Harness**
- **Portable AI Bus: Stop Harness**
- **Portable AI Bus: Show Harness and Worker Status**

The optional `portableAiBus.harness.autoStart` setting is off by default. It applies only when an initialized, non-suspended trusted workspace opens.

Agents that should sleep until mail arrives (with the harness running) can use the staged worker client instead of spinning on the mailbox alone:

```bash
node .ai-bus/bin/worker-client.js wait --root . --seat grok
node .ai-bus/bin/worker-client.js watch --root . --seat grok
```

Watch cursors survive restarts outside the repository and are reset when the mailbox epoch changes. Delivery is at least once, so a worker should use request IDs or other idempotency keys for side effects that could be retried after a crash.

`wait` acquires a worker lease, performs one long-poll, and releases it. `watch` keeps a lease renewed, remembers the last message sequence, and reconnects after a harness restart until you stop it. It is provider-neutral and does not depend on a particular model vendor.

A lease means only “this authenticated client contacted the harness recently.” It does **not** prove the AI is thinking, making progress, or obeying the message. It cannot acknowledge mail, release claims, grant authority, or restart a dead process.

### Reminders without automatic agents

While the extension is open, a timer checks unread counts and worker-lease staleness. The defaults are every 15 seconds, notify on new unread mail, and notify when a previously seen worker becomes stale. Configure:

- `portableAiBus.reminders.intervalSeconds` (5–600)
- `portableAiBus.reminders.notifyUnread`
- `portableAiBus.reminders.notifyStaleWorkers`

The first check establishes a quiet baseline, and later checks notify only on new transitions. The timer never invokes a model, reads/acknowledges mail, releases a claim, or revives a stopped process. It reminds the human; it does not replace the human.

## Optional: SKSE DevKit
If you build Skyrim SKSE plugins, the bus can **talk to a DevKit you already installed**. It does **not** download or ship compilers, CommonLib, or game files.

Point it with `SKSE_DEVKIT_ROOT` or put a kit under `.ai-bus/toolchains/skse-devkit`.

## Terminal wrappers (Windows only)
Optional `.cmd` / `.ps1` scripts exist for older Windows workflows. They are **not** staged by default and **there are no macOS/Linux shell scripts**. On any OS, prefer:

```bash
node .ai-bus/bin/mailbox.js status
node .ai-bus/bin/harness.js serve --root .
```

or `@ai-bus` in VS Code chat.

## Rules that keep the peace
1. Claim before you edit; release when done.
2. Treat mailbox messages as suggestions, not orders.
3. If the bus halts, inspect the reason and evidence before resuming; add rounds if the hard cap was reached.
4. Do not commit secrets or character content that belongs in a private rig.
5. Do not expect one AI UI to be auto-woken by another — start the session, then use the mailbox.

## Where to go next
- Short operator intents: `OPERATOR.md`
- How we verify builds: `TESTING.md`
- Licence and “what we did not copy”: `docs/PROVENANCE.md`
- Full technical surface: `README.md`
