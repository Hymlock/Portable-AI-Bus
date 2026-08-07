# Portable AI Bus

**v0.2** — MIT. A Visual Studio Code extension that stages a reusable `.ai-bus` bundle into a workspace, coordinates multi-agent work through a durable **mailbox**, and optionally exposes a **loopback harness** (authenticated tool/capability plane) plus adapters (including SKSE DevKit discovery).

This is **not** a live AI-to-AI chat network and **not** an unattended auto-pilot. Humans and already-running agent sessions move work forward.

## What you get

| Layer | Purpose |
|-------|---------|
| **Workflow overlay** | Phase docs (`docs/ai-*.md`), provider standing orders, suspend/resume |
| **Mailbox** | Durable sequenced messages, accumulated path claims, configurable halt policies |
| **Harness** | Loopback HTTP control plane: seats, request IDs, capabilities, wakes, advisory worker leases |
| **Capabilities** | Allowlisted argv runners + evidence receipts (no shell) |
| **SKSE adapter** | Discover/build/test against an **external** SKSE DevKit (not bundled) |
| **LM worker** | Optional, **explicit** VS Code Language Model session (bounded turns) |

## Quick start (human)

```bash
npm install
npm run compile
npm test
```

1. Open this repo in VS Code and press **F5** (Extension Development Host), or package a `.vsix` (below).
2. In a **test workspace**, open Chat → `@ai-bus help`.
3. `@ai-bus initialize the bus for this repo`.
4. Confirm `.ai-bus/`, provider files (`AGENTS.md` / `CLAUDE.md` / `GROK.md` as selected), workflow docs, and staged CLIs under `.ai-bus/bin/`.

Primary UX: **Command Palette** (`Portable AI Bus: …`) and **`@ai-bus`**. Terminal CLIs are for agents and operators.

## Providers

Configured in `providers/providers.json` (staged into `.ai-bus/providers/`):

| ID | Standing orders file | Auto-detect markers |
|----|----------------------|---------------------|
| `codex` | `AGENTS.md` | `AGENTS.md` |
| `claude` | `CLAUDE.md` | `CLAUDE.md`, `.claude/…` |
| `grok` | `GROK.md` | `GROK.md`, `.kilo`, `kilo.json` |

Default recommended set when fewer than two markers match: **codex + claude + grok**. Override with setting `portableAiBus.providers`.

## Mailbox (agents + CLI)

After initialize, agents use:

```bash
node .ai-bus/bin/mailbox.js status
node .ai-bus/bin/mailbox.js read --for grok
node .ai-bus/bin/mailbox.js send --from grok --to codex --kind note --subject "..." --body "..."
node .ai-bus/bin/mailbox.js claim --agent grok --paths src/foo.ts --why "reason"
node .ai-bus/bin/mailbox.js release --agent grok --paths src/foo.ts   # omit --paths = release all
node .ai-bus/bin/mailbox.js wait --for grok --timeout 600
node .ai-bus/bin/mailbox.js doctor
node .ai-bus/bin/mailbox.js configure-halting --on-step false --on-goal true --at-rounds 6,12 --every-rounds 12
node .ai-bus/bin/mailbox.js complete-step --agent grok --summary "Parser complete" --evidence "npm test,commit abc123"
node .ai-bus/bin/mailbox.js complete-goal --agent operator --summary "Release verified" --evidence "npm test,VSIX smoke"
node .ai-bus/bin/mailbox.js halt --reason "converged"
node .ai-bus/bin/mailbox.js resume --add-rounds 8
```

**Behaviour (v0.2):**
- Messages are durable JSON under `.ai-bus/runtime/mailbox/` with monotonic `seq` and round counter.
- Claims **accumulate** per agent; broader claims replace nested narrower ones; **path-scoped release** is supported.
- **Halting is structured and configurable.** The hard `maxRounds` cap always applies. Optional explicit round checkpoints and an every-N-round checkpoint can also pause the bus after the triggering message is durably written. Step- and goal-completion records have separate policies.
- Safe defaults are: step completion continues, goal completion halts, no explicit/recurring checkpoints, and `maxRounds = 32`.
- `resume` clears the current halt without erasing its reason or completion evidence from history. Add rounds when resuming from the hard maximum; policy settings remain in force.
- Exit codes: `0` ok / message, `3` empty / timeout, `2` halted.
- UI: Command Palette **Mailbox Status / Inbox / Send / Claim / Release** and `@ai-bus mailbox|inbox|send|claim|release`.

Messages are **proposals**, not orders. Do not edit paths another agent holds.

## Harness (loopback control plane)

