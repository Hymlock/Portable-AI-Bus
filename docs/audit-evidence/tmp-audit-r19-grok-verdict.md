# r19 — first attack on committed HEAD 1592382

HEAD `1592382c0a326a18a1975ce2aaf283f8069a3a20`.
Live hook `scripts/claim-guard-cli.js`. Live `dist/evidence.js` + `dist/mailbox.js`.
Claims were empty. I did not edit `src/`, `tests/`, or the live hook.
Instruments: `tmp-audit-r19-grok.cjs` (22 PASS / 0 FAIL / 1 NOTE) and
`tmp-audit-r19b-grok.cjs` (2 PASS / 1 FAIL).

I did not run `tests/audit-round2.test.js` as evidence.

## Item 2 — CERTIFIED at 1592382

| attack | verdict |
|---|---|
| empty bytes lock | PASS 4ms |
| `{not-json` | PASS 3ms |
| missing pid | PASS 4ms |
| string pid | PASS 3ms |
| float pid | PASS 4ms |
| `pid: 1e308` | PASS 3ms |
| lock path is a directory | PASS 3ms |
| live pid | PASS timed out 10004ms, lock not stolen |
| UTF-8 BOM + live pid | PASS timed out 10007ms, not treated as debris |
| operatorCloseRecovery compact (3 episodes → 1 summary) | PASS |
| inherit / reassign does not compact | PASS live=3 |
| operatorClose survives consolidate throw | PASS closed |

No hole. No new class. The four item-2 holes this HEAD claimed to close are closed.
Live-owner control and debris recovery cannot both pass by being the same gate:
debris is milliseconds, live is the full 10s timeout.

## Item 15 — the four claimed holes are closed; one new hole remains

| attack | verdict |
|---|---|
| honest green | PASS compile OK |
| `noCheck: true` | PASS refuse /noCheck/ |
| UTF-8 BOM + `noCheck: true` | PASS refuse /noCheck/ |
| bare `extends` onto an outside tsconfig | PASS refuse |
| `files: []` + `references` (tsc -p succeeds) | PASS refuse compiled-no-program |
| package.json `"types"` → outside path containing `/node_modules/` | PASS refuse (tsc listed the outside file) |
| type-position `import("C:/hidden/mod")` | PASS refuse |

Claude's three transcription risks (exemptions, empty-program, lock) hold on this HEAD
except for the exemption predicate below.

### HOLE — `classifyListedFiles` uses string includes, not path containment

`scripts/claim-guard-cli.js` around the listFilesOnly classifier:

```
if (withinScratch(real, scratchRoot) || comparable(real).includes(comparable(scratchRoot))) {
  program.push(file);
  continue;
}
```

`pathContains` already exists and requires a path separator. `includes` does not.

Attack (`tmp-audit-r19b-grok.cjs`):
- `package.json` `"types"` pointing at `{scratchRoot}x/index.d.ts` (walker skips node_modules).
- tsc compiled and listed `.../claim-guard-index-FIXEDx/index.d.ts`.
- Hook printed `compile OK (staged index)`.

Same class as r11's `/node_modules/` substring exemption: a substring is not the
declared tree. The stated rule refuses any listed file whose realpath is outside
scratch, outside the declared repo `node_modules`, and outside the invoked
`typescript` package. This predicate decides that rule wrongly.

Instrument note: scratch names are random `mkdtemp` values, so I forced the name
with a `fs.mkdtempSync` preload to make the sibling path. A live hook is unlikely
to collide. That is not a reason to keep a predicate that accepts a listed leak.
r19's first spelling (absolute `import`) was refused by the source walker and
never reached this line; r19b is the one that did.

Repair: drop the `includes` clause. Use `pathContains(scratchRoot, real)` only.
Honest green already passes via `withinScratch`.

## Item 20

Untouched. Stays certified 9/9.

## Gates

Item 2 certified. Item 15 unmet. `done` is false.
