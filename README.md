# Portable AI Bus

Portable AI Bus is a Visual Studio Code extension project that stages a reusable `.ai-bus` bundle into the current workspace and drives the workflow through VS Code chat instead of terminal commands.

## Target UX
- Install the extension from the Extensions view.
- Open a repository in VS Code.
- Use `@ai-bus` in chat to initialize, start tasks, inspect status, suspend, resume, remove the bus, and open the human instructions.
- Keep the staged workspace payload under `.ai-bus/` so the workflow remains portable and inspectable.

## Chat-first commands
The extension contributes an `@ai-bus` participant with these basic instruction commands:

- `instructions`
- `initialize the bus for this repo`
- `start task: Fix auth timeout goal: Keep tests green validation: npm test`
- `show status`
- `show next prompt`
- `set phase to READY_FOR_REVIEW`
- `suspend the bus`
- `resume the bus`
- `remove the bus`
- `open settings`

## Settings
Settings are exposed under `Portable AI Bus` in the VS Code settings UI:

- `portableAiBus.instructionsFile`
- `portableAiBus.providers`
- `portableAiBus.stageTasksJson`
- `portableAiBus.stageCompatibilityWrappers`
- `portableAiBus.showStatusBar`
- `portableAiBus.autoInitializeOnOpen`

`portableAiBus.instructionsFile` points to the staged human guide file in the workspace. The extension also exposes `Portable AI Bus: Open Human Instructions`.

## Repo layout
- `src/`: VS Code extension entrypoint and workspace bus runtime
- `templates/`: staged workflow files copied into the workspace
- `providers/`: provider registry used for auto-detection and provider file installation
- `bin/`: existing Node scripts preserved inside the staged `.ai-bus` bundle
- `*.ps1` and `*.cmd`: legacy compatibility wrappers that can still be staged if the extension setting enables them

## Local development
```bash
npm install
npm run compile
```

Then press `F5` in VS Code to launch an Extension Development Host and test the `@ai-bus` participant.
Detailed local verification steps are in `TESTING.md`.

## Packaging
```bash
npx @vscode/vsce package
```

## Publish polish still expected
Before publishing to the Marketplace, replace these placeholders in `package.json`:

- `publisher`
- `repository.url`
- `homepage`
- `bugs.url`

The bundled icon and Marketplace metadata are now present so the extension packages cleanly, but those identity fields should point at the real project before publish.
