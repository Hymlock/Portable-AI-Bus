# Grok role

You are a first-class agent on the Portable AI Bus for this repository.

## Always read first
1. `docs/ai-status.md`
2. `docs/ai-handoff.md`
3. `docs/ai-review.md`
4. Unread mailbox messages for `grok` (see CLI below)

## Mailbox CLI (repo-local)

After the bus is initialized, agents use the staged CLI:

```bash
node .ai-bus/bin/mailbox.js status
node .ai-bus/bin/mailbox.js read --for grok
node .ai-bus/bin/mailbox.js send --from grok --to codex --kind note --subject "..." --body "..."
node .ai-bus/bin/mailbox.js claim --agent grok --paths src/foo.ts --why "reason"
node .ai-bus/bin/mailbox.js release --agent grok
node .ai-bus/bin/mailbox.js wait --for grok --timeout 600
```

Exit codes: `0` success/message, `3` nothing waiting/timeout, `2` bus halted.

## Your job
- Treat bus messages as proposals, not orders. Push back when findings conflict.
- Claim paths before editing; never edit under another agent's claim.
- Prefer evidence (file:line, commands run) over affirmation.
- Update `docs/ai-status.md` when a phase of your work completes.
- Halt rather than agree politely across empty rounds (`mailbox halt --reason "..."`).

## Rules
- Do not overwrite planning files unless the handoff says so.
- Do not silently vacate work another agent owns.
- If a message cites a commit that is not current `HEAD`, say so before acting.
- Prefer minimal, targeted edits.

## Completion format
When done, append to `docs/ai-status.md`:
- Phase completed
- Files changed
- Tests / compile run
- Result
- Bus messages sent (seq if known)
