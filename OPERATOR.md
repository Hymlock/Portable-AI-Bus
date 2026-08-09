# Portable AI Bus — Operator Guide (v0.2)

Audience: humans running the extension, harness, and multi-agent sessions.

## Primary intents (`@ai-bus` / Command Palette)

| Intent | Effect |
|--------|--------|
| `instructions` | Open staged human guide |
| `initialize the bus for this repo` | Stage `.ai-bus`, providers, docs, CLIs |
| `start task: … goal: … validation: …` | Init workflow docs for a task |
| `show status` / `show next prompt` | Phase workflow |
| `set phase to <PHASE>` | Update status + prompt artifacts |
| `mailbox status` / `inbox for <seat>` | Coordination mailbox |
| `send message` / `claim` / `release claims` | Mailbox mutations (guided UI) |
| **Configure Round, Step, and Goal Halting** | Set checkpoint and completion policies |
| **Record Step Completion** / **Record Goal Completion** | Store structured summary/evidence and apply policy |
| **Start Harness** / **Stop Harness** / **Show Harness and Worker Status** | Manage or inspect the harness owned by this VS Code window |
| `suspend` / `resume` / `remove` | Overlay lifecycle |
| `open settings` | `portableAiBus.*` |
| **Run Language Model Worker** | Explicit bounded `vscode.lm` session |

Canonical phases are `PLANNING`, `READY_FOR_IMPLEMENTATION`, `IMPLEMENTATION_IN_PROGRESS`, `READY_FOR_REVIEW`, `REVIEW_IN_PROGRESS`, `READY_FOR_FIXES`, and `DONE`. Older model-named phase values are normalized when read. Role assignment comes from `.ai-bus/workflow.json`, generated from the three `portableAiBus.workflow.*Seat` settings. Setting changes synchronize active initialized folders; VS Code-owned harnesses restart automatically, while external harnesses require an operator restart.

### Overlay ownership and recovery

- Pre-existing files are never silently adopted. Bus-created files are tracked by content hash in an HMAC-protected ledger under `~/.portable-ai-bus/ownership/`; `.ai-bus/install-state.json` is descriptive only.
- Reinitialization preserves customized managed files and keeps ownership of deselected overlay files until explicit removal. Remove deletes only an unchanged managed hash; customized files survive.
- Initialize, suspend, resume, and remove share an external per-workspace process lock. A live owner fails closed; a well-formed dead owner is recovered.
- A write-ahead pending-install record reconciles interruption before/after each copy. Suspension state is external-ledger authoritative, so resume can recover a missing/stale in-repo marker and partially completed moves.
- Lifecycle paths are lexically and physically contained. Symlink/junction ancestors that escape the workspace or user ownership root are rejected before mutation.
- Missing, malformed, or integrity-failed external ownership evidence blocks destructive operations. Do not hand-edit the ledger or key.

## Mailbox operations

Staged binary: `.ai-bus/bin/mailbox.js` (from `dist/mailbox.js`).

This is a trusted operator/local-recovery interface: its actor flags are not authenticated. Provider processes should use the seat client below.

```bash
node .ai-bus/bin/mailbox.js init --agents codex,claude,grok [--max-rounds 32]
node .ai-bus/bin/mailbox.js status
node .ai-bus/bin/mailbox.js send --from A --to B --kind note --subject "..." --body "..."
node .ai-bus/bin/mailbox.js read --for A [--all]
node .ai-bus/bin/mailbox.js wait --for A --timeout 600
node .ai-bus/bin/mailbox.js claim --agent A --paths path1,path2 --why "..."
node .ai-bus/bin/mailbox.js release --agent A [--paths path1]
node .ai-bus/bin/mailbox.js doctor
node .ai-bus/bin/mailbox.js configure-halting [--on-step true|false] [--on-goal true|false] [--at-rounds 6,12] [--every-rounds 12]
node .ai-bus/bin/mailbox.js complete-step --agent A --summary "..." [--evidence test,commit]
node .ai-bus/bin/mailbox.js complete-goal --agent operator --summary "..." [--evidence test,release]
node .ai-bus/bin/mailbox.js halt --reason "..."
node .ai-bus/bin/mailbox.js resume [--add-rounds N]
```

