# Local Testing (v0.2)

Run before commit, VSIX install, or Marketplace work.

## What each command actually covers

| Command | Covers | Does **not** cover |
|---------|--------|--------------------|
| `npm test` | `tsc` + `node --test tests/*.test.js` (unit/integration in Node) | Extension host, VSIX install, real VS Code activation |
| `npm run check` | `npm test` **and** `npm audit --audit-level=high` | Extension host / VSIX |
| `npm run test:vscode:source` | Real VS Code, extension loaded from this source tree | Packaged Marketplace artifact |
| `npm run test:vscode:vsix` | Package → install into empty profile → lifecycle smoke on **that** VSIX | Fast iteration |
| `npm run test:all` / `check:release` | Node suite + both VS Code tiers (or check + vscode) | Marketplace identity / CI on GitHub |

**Do not quote `npm test` alone as the release bar.** Agents and humans have done that and missed entire tiers. Prefer `npm run check` for everyday gates and `npm run test:all` (or `check:release`) before merge when a desktop with VS Code is available.

## One-time setup

```bash
npm install
npm run compile
npm run check
```

Expect a green Node suite (mailbox, harness, capabilities, skse-devkit, lm-worker, worker-client as present). If compile fails, do not package.

### Automated VS Code extension-host smoke

On a desktop-capable machine with VS Code installed:

```bash
npm run test:vscode
# or unit + extension-host checks together
npm run test:all
# run only the source-tree lifecycle smoke
npm run test:vscode:source
# package, install, discover, and test the exact shipped VSIX in an isolated profile
npm run test:vscode:vsix
# release-oriented unit + installed-artifact checks
npm run test:release
```

The source runner uses an isolated temporary multi-folder workspace and a VS Code executable resolved in this order: `VSCODE_EXECUTABLE_PATH`, a conventional local installation, and failing both, one **downloaded automatically** by `@vscode/test-electron`. A pre-installed editor is therefore not required, contrary to what this section claimed until 2026-08-10. It verifies ownership-safe staging, forged-manifest resistance, external-ledger integrity failure, suspend conflict preservation, symlink/junction ancestor rejection, authenticated live harness, explicit stop, suspend/resume restoration, workspace-folder removal, and actual extension-host deactivation cleanup. It also checks that the recorded loopback port refuses connections and that the endpoint, lock, and instance credential directory are gone after each stop boundary.

The VSIX runner packages into a temporary directory, installs into a unique empty extensions directory, confirms the precise extension/version inventory and loaded physical path, checks critical shipped assets, then runs the lifecycle smoke through a separate no-op test driver. This prevents a source checkout from shadowing the artifact under test. Packaging invokes `vscode:prepublish`, so a clean clone cannot ship absent or stale `dist/` output.

Both extension-host scripts run beneath a process-tree watchdog (three minutes for source, four minutes for install/package). Before launching Electron, each runner publishes a narrowly scoped cleanup manifest. A timeout terminates the owned Electron/Node descendants, validates and removes only the recorded temporary fixture and workspace credential namespaces, then exits 124.

This is an Electron extension-host test, not a browser-style headless test. Linux CI needs a display such as `xvfb-run`; keep `npm test` as the portable fast gate where desktop execution is unavailable.

## Extension Development Host

1. Open **this** repository in VS Code.
2. **F5** → Run Portable AI Bus Extension.
3. Open a **throwaway** workspace folder (empty git repo is ideal).

### Workflow smoke

1. Chat: `@ai-bus help`
2. `@ai-bus instructions`
3. `@ai-bus initialize the bus for this repo`
4. Confirm:
   - `.ai-bus/`
   - `.ai-bus/bin/mailbox.js`
   - `.ai-bus/bin/harness.js`
   - `.ai-bus/bin/worker-client.js`
   - `.ai-bus/bin/workspace-key.js`
   - `.ai-bus/bin/skse-devkit.js`
   - Provider files as selected (`AGENTS.md` / `CLAUDE.md` / `GROK.md`)
   - `docs/ai-status.md`, `ai-plan.md`, `ai-handoff.md`, `ai-review.md`
   - `tmp/ai-prompts/current.txt` (if workflow prompts enabled)
5. `@ai-bus show status` / `show next prompt`
6. `@ai-bus start task: Smoke test goal: Verify overlay validation: npm test`
7. `@ai-bus set phase to READY_FOR_IMPLEMENTATION` → status updates
8. Start a VS Code-managed harness, then Suspend → owned harness/credentials stop, overlay removed, `.ai-bus/runtime/` kept → Resume → restore. Start again, then Remove → owned harness stops and workspace copy is cleaned.
9. Start a harness outside this VS Code window; **Stop Harness** must report that this window owns no harness and leave the external process running. Stop it normally before testing Suspend/Remove.

### Mailbox smoke

10. `@ai-bus mailbox status` (agents/rounds/claims)
11. Command Palette → **Mailbox Send** (`codex` → `grok`, short body)
12. `@ai-bus inbox for grok` shows unread
13. Terminal in test workspace:

```bash
node .ai-bus/bin/mailbox.js status
node .ai-bus/bin/mailbox.js claim --agent grok --paths docs/ai-status.md --why smoke
node .ai-bus/bin/mailbox.js release --agent grok
node .ai-bus/bin/mailbox.js doctor
```

14. Halt-policy smoke:

```bash
node .ai-bus/bin/mailbox.js configure-halting --on-step true --on-goal true --at-rounds 3 --every-rounds 5
node .ai-bus/bin/mailbox.js complete-step --agent grok --summary "smoke step" --evidence "npm test"
# expect halted; completion appears in status/transcript
node .ai-bus/bin/mailbox.js resume
node .ai-bus/bin/mailbox.js complete-goal --agent operator --summary "smoke goal" --evidence "npm test"
# expect halted; resume does not erase either completion or policy
node .ai-bus/bin/mailbox.js resume
```

In a fresh mailbox, verify the defaults independently: `maxRounds=32`, step completion continues, goal completion halts, `atRounds=[]`, `everyRounds=null`. For explicit/every-N/hard-cap cases, verify the triggering message exists before `halted=true`. After a hard-cap halt, verify plain resume cannot create capacity and `resume --add-rounds 4` can.

### Harness smoke (optional but recommended)

```bash
node .ai-bus/bin/harness.js serve --root . --port 0
# note token paths printed / credentials dir
```

In another shell (replace port + token):

```cmd
curl -s -H "Authorization: Bearer <operator-token>" http://127.0.0.1:<port>/v1/tools
curl -s -H "Authorization: Bearer <operator-token>" -H "Content-Type: application/json" ^
  -d "{\"requestId\":\"t1\",\"name\":\"mailbox_status\",\"input\":{}}" ^
  http://127.0.0.1:<port>/v1/tool
```

The block is `cmd` on purpose: `^` is cmd.exe's line continuation. In Bash use `\` instead, and
note that in PowerShell `curl` is an alias for `Invoke-WebRequest` — call `curl.exe` explicitly.

Checks:
- No auth → 401 with structured error
- Seat token cannot `from` another agent
- Duplicate `requestId` same body → same result
- After `mailbox halt`, claim/send via harness → 423
- Operator token cannot forge a worker heartbeat
- Two clients competing for one seat → second gets `409 lease_held`
- Let a lease expire, reacquire it, then use the old identity → `409 lease_lost`
- `/v1/status` reports `live`, then `stale`; treat both as advisory observations, never proof of work
- Two processes using one logical client ID but different acquisition nonces cannot share a lease; retrying one nonce returns the same lease
- Wake pages and HTTP responses stay bounded, and a persisted cursor resumes after the last successfully delivered sequence
- Harness restart rotates `instanceId` and tokens; the old lease cannot be renewed

Worker client (harness still up):

```bash
node .ai-bus/bin/worker-client.js wait --root . --seat grok --timeout-ms 3000
# in another shell, mailbox send to grok; wait should return wake=message
node .ai-bus/bin/worker-client.js watch --root . --seat grok
# Ctrl+C ends watch; no VS Code UI required
node .ai-bus/bin/worker-client.js status --root . --seat grok
node .ai-bus/bin/worker-client.js read --root . --seat grok --all
node .ai-bus/bin/worker-client.js claim --root . --seat grok --paths docs/ai-status.md --why smoke
node .ai-bus/bin/worker-client.js release --root . --seat grok --paths docs/ai-status.md
```

For `watch`, send mail with increasing `seq`; confirm stdout emits each new sequence once and does not hot-loop on unchanged unread mail. Restart the harness and confirm stderr reports a bounded disconnect/reconnect transition while stdout remains JSON-only. Ctrl+C during an active long-poll should return promptly and attempt release. Stop the harness cleanly and confirm active wakes abort and the current credentials instance directory is removed.

The automated process test launches three independent seat processes, proves separate leases/wakes/releases, performs authenticated reads and claims, rejects cross-seat forgery and swapped credentials, checks strict parser failures cannot release claims, and verifies request-ID idempotency across OS processes. For manual negatives, try `release --paths`, `release --path x`, a duplicate option, and an unknown option; all must exit nonzero before contacting the harness.

### VS Code harness and reminder smoke

1. Command Palette → **Start Harness**; repeat it and confirm the same window does not create a second server.
2. **Show Harness and Worker Status**; confirm endpoint, instance, PID, ownership, and lease timestamps agree with runtime files.
3. **Stop Harness**; confirm only the owned instance stops. Repeat and confirm it reports no owned harness.
4. Enable `portableAiBus.harness.autoStart`, reload an initialized workspace, and confirm one harness starts. Suspend the bus, reload, and confirm auto-start does not bypass suspension.
5. With reminder interval set to 5 seconds, establish the initial quiet baseline. Send new mail and expect one unread notification; unchanged polls must not repeat it. While the harness stays running, stop heartbeats and let a previously live lease expire; expect one stale notification.
6. Disable each notification setting independently. Confirm the status bar still refreshes, but the matching pop-up does not appear.
7. Observe process/model logs while reminders fire: there must be no model invocation, mailbox acknowledgement, claim release, worker launch, or process revival.