```bash
node .ai-bus/bin/harness.js serve --root <workspace> [--port 0]
```

- Binds **`127.0.0.1` only** (never all interfaces by default).
- **Operator token** + **per-seat tokens** written under the user credentials dir
  `~/.portable-ai-bus/credentials/<workspace-hash>/<instanceId>/` (not inside the git tree). Paths returned at start / mirrored in runtime endpoint metadata.
- Auth: `Authorization: Bearer <token>`.
- JSON API (v1): `/v1/status`, `/v1/tools`, `/v1/tool` (POST), `/v1/wake` (long-poll), `/v1/heartbeat`, `/v1/workers/release`.
- **Request IDs** make tool invokes idempotent (fingerprint + durable records). Reuse with different input → `409`.
- Seats cannot impersonate other agents; operator is full-power (treat as root).
- While the mailbox is **halted**, mutating tools fail closed (`423`): send, claim, release, read-ack, capability_run.
- Wake long-polls are concurrency-capped.
- A seat heartbeat acquires or renews one fenced worker lease for that seat. Acquisition also carries a per-process nonce, so a lost-response retry is idempotent while a duplicate process reusing the same logical client ID receives `409 lease_held`. Leases carry the harness `instanceId`, a `leaseId`, and a generation; stale or superseded identities receive `409 lease_lost`.
- Lease state is **advisory liveness only**: it proves recent authenticated heartbeat/wake traffic, not that a model is reasoning, making progress, following instructions, or even still healthy after its last request. A lease never grants mailbox authority, acknowledges mail, releases claims, or starts/stops a worker.

### VS Code-managed harness and reminders

The Command Palette provides **Start Harness**, **Stop Harness**, and **Show Harness and Worker Status**. The extension starts at most one harness that it owns per workspace. It will not stop a harness owned by another VS Code window or an external process. A managed harness is stopped when that workspace is suspended or removed, when its folder is removed from the window, or when the extension deactivates. `portableAiBus.harness.autoStart` is off by default and only starts for an initialized, non-suspended trusted workspace.

The extension also checks durable unread counts and persisted advisory leases on a configurable timer. It reports only new unread-sequence and newly-stale transitions after establishing a quiet baseline. These reminder checks **never invoke a model, acknowledge mail, release claims, or revive a stopped process**.

### Worker client (provider-neutral wait/watch)

Staged as `.ai-bus/bin/worker-client.js`. A seat process can block on harness wakes without knowing host details beyond the workspace root:

```bash
# one-shot: acquire lease, long-poll /v1/wake, then release
node .ai-bus/bin/worker-client.js wait --root . --seat grok [--timeout-ms 25000]

# keep one lease renewed until SIGINT/SIGTERM; print only new message seqs as JSON lines
node .ai-bus/bin/worker-client.js watch --root . --seat grok
```

The client is provider-neutral: a seat can be backed by any process able to run the staged Node CLI. It discovers `.ai-bus/runtime/harness/endpoint.json`, loads the matching seat token outside the repository, requires `127.0.0.1`, and acquires/renews/releases a fenced lease. `watch` persists its successful-delivery `afterSeq` cursor outside the repository, keys it to the logical client and mailbox epoch, suppresses unchanged unread mail, rediscovers rotated endpoints and credentials, and reconnects with bounded exponential jitter. Delivery is intentionally **at least once**: consumers must make side effects idempotent because a crash after the effect but before cursor persistence can redeliver a message. Wake pages and HTTP response bodies are bounded. Stdout stays machine-readable; connection transitions go to stderr. This is a durable wait loop for a process you already launched—not VS Code UI injection or proof that the provider acted on a wake.

See `OPERATOR.md` for recovery and threat-model notes. Design lineage: `docs/PROVENANCE.md`.

## Capabilities

Allowlist: workspace `.ai-bus/capabilities.json` (templated from `templates/capabilities.json`).

- Spawn with **`shell: false`**, scrubbed environment, cwd jail, timeouts, process-tree kill, capped redacted receipts under `.ai-bus/runtime/receipts/`.
- `allowedSeats`: empty = seats denied (operator may still run depending on harness policy); `"*"` or explicit seat ids to grant.
- Default template includes `bus.doctor`, `git.status`, `skse.doctor` (seats `*`), and `skse.build` (**no seats** — operator-only unless you edit grants).

```bash
node .ai-bus/bin/capabilities.js list --root <workspace>
node .ai-bus/bin/capabilities.js run --id bus.doctor --root <workspace>
```

(Harness tool `capability_run` is the multi-agent entry when the server is up.)

## SKSE DevKit adapter

