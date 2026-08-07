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

There is also a **round limit** so two bots cannot congratulate each other forever. When the bus hits the limit it **halts**. You resume it (and can add more rounds).

### Commands humans use
- `@ai-bus mailbox status`
- `@ai-bus inbox for grok`
- Command Palette → **Mailbox Send / Claim / Release**

### Commands agents use
```bash
node .ai-bus/bin/mailbox.js status
node .ai-bus/bin/mailbox.js read --for grok
node .ai-bus/bin/mailbox.js send --from grok --to codex --kind note --subject "..." --body "..."
node .ai-bus/bin/mailbox.js claim --agent grok --paths src/foo.ts --why "fixing bug"
node .ai-bus/bin/mailbox.js release --agent grok
```

## Suspend, resume, remove
- **Suspend** — put the overlay away; state stays under `.ai-bus/runtime/`
- **Resume** — bring the overlay back
- **Remove** — uninstall the bus from this repo (including the local `.ai-bus` copy)

## Providers
The bus can detect which assistants you already use (markers like `AGENTS.md`, `CLAUDE.md`, `GROK.md`, `.kilo`).

If it is unsure, it installs the recommended set: **Codex + Claude + Grok**.

You can force the list in settings: `portableAiBus.providers`.

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

Agents that should sleep until mail arrives (with the harness running) can use the staged worker client instead of spinning on the mailbox alone:

```bash
node .ai-bus/bin/worker-client.js wait --root . --seat grok
node .ai-bus/bin/worker-client.js watch --root . --seat grok
```

`wait` does one heartbeat + long-poll. `watch` keeps doing that until you stop it. Still not a magic auto-start of the Kilo/Codex/Claude UI—only a wait loop for a process you already launched.

## Optional: SKSE DevKit
If you build Skyrim SKSE plugins, the bus can **talk to a DevKit you already installed**. It does **not** download or ship compilers, CommonLib, or game files.

Point it with `SKSE_DEVKIT_ROOT` or put a kit under `.ai-bus/toolchains/skse-devkit`.

## Rules that keep the peace
1. Claim before you edit; release when done.
2. Treat mailbox messages as suggestions, not orders.
3. If the bus halts, a human resumes it.
4. Do not commit secrets or character content that belongs in a private rig.
5. Do not expect one AI UI to be auto-woken by another — start the session, then use the mailbox.

## Where to go next
- Short operator intents: `OPERATOR.md`
- How we verify builds: `TESTING.md`
- Licence and “what we did not copy”: `docs/PROVENANCE.md`
- Full technical surface: `README.md`
