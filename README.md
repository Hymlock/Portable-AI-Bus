# Portable AI Bus

**v0.2** — MIT. A multi-agent bus that coordinates work through a durable **mailbox**, runs
agents as long-lived **brains** backed by an ordered chain of model providers, and exposes a
**loopback harness** (authenticated tool/capability plane) plus adapters (including SKSE DevKit
discovery).

> **The bus itself runs on Node, not on VS Code.** The mailbox, harness, brains and worker
> client are plain Node processes with no `vscode` import — clone the repo, run
> `node scripts/bus-up.js`, and the bus works with no editor running. The VS Code extension is
> an **optional front-end** that stages a `.ai-bus` bundle and adds palette commands, settings
> and reminders.
>
> **But a seat still needs a gateway to a model, and that is usually a vendor's plugin.** The
> bus does not talk to model APIs itself; it drives an authenticated vendor CLI. Where that CLI
> comes from differs per vendor, and it is not always npm:
>
> | Gateway | Where the binary comes from |
> |---|---|
> | `codex` | **the ChatGPT VS Code extension** — `…/openai.chatgpt-*/bin/<platform>/codex.exe`. Never on `PATH` |
> | `cli` (Claude) | npm `@anthropic-ai/claude-code`, **or** the Claude Code extension's bundled binary |
> | `grok` | npm `@xai-official/grok`, unpacked to `~/.grok/bin` — no editor involved |
>
> So the honest prerequisite is: **at least one signed-in model gateway**, which in Codex's case
> means having that extension installed. Grok is the one route that is fully editor-free today.
>
> **Recommended: install all three.** Then any vendor can be the *pilot* — the seat you drive
> from. You open that vendor's chat window, tell it to initiate the bus, and it takes the baton;
> the others run as brains alongside it. When one vendor is throttled or out of credit, you
> simply pilot from another, and the seats keep working because every chain crosses a vendor
> boundary anyway. One install decision buys both halves of the resilience: independent
> **wallets** and an independent **place to stand**.
>
> The packaging currently states this backwards: `package.json` declares `main:
> dist/extension.js` and **no `bin` entry**, so there is no first-class CLI install even though
> the CLI is what does the work. Tracked as a distribution defect — see the `worker` seat's
> audit finding that the VSIX omits the runnable brain wrapper.

Work is moved forward by **brains**: long-lived processes that own a seat, wake on mail, call a
model, act through bus tools, and keep going across turns until the work is done. A brain
outlives the shell that started it, so an agent no longer stops merely because a chat turn
ended — that equivalence between *reporting* and *stopping* was the original problem this
project exists to remove.

This is still **not** a live AI-to-AI chat network. Seats exchange durable mail; they do not
hold conversations. Humans set goals, arbitrate, and stop things — see `docs/LOOP_ARCHITECTURE.md`.

## What you get

| Layer | Purpose |
|-------|---------|
| **Workflow overlay** | Phase docs (`docs/ai-*.md`), provider standing orders, suspend/resume |
| **Mailbox** | Durable sequenced messages, accumulated path claims, configurable halt policies |
| **Harness** | Loopback HTTP control plane: seats, request IDs, capabilities, wakes, advisory worker leases |
| **Capabilities** | Allowlisted argv runners + evidence receipts (no shell) |
| **SKSE adapter** | Discover/build/test against an **external** SKSE DevKit (not bundled) |
| **LM worker** | Optional, **explicit** VS Code Language Model session (bounded turns) |

## Prerequisites and installation

- VS Code 1.101 or newer and a trusted workspace.
- Node.js 20 or newer on `PATH`; staged CLIs run with `node`.
- At least two authenticated provider CLIs for resilient brains. API keys are optional, never
  required. See `docs/AUTH.md`.

Install with **Extensions: Install from VSIX...** or:

```bash
code --install-extension portable-ai-bus-0.2.0.vsix
```

Installing a newer VSIX with `--force` updates it. Stop brains/harnesses first and reinitialize
afterward so staged code is refreshed. Remove the workspace Bus before uninstalling the extension
if its staged files should also be removed. Full lifecycle instructions are in
`docs/DISTRIBUTION.md`.

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

Any of the three provider sessions can initiate the same system. Change only `--console` to the
initiating seat; all three provider-neutral brains start by default:

```bash
node .ai-bus/scripts/bus-up.js --root . --console codex
```

