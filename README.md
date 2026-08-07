# Portable AI Bus

**v0.2** — MIT. A Visual Studio Code extension that stages a reusable `.ai-bus` bundle into a workspace, coordinates multi-agent work through a durable **mailbox**, and optionally exposes a **loopback harness** (authenticated tool/capability plane) plus adapters (including SKSE DevKit discovery).

This is **not** a live AI-to-AI chat network and **not** an unattended auto-pilot. Humans and already-running agent sessions move work forward.

## What you get

| Layer | Purpose |
|-------|---------|
| **Workflow overlay** | Phase docs (`docs/ai-*.md`), provider standing orders, suspend/resume |
| **Mailbox** | Durable sequenced messages, accumulated path claims, round guard |
| **Harness** | Loopback HTTP control plane: seats, request IDs, capabilities, wakes |
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
node .ai-bus/bin/mailbox.js halt --reason "converged"
node .ai-bus/bin/mailbox.js resume --add-rounds 8
```

**Behaviour (v0.2):**
- Messages are durable JSON under `.ai-bus/runtime/mailbox/` with monotonic `seq` and round counter.
- Claims **accumulate** per agent; broader claims replace nested narrower ones; **path-scoped release** is supported.
- **Round guard**: when `round >= maxRounds`, sends halt until a human `resume` (optional extra rounds).
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
- JSON API (v1): `/v1/status`, `/v1/tools`, `/v1/tool` (POST), `/v1/wake` (long-poll), `/v1/heartbeat`.
- **Request IDs** make tool invokes idempotent (fingerprint + durable records). Reuse with different input → `409`.
- Seats cannot impersonate other agents; operator is full-power (treat as root).
- While the mailbox is **halted**, mutating tools fail closed (`423`): send, claim, release, read-ack, capability_run.
- Wake long-polls are concurrency-capped.

### Worker client (provider-neutral wait/watch)

Staged as `.ai-bus/bin/worker-client.js`. A seat process can block on harness wakes without knowing host details beyond the workspace root:

```bash
# one-shot: heartbeat + long-poll /v1/wake (default timeout 25s, cap 30s)
node .ai-bus/bin/worker-client.js wait --root . --seat grok [--timeout-ms 25000]

# loop until SIGINT/SIGTERM; prints only newly seen message seqs as JSON lines
node .ai-bus/bin/worker-client.js watch --root . --seat grok
```

Discovers `.ai-bus/runtime/harness/endpoint.json`, loads the seat token from the user credentials dir for that `instanceId`, requires `127.0.0.1`, and posts `/v1/heartbeat` before each wake. This is the supported unattended pattern when a harness is already running—not VS Code UI injection.

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
- Run unbounded autonomous agent loops in the background
- Claim that offscreen Skyrim simulation is solved (Ensouled product docs are separate)
