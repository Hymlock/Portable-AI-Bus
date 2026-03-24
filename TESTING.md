# Local Testing

Use this before any Marketplace publish work.

## One-time setup
1. Run `npm install`.
2. Run `npm run compile`.
3. Open this project in VS Code.
4. Press `F5` and choose `Run Portable AI Bus Extension`.

This opens an Extension Development Host with the extension loaded from your local workspace.

## Recommended test workspace
Use a separate throwaway repo or folder as the target workspace for testing.

Good options:
- an empty folder initialized with Git
- a small sample repo
- a copy of a real repo that you do not mind modifying locally

## Core smoke test
In the Extension Development Host:

1. Open the test workspace folder.
2. Open chat and use `@ai-bus help`.
3. Run `@ai-bus instructions`.
4. Run `@ai-bus initialize the bus for this repo`.
5. Confirm these appear:
   - `.ai-bus/`
   - `AGENTS.md`
   - `CLAUDE.md`
   - `docs/ai-status.md`
   - `docs/ai-plan.md`
   - `docs/ai-handoff.md`
   - `docs/ai-review.md`
   - `tmp/ai-prompts/current.txt`
6. Run `@ai-bus show status`.
7. Run `@ai-bus show next prompt`.
8. Run `@ai-bus start task: Smoke test the bus goal: Verify extension workflow validation: npm test`.
9. Confirm `docs/ai-plan.md`, `docs/ai-handoff.md`, and `docs/ai-review.md` were initialized for that task.
10. Run `@ai-bus set phase to READY_FOR_CODEX`.
11. Run `@ai-bus show status` again and confirm the phase changed.
12. Run `@ai-bus suspend the bus`.
13. Confirm staged workspace files were removed and `.ai-bus/runtime/` contains suspend state.
14. Run `@ai-bus resume the bus`.
15. Confirm staged workspace files are restored.
16. Run `@ai-bus remove the bus`.
17. Confirm `.ai-bus/`, staged docs, and prompt artifacts are removed.

## Command palette checks
Also verify these commands work from the Command Palette:
- `Portable AI Bus: Initialize Workspace`
- `Portable AI Bus: Start Task`
- `Portable AI Bus: Show Status`
- `Portable AI Bus: Show Next Prompt`
- `Portable AI Bus: Set Phase`
- `Portable AI Bus: Suspend Workspace Bus`
- `Portable AI Bus: Resume Workspace Bus`
- `Portable AI Bus: Remove Workspace Bus`
- `Portable AI Bus: Open Settings`
- `Portable AI Bus: Open Human Instructions`

## Settings checks
Open settings and verify:
- `portableAiBus.instructionsFile`
- `portableAiBus.commandReference`
- `portableAiBus.providers`
- `portableAiBus.stageTasksJson`
- `portableAiBus.stageCompatibilityWrappers`
- `portableAiBus.showStatusBar`
- `portableAiBus.autoInitializeOnOpen`

## Packaging check
Run:

```bash
npm run compile
npx @vscode/vsce package --no-dependencies
```

Then install the generated `.vsix` into a normal VS Code window and repeat the smoke test once outside the Extension Development Host.

## Failure cases to watch for
- `@ai-bus` does not appear in chat
- commands appear but do nothing
- staged files are missing after initialize
- suspend removes files but resume does not restore them
- remove deletes too much from the workspace
- settings open to the wrong extension identifier
- status bar never updates

## Minimum bar before publish
- Extension Development Host smoke test passes
- Installed `.vsix` smoke test passes
- chat participant works in the VS Code version you intend to support
- staged files match the expected workflow
