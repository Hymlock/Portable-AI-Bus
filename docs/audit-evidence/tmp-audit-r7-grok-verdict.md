# r7 live re-measure (grok) — not a certification of HEAD

HEAD: `373e17650558eaef550bc94486b5cfc8d59abd2f`
Instrument: `tmp-audit-r7-grok.cjs` → `tmp-audit-r7-grok-out.json`
This wake, against live `scripts/claim-guard-cli.js` and `dist/`. Not the author suite.
Did not edit `src/` or `tests/`. Claude still holds the four repair paths.

Live this session: item 15 0P/4F; item 2 0P/2F; item 20 4P/0F.

## Item 15 — four holes still live

| attack | result |
|---|---|
| bare `extends: "leak-config/tsconfig.json"` | FAIL — `compile OK (staged index)`, exit 0 |
| `include: ["node_modules/leak-src"]` junction onto worktree `src` | FAIL — `compile OK (staged index)`, exit 0 |
| `/// <reference path="C:/.../hidden-fix.d.ts" />` | FAIL — `compile OK (staged index)`, exit 0 |
| `{ files: [], references: [{ path: "./packages/lib" }] }` | FAIL — `compile OK (staged index)`, exit 0 |

## Item 2 — two holes still live

| attack | result |
|---|---|
| empty `evidence.json.lock` then `record()` | FAIL — 10004 ms, `Timed out waiting for the evidence lock` |
| three episodes then `operatorCloseRecovery` | FAIL — closed, 0 summaries, 3 live, reason `operator-closed: stranded` |

## Item 20 — live answers to #1868 (still certified)

Rule accepted: an operator can always close any checkpoint, and the reason is recorded.

| attack | result |
|---|---|
| seat surfaces | PASS — no match in harness, contract, bus-client, agent, worker-client, vscode-lm-worker, extension |
| non-numeric `--work-id abc` | PASS — CLI exit 1, `no open checkpoint for that seat and work-id; nothing was closed`; original row still open |
| who closed it | PASS as thin-rule, not a hole — row keys are `actionReceipts,closeReason,closedAt,id,note,openedAt,seat,status,updatedAt,workId`. No `operator` / `closedBy` / `actor`. Reason is `operator-closed: stranded after pty died` |
| concurrent `operatorCloseRecovery` vs `openRecovery` | PASS (serializes) — close wrote `operator-closed: race-close` on the original row; open created a NEW open checkpoint (`note=race-open`); leftover is open; recall yes. No torn write. Close-then-open is a new row, as previously stated from reading. |

CLI-only remains a usability consequence of the security rule, not a hole.

## Bar

Open dependency unchanged: Claude holds `scripts/claim-guard-cli.js`, `src/evidence.ts`, `src/mailbox.ts`, `tests/audit-round2.test.js`.
r5 brief and r6 patches (18/18 on the patch, not on HEAD) are already mailed. I will not resend them.
`done` is false.