**Not bundled.** Discovers an external kit:

1. `--root` / adapter options
2. env `SKSE_DEVKIT_ROOT`
3. `${workspace}/.ai-bus/toolchains/skse-devkit`

Real kit layout supported (example): `tools/cmake/bin/cmake.exe`, `tools/ninja.exe`, `tools/vcpkg/…`, `libraries/CommonLibSSE-NG`, samples like `DragonbornLogbookNative`. The **devkit root is a toolchain**, not the CMake project — configure/build use a **sourceDir** (workspace `CMakeLists.txt` or a kit sample).

```bash
node .ai-bus/bin/skse-devkit.js doctor --workspace . --root <SKSEDevKit>
node .ai-bus/bin/skse-devkit.js configure --workspace . --root <SKSEDevKit> [--source-dir ...] [--preset name]
node .ai-bus/bin/skse-devkit.js build|test|search|validate-artifacts ...
```

Does not vendor CommonLib, SKSE, Skyrim, or compilers.

## Optional VS Code Language Model worker

Command: **Portable AI Bus: Run Language Model Worker** (`portableAiBus.runLanguageModelWorker`).

- **Off by default** (`portableAiBus.languageModelWorker.enabled`).
- Requires an explicit user start; picks/configures `vendor` + `modelId` via `vscode.lm`.
- Bounded `maxTurns` and `allowedTools` allowlist.
- **Unify Chat Provider is optional** and independent — Portable AI Bus does not depend on Unify or manage its credentials. Any `vscode.lm` provider may supply models.
- **There is no background autonomous `sendRequest` loop** and no silent wake of Kilo/Grok/Codex chat UIs. Unattended agents should already be running and use mailbox `wait` / harness `/v1/wake`.

## Chat & Command Palette

**Workflow:** initialize, start task, status, prompt, set phase, suspend, resume, remove, settings, human guide.

**Mailbox:** status, inbox, send, claim, release.

**Coordination:** start/stop/show harness, configure halting, record step completion, record goal completion.

**LM worker:** Run Language Model Worker (explicit).

`@ai-bus` examples: `help`, `initialize the bus for this repo`, `mailbox status`, `inbox for grok`, `start task: … goal: … validation: npm test`.

## Settings (`portableAiBus.*`)

| Setting | Role |
|---------|------|
| `instructionsFile` | Staged human guide path |
| `commandReference` | In-settings command cheat sheet |
| `providers` | Force provider ids |
| `stageTasksJson` / `stageCompatibilityWrappers` | Optional staging |
| `showStatusBar` / `autoInitializeOnOpen` | UX |
| `languageModelWorker.*` | enabled, vendor, modelId, maxTurns, allowedTools |
| `harness.port` / `harness.autoStart` | VS Code-owned loopback harness lifecycle |
| `reminders.intervalSeconds` | Poll interval, 5–600 seconds (default 15) |
| `reminders.notifyUnread` / `reminders.notifyStaleWorkers` | Transition-only notifications; both default true |

## Staging layout (initialized workspace)

```text
.ai-bus/
  bin/mailbox.js
  bin/harness.js
  bin/worker-client.js
  bin/skse-devkit.js
  bin/…          # other staged helpers
  providers/
  templates/
  capabilities.json   # when installed from template
  runtime/mailbox/
  runtime/harness/    # endpoint lock/audit (tokens live outside repo)
  runtime/receipts/
  HUMAN_GUIDE.md
AGENTS.md / CLAUDE.md / GROK.md   # per selected providers
docs/ai-*.md
```

## Development & package

```bash
npm run compile
npm test                 # compile + node --test tests/*.test.js
npx @vscode/vsce package --no-dependencies
```

Install the generated `.vsix` into a normal VS Code window for a non-F5 smoke test. Set a real Marketplace `publisher` before publish.

## Docs map

| File | Audience |
|------|----------|
| `HUMAN_GUIDE.md` | Plain-English human operator |
| `OPERATOR.md` | Intents, harness ops, recovery |
| `TESTING.md` | Verification checklist |
| `docs/PROVENANCE.md` | Licence / design lineage / non-bundling rules |

## What this project deliberately does **not** do

- Bundle game engines, Mantella, SKSE binaries, CommonLib sources, or LLM weights
- Copy GPL multiplayer mod sources into the MIT surface
- Silently inject prompts into Kilo/Codex/Claude UIs
- Treat a heartbeat as evidence of goal progress or automatically restart a stopped worker
- Run unbounded autonomous agent loops in the background
- Claim that offscreen Skyrim simulation is solved (Ensouled product docs are separate)