### Semantics
- **Durable** inbox files + transcript; each send bumps `seq` and `round`.
- **Claims accumulate**; releasing specific paths keeps the rest; do not edit under foreign claims.
- A send increments both `seq` and `round`. If that new round triggers a round policy, the message is written first and the bus then halts.
- Completion is a structured event containing scope (`step` or `goal`), actor, summary, optional evidence, timestamp, and whether it halted the bus. Ordinary message text never implies completion.
- Exit `2` = halted; `3` = nothing waiting / wait timeout.

### Halt policy matrix

| Policy | Default | Trigger and authority |
|--------|---------|-----------------------|
| Hard `maxRounds` | 32 | Always enforced on sends; not disabled by the policy command |
| `atRounds` | `[]` | Operator-selected positive round numbers |
| `everyRounds` | off (`null`) | Every positive Nth round; `0`/`null` disables |
| `onStepCompletion` | `false` | A seat may record its own step through the harness; operator/local CLI may also record |
| `onGoalCompletion` | `true` | Harness goal completion is operator-only |

`resume` clears `halted` and `stopReason`; it does not erase completion/transcript history or change the halt policy. After a hard-cap halt, use `--add-rounds N` with `N > 0` or the next send will meet the unchanged cap again. After an explicit or recurring checkpoint, a plain resume advances normally until the next configured trigger. Manual `halt --reason` remains available independently.

## Harness operations

```bash
node .ai-bus/bin/harness.js serve --root <workspace> [--port 47831]
# port 0 = ephemeral
```

Or use Command Palette **Start Harness**, **Stop Harness**, and **Show Harness and Worker Status**. A VS Code window stops only the harness instance it created. Its owned instance is cleaned up on Suspend, Remove, workspace-folder removal, and extension deactivation. External/other-window instances are not killed. `portableAiBus.harness.autoStart` defaults false and is ignored for uninitialized or suspended workspaces.

### In-process harness vs CLI process (reload)

Two ways to run the loopback server — they fail differently:

| Mode | How | Survives extension host reload? | Survives VS Code restart? |
|------|-----|----------------------------------|---------------------------|
| **CLI** | `node .ai-bus/bin/harness.js serve --root …` in a terminal or external process | **Yes** (independent PID) | Only if you left the process running outside the window |
| **Extension-managed** | Command Palette **Start Harness** / `harness.autoStart` via `HarnessManager` | **No** — server lives in the extension host; reload/deactivate tears it down | **No** |

**Operational consequences**

1. After **Developer: Reload Window** or an extension update, expect endpoint/credentials to be gone if the harness was extension-owned. Seats must re-discover; old seat tokens for the previous `instanceId` will 401.
2. Multi-agent drills that must survive reloads should use the **CLI** harness, not the palette start.
3. `Stop Harness` only stops the instance **this window created**. It will not kill a CLI harness another agent started — check `stall-check` / endpoint PID before assuming the bus is down.
4. Mailbox **code** changes require a harness restart either way: the running process holds the compiled server; your local `dist/` is not hot-reloaded into an already-listening PID.

### Security model (actual)
- Listen **`127.0.0.1` only**.
- Bearer tokens: **operator** + one **seat** per registered mailbox agent.
- Token files under
  `~/.portable-ai-bus/credentials/<workspace-identity-hash>/<instanceId>/`
  (`operator.token`, `seats/<agent>.token`), mode 0600-ish; **removed on clean stop**.
- Workspace lock file prevents two harnesses on the same root. Dead owners are recovered only after an exclusive recovery election and an exact owner recheck; a live or ambiguous owner fails closed.
- Runtime audit/endpoint under `.ai-bus/runtime/harness/` (no long-lived secrets in-repo).
- Seat tokens cannot act as another agent; operator can.
- Idempotent `POST /v1/tool` via `requestId` + canonical fingerprint; durable records under `runtime/harness/requests/`.
- Halted mailbox → mutating tools return **423** (`mailbox_send|claim|release|read|capability_run`).
- Wake: `GET /v1/wake?agent=&clientId=&leaseId=&generation=&afterSeq=&timeoutMs=` long-poll; concurrency limited. Operator diagnostics may wake without a seat lease.