On Windows, `node .ai-bus/scripts/bus-console.js --root .` keeps all brains under one visible
console for the strongest no-flash guarantee. Brains continue after each wake. Clarification is
an open dependency, never goal completion. A provider credit failure falls through to another
vendor; whole-chain exhaustion hands off the baton. A dead process still requires `bus-up` to be
restarted because v0.2 does not install a service supervisor.

Initialization preserves pre-existing repository files. Only files actually created by the bus enter its ownership ledger; user-modified managed files are preserved on reinitialize and remove. Destructive lifecycle operations require an HMAC-checked ownership ledger outside the repository, reject junction/symlink escapes, serialize through a cross-process workspace lock, and recover interrupted install or suspend state. The in-repo manifest is descriptive, not destructive authority.

## Model providers: install and sign-in

A seat needs a **model** behind it. This section is what someone on a fresh machine needs, and
every command below was run and verified on 2026-08-10.

**None of them is required.** A chain falls through to the next link, so one missing or
signed-out vendor degrades a seat instead of stopping it. Install as many as you want seats to
be independent of — with all three, no single vendor's outage or spent wallet can stop the bus.

**API keys are optional everywhere.** Each CLI authenticates against a subscription you already
pay for; `ANTHROPIC_API_KEY` / `XAI_API_KEY` are opt-in fallbacks, never prerequisites.

| Vendor | Install | Sign in | Verify |
|---|---|---|---|
| **Anthropic** (`cli`) | Claude Code CLI | existing Claude subscription | `claude --version` |
| **OpenAI** (`codex`) | ships **inside** the ChatGPT VS Code extension | `codex login` | `codex login status` → `Logged in using ChatGPT` |
| **xAI** (`grok`) | `npm i -g @xai-official/grok` | `grok login` (browser) or `grok login --device-code` | `grok --version` |

`grok login` needs a **SuperGrok** or **X Premium+** subscription. Signed out, the link fails as
`auth` and the chain moves on — the seat keeps working on another vendor.

### Two Windows traps that make a present CLI look missing

Both cost real debugging time; the resolvers handle them, but know them before you conclude a
CLI is not installed.

- **Node 24 cannot spawn a `.cmd` shim at all** (EINVAL, deliberate hardening). npm installs
  `claude` and `grok` as shims, so spawning the name you type in a terminal fails with an error
  that reads exactly like "not installed".
