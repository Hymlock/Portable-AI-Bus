# Local Testing (v0.2)

Run before commit, VSIX install, or Marketplace work.

## One-time setup

```bash
npm install
npm run compile
npm test
```

`npm test` = `tsc` + `node --test tests/*.test.js`.

Expect a green suite (mailbox, harness, capabilities, skse-devkit, lm-worker as present). If compile fails, do not package.

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
   - `.ai-bus/bin/skse-devkit.js`
   - Provider files as selected (`AGENTS.md` / `CLAUDE.md` / `GROK.md`)
   - `docs/ai-status.md`, `ai-plan.md`, `ai-handoff.md`, `ai-review.md`
   - `tmp/ai-prompts/current.txt` (if workflow prompts enabled)
5. `@ai-bus show status` / `show next prompt`
6. `@ai-bus start task: Smoke test goal: Verify overlay validation: npm test`
7. `@ai-bus set phase to READY_FOR_CODEX` → status updates
8. Suspend → overlay removed, `.ai-bus/runtime/` kept → Resume → restore → Remove → clean

### Mailbox smoke

9. `@ai-bus mailbox status` (agents/rounds/claims)
10. Command Palette → **Mailbox Send** (`codex` → `grok`, short body)
11. `@ai-bus inbox for grok` shows unread
12. Terminal in test workspace:

```bash
node .ai-bus/bin/mailbox.js status
node .ai-bus/bin/mailbox.js claim --agent grok --paths docs/ai-status.md --why smoke
node .ai-bus/bin/mailbox.js release --agent grok
node .ai-bus/bin/mailbox.js doctor
```

13. Optional halt/resume:

```bash
node .ai-bus/bin/mailbox.js halt --reason "test"
node .ai-bus/bin/mailbox.js send --from codex --to grok --subject x --body y   # expect fail / exit 2
node .ai-bus/bin/mailbox.js resume --add-rounds 4
```

### Harness smoke (optional but recommended)

```bash
node .ai-bus/bin/harness.js serve --root . --port 0
# note token paths printed / credentials dir
```

In another shell (replace port + token):

```bash
curl -s -H "Authorization: Bearer <operator-token>" http://127.0.0.1:<port>/v1/tools
curl -s -H "Authorization: Bearer <operator-token>" -H "Content-Type: application/json" ^
  -d "{\"requestId\":\"t1\",\"name\":\"mailbox_status\",\"input\":{}}" ^
  http://127.0.0.1:<port>/v1/tool
```

Checks:
- No auth → 401 with structured error
- Seat token cannot `from` another agent
- Duplicate `requestId` same body → same result
- After `mailbox halt`, claim/send via harness → 423

Worker client (harness still up):

```bash
node .ai-bus/bin/worker-client.js wait --root . --seat grok --timeout-ms 3000
# in another shell, mailbox send to grok; wait should return wake=message
node .ai-bus/bin/worker-client.js watch --root . --seat grok
# Ctrl+C ends watch; no VS Code UI required
```

Stop harness cleanly (Ctrl+C); confirm credentials instance dir removed.

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

```bash
set SKSE_DEVKIT_ROOT=C:\path\to\SKSEDevKit
node .ai-bus/bin/skse-devkit.js doctor --workspace .
```

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

## VSIX package check

```bash
npm run compile
npm test
npx @vscode/vsce package --no-dependencies
```

Install `.vsix` into a normal VS Code window and repeat **workflow + mailbox** smokes (not full harness matrix unless shipping harness UX).

## Failure watchlist

- Chat participant missing
- `mailbox.js` / `harness.js` / `skse-devkit.js` not staged
- Claims ignored by agents (process issue, not bus)
- Harness binding non-loopback (must not)
- Tokens committed to git (must not)
- LM worker running without explicit command
- Docs describing Unify as required (it is not)
- SKSE adapter claiming to vendor toolchains (it must not)

## Minimum bar before commit / share

- [ ] `npm test` green
- [ ] F5 initialize + mailbox send/inbox
- [ ] Docs match staged bin names and v0.2 behaviour
- [ ] No secrets in repo
- [ ] PROVENANCE still accurate if dependencies changed
