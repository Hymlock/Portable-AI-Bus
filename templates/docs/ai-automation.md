# AI Automation

## Goal
Use a local overlay to automate a repo-based Codex and Claude handoff loop without adding tracked project changes.

## Primary user flow
The intended user-facing flow is through the VS Code extension and `@ai-bus` chat:

1. Initialize the bus for the repo.
2. Start a task.
3. Ask for status or the next prompt.
4. Move phases as planning, implementation, and review progress.
5. Suspend, resume, or remove the overlay when needed.

## Basic chat commands
- `instructions`
- `initialize the bus for this repo`
- `start task: <task> goal: <goal> validation: <command>`
- `show status`
- `show the next prompt`
- `set phase to READY_FOR_CODEX`
- `suspend the bus`
- `resume the bus`
- `remove the bus`
- `open settings`

## Compatibility/debug commands
These local commands still exist for compatibility and debugging:

```bash
node .ai-bus/bin/validate_ai_bus.js
node .ai-bus/bin/ai_bus.js status
node .ai-bus/bin/ai_bus.js prompt
node .ai-bus/bin/ai_bus.js init --task "..." --goal "..."
node .ai-bus/bin/ai_bus.js set-phase --phase READY_FOR_CODEX --actor Claude --summary "Planning complete" --next Codex
node .ai-bus/bin/ai_bus.js watch
```

## Prompt files
Current prompt artifacts are written to:
- `tmp/ai-prompts/current.txt`
- `tmp/ai-prompts/planning.txt`
- `tmp/ai-prompts/ready_for_codex.txt`
- `tmp/ai-prompts/ready_for_review.txt`
- `tmp/ai-prompts/ready_for_fixes.txt`

## Local overlay behavior
- Installed files are ignored through `.git/info/exclude` when the repo has a local Git directory.
- Remove uninstalls the staged overlay from the repo root.
- Suspend preserves staged state under `.ai-bus/runtime/`.