- **The real binaries are not where the shim is.** `grok`'s npm entry is a *trampoline* that
  execs `~/.grok/bin/grok.exe`; Claude Code's real executable lives under
  `%APPDATA%\npm\node_modules\@anthropic-ai\claude-code\bin\`; Codex's is inside the VS Code
  extension directory and is **never on PATH**. Searching PATH alone reports "not installed"
  for a CLI that is present *and signed in*.

Override detection with `CODEX_CLI_PATH` or `GROK_CLI_PATH` if your layout differs.

### Check what a seat can actually reach

Each brain logs its chain at startup, and every reply records **which link served it** — so
"grok answered" is evidence, not an assumption:

```
{"event":"provider-chain","ok":true,"detail":"3/3 link(s) usable: grok=ok, codex=ok, cli=ok"}
{"seat":"grok","event":"wake-complete","note":"servedBy=grok"}
```

Read them at `<bus root>/.ai-bus/runtime/brain-<seat>.log`. If a seat you expect to be on its
own vendor logs `servedBy=cli`, it is falling through — and billing someone else's wallet.

## Keeping the pilot chat awake

Brains solved half the stall. A brain is a process: it wakes on mail, acts, and keeps going. The
**pilot** — the chat window a human drives — is still a chat session, and a chat session's turn
ends when it finishes speaking. It cannot wake itself, so work stops between your messages even
while every seat is healthy.

`bus-tick` is the other half. It prints one line per interval, forever:

```
node scripts/bus-tick.js --root "<bus root>" --interval-s 240
tick 10:51:43  brains:claude,codex,grok,worker  baton:hymlock(44s)  round:497/550  unread:none
```

The line is the wake signal. A host that can watch a subprocess's stdout and re-enter the model
on each line gets a pilot that resumes without you typing. **The bus emits the beat; the host
decides how to listen** — in Claude Code, run it as a Monitor; elsewhere, use whatever
background-task or watch facility surfaces stdout.

Each tick carries state worth waking for, so a beat that arrives when nothing has changed is
cheap to dismiss: which seats have live brains, who holds the baton and for how long, unread
counts, and an explicit `STALL?` when the baton has sat for 15 minutes with **no live brain on
that seat**. It reads the mailbox from disk rather than over HTTP, so it keeps beating when the
harness dies — the moment a pilot most needs waking is the one where a status call would hang.

**What it does not do.** It does not make a chat immortal. When the host session ends, the
listener ends with it. This buys continuity *across responses*, not *across sessions* — claiming
otherwise would repeat this project's oldest mistake of reading a heartbeat as proof of life.

## Providers

Configured in `providers/providers.json` (staged into `.ai-bus/providers/`):

| ID | Standing orders file | Auto-detect markers |
|----|----------------------|---------------------|
| `codex` | `AGENTS.md` | `AGENTS.md` |
| `claude` | `CLAUDE.md` | `CLAUDE.md`, `.claude/…` |
| `grok` | `GROK.md` | `GROK.md`, `.kilo`, `kilo.json` |

Default recommended set when fewer than two markers match: **codex + claude + grok**. Override with setting `portableAiBus.providers`.

Provider identity does not determine responsibility. Configure `workflow.plannerSeat`, `workflow.implementerSeat`, and `workflow.reviewerSeat`; the assigned IDs are registered even when they are not built-in provider templates. Active initialized workspaces synchronize role changes automatically. A VS Code-owned harness is restarted to rotate its seat inventory; an externally owned harness must be restarted by its operator. Canonical phases are provider-neutral (`READY_FOR_IMPLEMENTATION`, `IMPLEMENTATION_IN_PROGRESS`, and `REVIEW_IN_PROGRESS`). Legacy model-named phases remain read-compatible for existing workspaces.

## Mailbox (operator CLI)

The raw mailbox CLI is a trusted local/operator surface and accepts explicit actor IDs. Automated seats should use the authenticated worker client shown below so the harness enforces their identity.

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

### Worker client (provider-neutral seat tools + wait/watch)

Staged as `.ai-bus/bin/worker-client.js`. A seat process can block on harness wakes without knowing host details beyond the workspace root:

```bash
# one-shot: acquire lease, long-poll /v1/wake, then release
node .ai-bus/bin/worker-client.js wait --root . --seat grok [--timeout-ms 25000]

# keep one lease renewed until SIGINT/SIGTERM; print only new message seqs as JSON lines
node .ai-bus/bin/worker-client.js watch --root . --seat grok

