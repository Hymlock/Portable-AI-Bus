# Portable AI Bus: Plain English Guide

## What this is
Portable AI Bus is a Visual Studio Code extension workflow for coordinating AI planning, implementation, and review through shared workspace files.

It does not create a live AI-to-AI chat.

Instead, it stages a reusable `.ai-bus` folder into the current repo and uses shared docs as the handoff system:
- one AI writes the plan
- another AI implements
- the first AI reviews
- both can read the current workflow state from the same files

## What changed
The main user experience is now VS Code first:
- install the extension from the Extensions view
- open a repo
- use `@ai-bus` in chat
- keep terminal commands as compatibility/debug tools, not as the normal user path

## Why this exists
Tools like Codex and Claude can both work with the same repo, but they do not automatically share a structured workflow inside the editor.

This system turns the repo into the shared handoff surface.

## The basic idea
When the bus is active, it stages:
- `.ai-bus/`
- `AGENTS.md`
- `CLAUDE.md`
- `docs/ai-status.md`
- `docs/ai-plan.md`
- `docs/ai-handoff.md`
- `docs/ai-review.md`
- `tmp/ai-prompts/current.txt`

In simple terms:
- `ai-plan.md` = the plan
- `ai-handoff.md` = exact instructions for the coding AI
- `ai-review.md` = review feedback and fixes
- `ai-status.md` = the current state of the workflow

## Who this is for
This is for a human who wants to coordinate more than one AI assistant in the same repo without letting them step on each other.

It is especially useful if:
- one AI is better at planning and review
- another AI is better at implementation
- you want a repeatable workflow
- you sometimes need to pause the system and come back later

## What "Portable" means
There are still two copies of the system:

1. The reusable extension bundle
   This is the packaged extension content that gets installed in VS Code.

2. The repo-local copy
   This is the staged copy inside a repo:
   `.ai-bus`

The extension bundle is the reusable source.
The repo-local `.ai-bus` copy is the one that actually runs inside a project.

## What happens when you initialize it
When the bus is initialized into a repo:
- the extension stages itself into the repo as `.ai-bus`
- it creates the workflow files in the repo
- it adds local ignore rules so those files do not clutter normal git work
- it gives the repo a repeatable workflow for multiple AI tools

## What "provider detection" means
The bus can check which AI environments seem to be present in the repo.

Right now it is built to understand:
- Codex
- Claude Code

If it detects both, it sets up both.

If it detects only one, it fills in the recommended pair anyway.

If it detects none, it falls back to the built-in Codex + Claude setup.

## How the workflow works
The normal workflow is:

1. Planning
   Claude or the planning AI inspects the repo and writes the plan.

2. Handoff
   The planner writes exact coding instructions for the implementation AI.

3. Implementation
   Codex or the coding AI makes the code changes.

4. Review
   The reviewer checks the changes and either approves them or writes required fixes.

5. Fix loop
   The coding AI applies the fixes and sends the work back for review.

This repeats until the task is done.

## What suspend and resume do
Sometimes you do not want the bus active all the time.

`Suspend`:
- removes the active workflow files from the repo root
- keeps the current bus state saved inside `.ai-bus/runtime/`

`Resume`:
- restores the saved bus files back into the repo root

So suspend does not throw away the work.
It just puts the system away temporarily.

## What remove does
`Remove` uninstalls the active bus overlay from the repo.

That means:
- the staged working files are removed
- the repo-local `.ai-bus` copy is removed too
- the repo goes back to normal

## How a human is expected to use it
You are not expected to remember shell syntax.

The normal path is to use VS Code chat with `@ai-bus`, for example:
- `instructions`
- `initialize the bus for this repo`
- `start task: Fix X goal: Keep tests green`
- `show status`
- `show next prompt`
- `set phase to READY_FOR_REVIEW`
- `suspend the bus`
- `resume the bus`
- `remove the bus`
- `open settings`

## Settings and instructions
The extension settings include:
- the staged human instructions file path
- the basic chat instruction commands
- provider and staging options

The human instructions file is staged into the workspace at:
- `.ai-bus/HUMAN_GUIDE.md`

## Compatibility note
The repo still contains legacy `.ps1`, `.cmd`, and Node entrypoints for compatibility and debugging.

Those are no longer the primary user experience.
The intended front door is the VS Code extension and `@ai-bus` chat.

## Suggested quick test
1. Install the extension in VS Code.
2. Open a repo.
3. Run `@ai-bus instructions`.
4. Run `@ai-bus initialize the bus for this repo`.
5. Run `@ai-bus start task: Smoke test the bus goal: Verify initialize, status, suspend, resume, and remove`.
6. Run `@ai-bus show status`.
7. Run `@ai-bus suspend the bus`.
8. Run `@ai-bus resume the bus`.
9. Run `@ai-bus remove the bus`.

## Important limitation
This does not create true autonomous AI-to-AI communication.

It creates a structured shared workspace that makes the collaboration predictable and easy to resume.

## Where to look next
- `README.md` for the technical overview
- `OPERATOR.md` for the AI command vocabulary
- `providers/providers.json` for supported AI providers