### Worker lease semantics

- `POST /v1/heartbeat` is seat-only. With no lease identity it requires a per-process `acquisitionId` and acquires the single live lease allowed for that seat; repeating the same acquisition is idempotent, while another nonce is fenced. With `leaseId` + `generation` it renews that exact lease.
- `POST /v1/workers/release` is seat-only and releases only a matching lease identity.
- Every lease is fenced by `instanceId`, `leaseId`, and generation. A harness restart rotates the instance and credentials. Expired/superseded generations return `409 lease_lost`; a competing client receives `409 lease_held` while the current lease is live.
- Heartbeat and wake timestamps are persisted to `.ai-bus/runtime/harness/leases.json`; status reports registered seats as `live`, `stale`, or `never_seen`.
- **Advisory only:** “live” means recent authenticated HTTP activity. It does not certify provider health, current computation, useful progress, instruction compliance, or message handling. Leases never confer tool authority or mutate mail/claims by themselves.
- Heartbeats remain possible while mailbox mutations are halted. A wake against a halted mailbox can still report the halt; it does not resume the bus.

### Client sketch
```http
Authorization: Bearer <token>
POST /v1/tool
{"requestId":"unique-1","name":"mailbox_status","input":{}}
```

After a transport failure with an uncertain outcome, retry the exact same tool/input with the same `requestId`. After a definitive recorded tool failure, correct the cause and use a new ID; failed IDs stick as `recorded_failure` until pruned. Never reuse an ID with different input.

### Worker client (authenticated seat tools / wait / watch)

Staged: `.ai-bus/bin/worker-client.js` (from `dist/worker-client.js`).

```bash
node .ai-bus/bin/worker-client.js wait --root <workspace> --seat <agent> [--timeout-ms 25000] [--credentials-dir PATH]
node .ai-bus/bin/worker-client.js watch --root <workspace> --seat <agent> [--timeout-ms 25000]
node .ai-bus/bin/worker-client.js status --root <workspace> --seat <agent>
node .ai-bus/bin/worker-client.js read --root <workspace> --seat <agent> --all
node .ai-bus/bin/worker-client.js send --root <workspace> --seat <agent> --to <seat> --subject "..." --body "..."
node .ai-bus/bin/worker-client.js claim --root <workspace> --seat <agent> --paths path1,path2 --why "..."
node .ai-bus/bin/worker-client.js release --root <workspace> --seat <agent> [--paths path1,path2]
node .ai-bus/bin/worker-client.js complete-step --root <workspace> --seat <agent> --summary "..." [--evidence test,commit]
node .ai-bus/bin/worker-client.js capabilities --root <workspace> --seat <agent>
node .ai-bus/bin/worker-client.js run --root <workspace> --seat <agent> --capability <id> [--timeout-ms N]
```

`watch` persists a cursor outside the repository for its stable logical client ID and resets it only when the durable mailbox epoch changes. Delivery is at least once, not exactly once: downstream actions must be idempotent across a crash between handling a message and persisting its cursor. Wake pages and client/server response bodies are bounded.

| Mode | Behaviour |
|------|-----------|
| `wait` | Discover current endpoint/token, acquire a lease, long-poll once, release, and print one JSON result |
| `watch` | Retain and renew one lease; send a monotonic `afterSeq`; emit only new message sequences; rediscover/reconnect with bounded exponential jitter |
| seat tools | Bind actor identity to the matching token principal; strict argument parsing; idempotent UUID request by default |

Requirements: harness already serving; seat registered in endpoint; valid seat token file for current `instanceId`. Provider-neutral means the protocol does not interpret a model vendor—the caller remains responsible for launching and connecting its actual provider process. Stdout is JSON results only; connection transitions are bounded and written to stderr. SIGINT/SIGTERM abort an active long poll promptly and make a best-effort lease release; server-side expiry is the fallback.