# identity-bound mailbox and capability operations
node .ai-bus/bin/worker-client.js status --root . --seat grok
node .ai-bus/bin/worker-client.js read --root . --seat grok --all
node .ai-bus/bin/worker-client.js send --root . --seat grok --to codex --subject "review" --body "ready"
node .ai-bus/bin/worker-client.js claim --root . --seat grok --paths src/foo.ts --why "reviewing"
node .ai-bus/bin/worker-client.js release --root . --seat grok --paths src/foo.ts
node .ai-bus/bin/worker-client.js capabilities --root . --seat grok
node .ai-bus/bin/worker-client.js run --root . --seat grok --capability bus.doctor --timeout-ms 60000
```

The client is provider-neutral: a seat can be backed by any process able to run the staged Node CLI. It discovers `.ai-bus/runtime/harness/endpoint.json`, requires a token whose embedded principal matches `--seat`, and sends identity-bound tools to the loopback harness. Its parser rejects unknown, duplicate, and valueless options, including ambiguous release commands. Mutating requests get UUIDs automatically; supply one stable `--request-id` only when retrying the exact same uncertain operation. Capability calls accept `--timeout-ms`, and the HTTP deadline is kept longer than the requested capability run.

`watch` persists its successful-delivery `afterSeq` cursor outside the repository, keys it to the logical client and mailbox epoch, suppresses unchanged unread mail, rediscovers rotated endpoints and credentials, and reconnects with bounded exponential jitter. Delivery is intentionally **at least once**: consumers must make side effects idempotent because a crash after the effect but before cursor persistence can redeliver a message. Wake pages and HTTP response bodies are bounded. Stdout stays machine-readable; connection transitions go to stderr. This is a durable wait loop for a process you already launched—not VS Code UI injection or proof that the provider acted on a wake.

See `OPERATOR.md` for recovery and threat-model notes. Design lineage: `docs/PROVENANCE.md`.

## Capabilities

Allowlist: workspace `.ai-bus/capabilities.json` (templated from `templates/capabilities.json`).

- Spawn with **`shell: false`**, scrubbed environment, cwd jail, timeouts, process-tree kill, capped redacted receipts under `.ai-bus/runtime/receipts/`.
- `allowedSeats`: empty = seats denied (operator may still run depending on harness policy); `"*"` or explicit seat ids to grant.
- Default template grants every registered seat `bus.doctor`, `git.status`, and the complete
  Dev Kit workflow: `skse.doctor`, `skse.configure`, `skse.build`, `skse.test`,
  `skse.validate-artifacts`, and the bounded `skse.search.plugin-entrypoint`.

```bash
node .ai-bus/bin/capabilities.js list --root <workspace>
node .ai-bus/bin/capabilities.js run --id bus.doctor --root <workspace>
```

(Harness tool `capability_run` is the multi-agent entry when the server is up.)

## SKSE DevKit adapter

**Not embedded in the VSIX.** Discovers an external kit:

1. `--root` / adapter options
2. env `SKSE_DEVKIT_ROOT`
3. `${workspace}/.ai-bus/toolchains/skse-devkit`

Real kit layout supported (example): `tools/cmake/bin/cmake.exe`, `tools/ninja.exe`, `tools/vcpkg/…`, `libraries/CommonLibSSE-NG`, samples like `DragonbornLogbookNative`. The **devkit root is a toolchain**, not the CMake project — configure/build use a **sourceDir** (workspace `CMakeLists.txt` or a kit sample).

```bash
node .ai-bus/bin/skse-devkit.js doctor --workspace . --root <SKSEDevKit>
node .ai-bus/bin/skse-devkit.js configure --workspace . --root <SKSEDevKit> [--source-dir ...] [--preset name]
node .ai-bus/bin/skse-devkit.js build|test|search|validate-artifacts ...
```

The VSIX does not vendor CommonLib, SKSE, Skyrim, or compilers. The offline distribution builder
can copy an operator-supplied Dev Kit beside the VSIX with per-file hashes. It does not grant
redistribution rights or fill in missing MSVC, Windows SDK, game assets, or licenses.

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
| `workflow.plannerSeat` / `workflow.implementerSeat` / `workflow.reviewerSeat` | Assign workflow roles to arbitrary seat IDs |
| `stageTasksJson` / `stageCompatibilityWrappers` | Optional staging |

**Compatibility wrappers are Windows-only.** `templates/` ships `.cmd` / `.ps1` helpers (`Start`, `Status`, `Watch`, …). There are **no** `.sh` siblings. Default `stageCompatibilityWrappers` is **false**; the chat-first path and staged `.vscode/tasks.json` use `node .ai-bus/bin/*.js`, which is cross-platform. On macOS/Linux use the Node CLIs (or `@ai-bus`), not the wrappers. Do not enable wrappers expecting POSIX coverage.
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
npm run package
```

Install the generated `.vsix` into a normal VS Code window for a non-F5 smoke test. Set a real Marketplace `publisher` before publish.

Build or inspect a VSIX + Dev Kit release directory without committing the multi-gigabyte payload:

```bash
npm run distribution -- --devkit-root "C:\path\to\SKSEDevKit" --out "C:\release\Portable-AI-Bus" --dry-run
npm run distribution -- --devkit-root "C:\path\to\SKSEDevKit" --out "C:\release\Portable-AI-Bus"
```

The real build writes `manifest.json` with SHA-256 and byte size for every copied file. Dry-run
inventories only and writes nothing. See `docs/DISTRIBUTION.md`.

## Docs map

| File | Audience |
|------|----------|
| `HUMAN_GUIDE.md` | Plain-English human operator |
| `OPERATOR.md` | Intents, harness ops, recovery |
| `TESTING.md` | Verification checklist |
| `docs/PROVENANCE.md` | Licence / design lineage / non-bundling rules |
| `docs/AUTH.md` | Provider login and no-API-key routes |
| `docs/DISTRIBUTION.md` | VSIX + Dev Kit build, install, update, recovery, uninstall |

## What this project deliberately does **not** do

- Embed game engines, Mantella, SKSE binaries, CommonLib sources, or LLM weights in the VSIX or Git
- Copy GPL multiplayer mod sources into the MIT surface
- Silently inject prompts into Kilo/Codex/Claude UIs
- Treat a heartbeat as evidence of goal progress or automatically restart a stopped worker
- Run unbounded autonomous agent loops in the background
- Claim that offscreen Skyrim simulation is solved (Ensouled product docs are separate)
