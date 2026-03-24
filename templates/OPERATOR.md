# Portable AI Bus Operator Guide

Use simple English intents. The normal path is the `@ai-bus` chat participant inside Visual Studio Code.

## Supported intents
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

## Intent meanings
- `instructions` opens the staged human guide.
- `initialize` stages the local `.ai-bus` bundle and installs workflow files.
- `start task` writes a task into the staged workflow docs.
- `status` shows current bus state and the next prompt.
- `prompt` shows the next prompt for the active phase.
- `set phase` updates the workflow phase.
- `suspend` hides the active overlay while preserving state.
- `resume` restores the suspended overlay.
- `remove` uninstalls the overlay.
- `open settings` opens Portable AI Bus settings.

## Compatibility note
Legacy wrapper scripts may exist in some workspaces if compatibility staging is enabled.

They are optional.
The intended front door is VS Code chat with `@ai-bus`.