### Capabilities smoke

```bash
# after initialize, capabilities.json should exist or be copied from template
node .ai-bus/bin/mailbox.js doctor
# if capabilities CLI staged:
# node .ai-bus/bin/capabilities.js run --id bus.doctor --root .
```

Confirm receipt under `.ai-bus/runtime/receipts/` with redacted tails, `shell: false` semantics (no injection via args).

### SKSE adapter smoke (no real kit required for unit tests)

Unit tests use a fake kit layout. Optional real kit:

```cmd
set "SKSE_DEVKIT_ROOT=C:\path\to\SKSEDevKit"
node .ai-bus/bin/skse-devkit.js doctor --workspace .
```

PowerShell: `$env:SKSE_DEVKIT_ROOT = 'C:\path\to\SKSEDevKit'` ·
Bash: `export SKSE_DEVKIT_ROOT=/c/path/to/SKSEDevKit`

Expect nested `tools/cmake/bin/cmake.exe`, `tools/vcpkg`, `libraries/CommonLibSSE-NG`, sample project list.
**Do not** require a full configure/build for CI; that needs VS/MSVC.

### LM worker smoke (optional)

1. Settings: leave `languageModelWorker.enabled` false initially.
2. Command Palette → **Run Language Model Worker**.
3. Confirm it asks to enable / select model only when you invoke it.
4. Confirm it stops at `maxTurns`.
5. Confirm **no** background activity after the command finishes.
6. Unify: only test if installed; document as optional provider.

## Command Palette checklist

- Initialize / Start Task / Show Status / Show Next Prompt / Set Phase
- Suspend / Resume / Remove
- Open Settings / Open Human Instructions
- Mailbox Status / Inbox / Send / Claim / Release
- Start / Stop / Show Harness and Worker Status
- Configure Round, Step, and Goal Halting
- Record Step Completion / Record Goal Completion
- Run Language Model Worker

## Settings checklist

- `portableAiBus.instructionsFile`
- `portableAiBus.commandReference`
- `portableAiBus.providers`
- `portableAiBus.stageTasksJson`
- `portableAiBus.stageCompatibilityWrappers`
- `portableAiBus.showStatusBar`
- `portableAiBus.autoInitializeOnOpen`
- `portableAiBus.languageModelWorker.*`
- `portableAiBus.harness.port`
- `portableAiBus.harness.autoStart`
- `portableAiBus.reminders.intervalSeconds`
- `portableAiBus.reminders.notifyUnread`
- `portableAiBus.reminders.notifyStaleWorkers`

## VSIX package check

```bash
npm run compile
npm test
npm run package
```

Install `.vsix` into a normal VS Code window and repeat **workflow + mailbox** smokes (not full harness matrix unless shipping harness UX).

## Failure watchlist

- Chat participant missing
- `mailbox.js` / `harness.js` / `skse-devkit.js` not staged
- `bin/brain/cli.js`, `brains/agent-seat.js`, scripts, or `node_modules/node-pty` not staged
- Claims ignored by agents (process issue, not bus)
- Harness binding non-loopback (must not)
- Tokens committed to git (must not)
- Lease shown as proof that a model is progressing (it is advisory only)
- Reminder timer acknowledging mail or invoking/restarting a model (must not)
- Suspend/remove stopping an external harness that this VS Code window does not own
- `watch` repeating unchanged unread sequences or writing connection diagnostics to stdout
- Halt checkpoint dropping the message that triggered it
- LM worker running without explicit command
- Docs describing Unify as required (it is not)
- SKSE adapter claiming the VSIX embeds toolchains (it does not)
- Clarification being recorded as goal completion

## Distribution bundle check

Use a tiny disposable Dev Kit fixture in automated tests. Do not copy the multi-gigabyte real kit:

```bash
npm run distribution -- --devkit-root <fixture> --out <unused-output> --dry-run
```

Confirm dry-run creates no output. For an authorized release build, confirm `manifest.json`
contains the VSIX and every copied `devkit/` file with byte size and SHA-256, then independently
rehash a sample. Run staged `skse-devkit.js doctor` against the copied payload. The manifest
proves transfer integrity, not licensing or toolchain completeness.

## Minimum bar before commit / share

- [ ] `npm run check` green (Node tests **plus** audit — not `npm test` alone)
- [ ] On a desktop with VS Code: `npm run test:vscode:vsix` or full `npm run test:all`
- [ ] F5 or installed VSIX: initialize + mailbox send/inbox
- [ ] Installed VSIX stages and loads the generic brain plus bundled `node-pty`
- [ ] Docs match staged bin names and v0.2 behaviour
- [ ] No secrets in repo
- [ ] PROVENANCE still accurate if dependencies changed
- [ ] If merging to `main`: GitHub CI must run at least `npm ci` + `npm run check` (see PR process); do not merge on agent-asserted green only