Seat commands additionally require the token's embedded principal to equal `--seat`. Unknown, duplicate, missing-value, and extra arguments fail before any request; malformed `release --paths` never degrades into release-all. Capability `--timeout-ms` is forwarded to the runner and the client HTTP deadline remains longer than that requested run.

### Recovery
| Symptom | Action |
|---------|--------|
| `already owns this workspace` | Inspect the PID/endpoint. Stop the owning harness normally; startup automatically recovers a well-formed lock only when its PID is dead |
| `server_lock_recovery` / malformed lock | Another recovery is active or ownership is ambiguous. Do not delete blindly; inspect lock, endpoint, PID, and audit evidence |
| Lost tokens after restart | Expected — instance rotates; re-read paths from serve stdout / start() |
| Bus halted | Inspect `stopReason`; use `mailbox resume --add-rounds N` when the hard maximum needs more capacity |
| `409 lease_held` | Another client has the seat's live lease; stop it or wait for server expiry |
| `409 lease_lost` | Lease expired, was superseded, or belongs to an old instance; rediscover and acquire anew (`watch` does this) |
| 409 request_id_reuse | Same id, different body — change id or body intentionally |
| 409 indeterminate_request | Crash mid-flight — inspect evidence; new id |
| Port in use | `--port 0` or free 47831 |
| worker-client endpoint invalid | Start harness; confirm seat in `endpoint.json` seats list |
| worker-client credential malformed | Token missing/rotated — restart harness or fix credentials dir |

### VS Code reminder timer

Settings:

- `portableAiBus.reminders.intervalSeconds` — 5–600 seconds, default 15
- `portableAiBus.reminders.notifyUnread` — default true
- `portableAiBus.reminders.notifyStaleWorkers` — default true

The tracker establishes a silent baseline per workspace, then notifies once when a newer unread sequence appears for a seat or when a previously observed lease becomes stale. Filesystem mailbox events may prompt an additional check. Polls are serialized to avoid overlapping runs. The timer reads durable state only: it never invokes `vscode.lm`, acknowledges mail, releases claims, launches a worker, or revives a stopped process.

### Current limits and crash recovery

- The reminder timer exists only while the extension is active and the workspace bus is initialized and not suspended. It is a notification aid, not an external supervisor.
- `harness.autoStart` starts the loopback server, not a provider/model worker. `worker-client watch` waits for mail but does not launch or control the AI behind its seat.
- A clean harness stop removes its current instance credentials. A process crash can leave an old instance directory in the user credentials root; its token does not match a new harness instance, but the directory should be inspected and removed manually when recovering from a crash.
- Harness and mailbox locks recover only a well-formed, exactly rechecked owner whose PID is dead. Malformed or ambiguous ownership fails closed and requires operator inspection; never delete a lock solely because it looks old.
- The default worker stale window is 60 seconds and is server-authoritative. Detection therefore lags the last heartbeat and remains an observation, not a health guarantee.

## Capabilities

Config: `.ai-bus/capabilities.json`
CLI: staged capabilities runner if present; harness tool `capability_run`.

Template defaults (`templates/capabilities.json`):

| ID | Seats | Notes |
|----|-------|-------|
| `bus.doctor` | `*` | Mailbox doctor |
| `git.status` | `*` | Read-only git |
| `skse.doctor` | `*` | Inventory external kit |
| `skse.build` | _(none)_ | Operator-only unless you grant seats |

Receipts: `.ai-bus/runtime/receipts/<runId>.json` (+ `latest.json` best-effort under concurrency).

## SKSE DevKit adapter

```bash
node .ai-bus/bin/skse-devkit.js doctor --workspace <ws> [--root <kit>]
node .ai-bus/bin/skse-devkit.js configure --workspace <ws> --root <kit> [--source-dir ...] [--preset relwithdebinfo]
node .ai-bus/bin/skse-devkit.js build|test|search|validate-artifacts ...
```

