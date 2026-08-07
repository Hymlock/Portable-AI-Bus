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
| `suspend` / `resume` / `remove` | Overlay lifecycle |
| `open settings` | `portableAiBus.*` |
| **Run Language Model Worker** | Explicit bounded `vscode.lm` session |

Phases include: `PLANNING`, `READY_FOR_CODEX`, `CODEX_IN_PROGRESS`, `READY_FOR_REVIEW`, `CLAUDE_REVIEW_IN_PROGRESS`, `READY_FOR_FIXES`, `DONE`.

## Mailbox operations

Staged binary: `.ai-bus/bin/mailbox.js` (from `dist/mailbox.js`).

```bash
node .ai-bus/bin/mailbox.js init --agents codex,claude,grok [--max-rounds 32]
node .ai-bus/bin/mailbox.js status
node .ai-bus/bin/mailbox.js send --from A --to B --kind note --subject "..." --body "..."
node .ai-bus/bin/mailbox.js read --for A [--all]
node .ai-bus/bin/mailbox.js wait --for A --timeout 600
node .ai-bus/bin/mailbox.js claim --agent A --paths path1,path2 --why "..."
node .ai-bus/bin/mailbox.js release --agent A [--paths path1]
node .ai-bus/bin/mailbox.js doctor
node .ai-bus/bin/mailbox.js halt --reason "..."
node .ai-bus/bin/mailbox.js resume [--add-rounds N]
```

### Semantics
- **Durable** inbox files + transcript; each send bumps `seq` and `round`.
- **Claims accumulate**; releasing specific paths keeps the rest; do not edit under foreign claims.
- **Round guard**: at `maxRounds`, further sends throw halted until `resume`.
- Exit `2` = halted; `3` = nothing waiting / wait timeout.

## Harness operations

```bash
node .ai-bus/bin/harness.js serve --root <workspace> [--port 47831]
# port 0 = ephemeral
```

### Security model (actual)
- Listen **`127.0.0.1` only**.
- Bearer tokens: **operator** + one **seat** per registered mailbox agent.
- Token files under
  `~/.portable-ai-bus/credentials/<sha256(workspace)[:24]>/<instanceId>/`
  (`operator.token`, `seats/<agent>.token`), mode 0600-ish; **removed on clean stop**.
- Workspace lock file prevents two harnesses on the same root.
- Runtime audit/endpoint under `.ai-bus/runtime/harness/` (no long-lived secrets in-repo).
- Seat tokens cannot act as another agent; operator can.
- Idempotent `POST /v1/tool` via `requestId` + canonical fingerprint; durable records under `runtime/harness/requests/`.
- Halted mailbox → mutating tools return **423** (`mailbox_send|claim|release|read|capability_run`).
- Wake: `GET /v1/wake?agent=&timeoutMs=` long-poll; concurrency limited.

### Client sketch
```http
Authorization: Bearer <token>
POST /v1/tool
{"requestId":"unique-1","name":"mailbox_status","input":{}}
```

After **transient failure**, mint a **new** `requestId` (failed ids stick as `recorded_failure` until pruned).

### Worker client (seat-side wait / watch)

Staged: `.ai-bus/bin/worker-client.js` (from `dist/worker-client.js`).

```bash
node .ai-bus/bin/worker-client.js wait --root <workspace> --seat <agent> [--timeout-ms 25000] [--credentials-dir PATH]
node .ai-bus/bin/worker-client.js watch --root <workspace> --seat <agent> [--timeout-ms 25000]
```

| Mode | Behaviour |
|------|-----------|
| `wait` | POST `/v1/heartbeat` with seat id, then GET `/v1/wake` long-poll; print one JSON result (`wake` + `messages`) |
| `watch` | Loop `wait`; emit JSON only for **new** message `seq` values; on disconnect print `{event:"disconnected",...}` to stderr and retry |

Requirements: harness already serving; seat registered in endpoint; valid seat token file for current `instanceId`. Provider-neutral (any seat id). Prefer this over busy-polling `mailbox wait` when the harness is the coordination plane.

### Recovery
| Symptom | Action |
|---------|--------|
| `already owns this workspace` | Stop other harness PID; delete stale `.ai-bus/runtime/harness/server.lock` only if PID dead |
| Lost tokens after restart | Expected — instance rotates; re-read paths from serve stdout / start() |
| Bus halted | `mailbox resume --add-rounds N` then retry |
| 409 request_id_reuse | Same id, different body — change id or body intentionally |
| 409 indeterminate_request | Crash mid-flight — inspect evidence; new id |
| Port in use | `--port 0` or free 47831 |
| worker-client endpoint invalid | Start harness; confirm seat in `endpoint.json` seats list |
| worker-client credential malformed | Token missing/rotated — restart harness or fix credentials dir |

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
