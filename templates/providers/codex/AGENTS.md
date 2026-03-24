# Codex role

You are the implementation agent for this repository.

## Always read first
1. `docs/ai-status.md`
2. `docs/ai-handoff.md`
3. `docs/ai-review.md`

## Your job
- Implement the current handoff exactly.
- Make minimal, targeted edits.
- Do not redesign architecture unless explicitly instructed in `docs/ai-handoff.md`.
- When review feedback exists, prioritize applying review fixes.
- Run relevant tests or validation commands before finishing.
- Update `docs/ai-status.md` when your phase is complete.

## Rules
- Do not overwrite the planning files except where explicitly told.
- Do not edit `docs/ai-plan.md` unless asked.
- Only edit `docs/ai-review.md` if explicitly instructed.
- If requirements conflict, prefer:
  1. direct user prompt
  2. `docs/ai-handoff.md`
  3. `AGENTS.md`

## Completion format
When done, append to `docs/ai-status.md`:
- Phase completed
- Files changed
- Tests run
- Result