Root resolution: `--root` → `SKSE_DEVKIT_ROOT` → `<ws>/.ai-bus/toolchains/skse-devkit`.
**Not shipped:** compilers, vcpkg packages, CommonLib tree, game assets.
sourceDir defaults: workspace `CMakeLists.txt`, else first kit sample with CMakeLists (e.g. `DragonbornLogbookNative`).

## Language Model worker

- Command `portableAiBus.runLanguageModelWorker`.
- Settings `portableAiBus.languageModelWorker.{enabled,vendor,modelId,maxTurns,allowedTools}`.
- **Explicit user action only**; enable may prompt on first run.
- Uses `vscode.lm` models. **Unify is optional** third-party provider.
- **Unsupported:** background autonomous continuous `sendRequest`, silent UI injection into Kilo/Codex/Claude.

## Providers

Edit `providers/providers.json` + `templates/providers/<id>/`.
Built-ins: codex, claude, grok.

## Staging checklist (initialize)

Expect under `.ai-bus/bin/`: at least `mailbox.js`, `harness.js`, `worker-client.js`, `skse-devkit.js`.
Expect templates, providers, HUMAN_GUIDE, capabilities template install as implemented by `bus.ts` stageBundle.

### Compatibility wrappers = Windows-only (by design)
`portableAiBus.stageCompatibilityWrappers` defaults **false**. When true, only `.cmd`/`.ps1` files are staged — **no `.sh`**. Non-Windows operators use `node .ai-bus/bin/...` exclusively. Do not add untested POSIX wrapper twins unless someone owns CI for them.

## Troubleshooting

| Problem | Check |
|---------|--------|
| `@ai-bus` missing | Extension activated? Chat participant enabled? |
| No GROK.md | Provider selection / markers / `portableAiBus.providers` |
| Agent ignores claims | Standing orders not loaded; agent not using mailbox CLI |
| Harness 401 | Wrong/expired instance token |
| SKSE doctor empty tools | `SKSE_DEVKIT_ROOT` wrong; kit layout not `tools/cmake/bin` etc. |
| Tests fail compile | `npm run compile` — fix TS before packaging |

## Maintenance surface
When changing UX, keep in sync: `README.md`, `HUMAN_GUIDE.md`, `TESTING.md`, this file, `package.json` contributes, `src/extension.ts`, `src/bus.ts`, provider templates.

## The listener policy — never leave the bus unattended

**No agent's turn may end while the bus is active and that agent holds no listener.** A seat
with unread mail and no lease is the single most common stall, and it is invisible from the
inside: the silent agent believes it is between tasks, and everyone else reads it as thinking.

### Run it detached, not between work blocks

A rule an agent has to *remember* is a rule that fails. The listener belongs in a background
process that survives the work, not in a gap between two pieces of work.

```bash
#!/usr/bin/env bash
R="<bus root>"; B="<Portable-AI-Bus>"; SEAT="<seat>"; LOG="/tmp/bus-$SEAT.log"
cd "$B" || exit 1
for i in $(seq 1 400); do
  node dist/worker-client.js listen --root "$R" --seat "$SEAT" --deadline-s 240 >/dev/null 2>&1
  code=$?
  if [ "$code" = "0" ]; then
    node dist/worker-client.js read --root "$R" --seat "$SEAT" --all >> "$LOG" 2>&1
  elif [ "$code" != "3" ]; then
    echo "stopping, unexpected exit $code" >> "$LOG"; exit "$code"
  fi
done
```

### The trap: `listen` does not consume

`listen` returns when mail is **unread**; it does not mark it read. A loop that re-listens
without calling `read` sees the same mail immediately and spins — four hundred cycles in a
second, then exits.

That failure is worse than having no listener at all, because it **reports success**. The
process starts, returns 0, and the agent believes it is attended while it is not.

**Always `read` after a successful `listen`.** Exit codes: `0` mail waiting, `3` timeout,
anything else is a real error worth stopping for.

### One listener per seat

Two listeners on the same seat collide on the lease and one gets a 409. Check
`.ai-bus/runtime/harness/leases.json` — it lists live seats and last heartbeat. **If a seat is
missing from that file while the bus is active, that seat is the stall.**
