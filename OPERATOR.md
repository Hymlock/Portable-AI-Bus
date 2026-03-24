# Portable AI Bus Operator Guide

Use simple English intents. The normal path is the `@ai-bus` chat participant inside Visual Studio Code.

## Primary intents
- `instructions`
- `initialize the bus for this repo`
- `start task: <task> goal: <goal> validation: <command>`
- `show status`
- `show the next prompt`
- `set phase to READY_FOR_REVIEW`
- `suspend the bus`
- `resume the bus`
- `remove the bus`
- `open settings`

## Example task-oriented forms
- `initialize the bus for this repo`
- `start task: Fix bazaar flow goal: Resolve the regression and keep validations green validation: npm test`
- `set phase to READY_FOR_CODEX`
- `suspend the bus until Claude is available again`
- `resume the bus`

## LLM mapping rules
- `instructions` opens the staged human guide file.
- `initialize` stages the reusable bundle into the repo as `.ai-bus`, installs provider files, and creates workflow docs.
- `start task` initializes the workspace if needed and writes the task/goal/validation into the bus docs.
- `status` shows current phase, task, next actor, and next prompt.
- `prompt` shows the next handoff prompt for the current phase.
- `set phase` updates `docs/ai-status.md` and refreshes prompt artifacts.
- `suspend` removes the active overlay from the repo root while preserving the current bus state under `.ai-bus/runtime/`.
- `resume` restores the suspended overlay back into the repo root.
- `remove` uninstalls the overlay from the repo and deletes the repo-local `.ai-bus` bundle copy.
- `open settings` opens the Portable AI Bus settings page.

## Provider rules
- Known providers are detected from repo markers.
- Current built-in providers are Codex and Claude Code.
- If only one or neither is detected, scaffold the recommended pair.
- If an unknown agent environment is needed, add it to `providers/providers.json` and its templates under `templates/providers/`.

## Settings rules
- The human instructions path is exposed in extension settings as `portableAiBus.instructionsFile`.
- The basic command surface is exposed in settings as `portableAiBus.commandReference`.
- Compatibility wrappers are optional and should remain off for a chat-only user experience.

## Maintenance rule
When updating the workflow surface, review:
- `README.md`
- `HUMAN_GUIDE.md`
- `OPERATOR.md`
- `templates/OPERATOR.md`
- `templates/docs/ai-automation.md`
- `package.json`
- `src/extension.ts`
- `src/bus.ts`

Keep the English intent vocabulary stable so different LLMs can reuse the same phrasing.

## Compatibility note
Legacy PowerShell, CMD, and Node entrypoints still exist for compatibility and debugging.

They are not the primary UX anymore.
The default user-facing path is the VS Code extension plus `@ai-bus`.
