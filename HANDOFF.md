# Handoff — 2026-08-10

Written by the `claude` seat at 96% of its session limit. Everything below is committed; the
working tree is clean. Read this top to bottom before starting anything.

> **Update after `ece4b57` (2026-08-10):** both blocking defects below are resolved. Workspace
> removal preserves operator-owned `.ai-bus/toolchains/`, and provider-chain overrides now
> require two distinct vendors rather than two spellings for one vendor. The same reliability
> patch also retries transient Windows atomic-renames, prevents delayed acknowledgements from
> stealing a newer baton, and packages/tests `bus-tick` for the pilot chat. The follow-up adds
> `--workdir` to `bus-up`, `bus-console`, and the brain CLI, separating the repository seen by
> model providers from the durable coordination root. This was required for the project's
> central `Projects/ai-bus` topology; without it, agents could acknowledge repository tasks but
> launched their provider in a non-repository directory.
> A subsequent live goal change exposed and fixed stale assignment carryover: replacing a goal
> now starts with an empty assignment map, so no brain can wake into work owned by the old goal.

## Two open defects. Fix these before new work.

Both were found by the `codex` and `worker` seats during a documentation audit, and both are
**product bugs, not doc bugs**. The documentation now warns about them; the code does not yet
prevent them.

### 1. Remove Workspace Bus destroys an operator's Dev Kit

`removeUnlocked` in `src/bus.ts` (~line 570) runs `fs.rm(busDir, { recursive: true, force: true })`
over the whole `.ai-bus` tree. The word `toolchain` appears **nowhere** in that file, so a
multi-gigabyte kit at `.ai-bus/toolchains/skse-devkit` — where `DISTRIBUTION.md` tells operators
to put it — is deleted with no preservation and no confirmation.

**Fix:** preserve `toolchains/` across removal, or refuse and prompt when it is non-empty. A
test should install a fixture there and assert it survives.

### 2. The founding constraint is not enforced

`brains/agent-seat.js:30` checks `new Set(kinds).size < 2` — distinct provider **kinds**, not
distinct **vendors**. `PORTABLE_AI_BUS_PROVIDER_CHAIN=oauth,api` passes and is entirely
Anthropic, so one exhausted account stops that seat. That is precisely the failure the whole
chain design exists to prevent (*"if we run out of tokens on Codex our busses stopped"*).

**Fix:** map kinds to vendors (`cli`/`oauth`/`api` → anthropic, `codex` → openai, `grok` → xai)
and require two distinct **vendors**, with a clear error naming the single-vendor chain.

Also lower severity, all documented: exhaustion→baton reassignment is conditional (holder,
successor, five-minute cooldown, CAS); the `oauth` provider never calls `resolveAnthropicOAuth`,
so an ambient `ANTHROPIC_API_KEY` shadows the selected profile.

## Licensing: the Dev Kit cannot ship as-is

The `worker` seat's verdict, component by component: CMake BSD-3-Clause, Ninja Apache-2.0,
vcpkg MIT **but every installed port keeps its own licence**, CommonLibSSE-NG/SKSE
version-and-file-specific, and Microsoft permits redistribution only of designated **REDIST**
files — not MSVC Build Tools or Windows SDK trees. **Do not ship the 5.49 GiB payload** until a
per-file bill of materials and licence allowlist exist.

## What shipped today

`bus-tick.js` — a heartbeat emitter for the human-facing **chat operator session**, the half that
still falls asleep. It does not schedule autonomous brains. Brain processes keep going; the
operator's chat window ends its turn when it stops speaking. The tick
prints one state line per interval; a host that watches stdout re-enters the model on each line.
Reads the mailbox from **disk**, so it keeps beating when the harness dies.

Runtime fixes, in order found — each one hid the next:

| Fix | Was |
|---|---|
| `executePlan` returns failures | Tool errors discarded; a report lost to `403 unknown_seat` still logged `done` |
| Seat roster in the prompt | Nothing told a model which seats exist, so it invented `orchestrator` |
| Two caps distinguished | A brain out of *rounds* returned `done:true, capped:true`; the runner refused to continue it, stranding a seat whose note read "Audit is open" |
| `maxRounds` 3 → 12 | Enough to acknowledge and stop, not enough to investigate |
| Done requires evidence | A `task` wake cannot end in `done` without a send |
| A receipt is not a report | Seats satisfied that rule with acks — eight acks, zero findings |

**198 tests green.** Docs corrected in `239c033`.

## The documentation audit, and how to continue it

Method that worked, after three keyword passes missed a README describing the wrong product:
read end to end, extract every **claim**, **test** each against the running system, verdict
TRUE / FALSE / UNVERIFIABLE. A claim you did not execute is UNVERIFIABLE, not TRUE.

| Document | State |
|---|---|
| `README.md`, `HUMAN_GUIDE.md`, `TESTING.md`, `AUTH.md`, `DISTRIBUTION.md`, `LOOP_ARCHITECTURE.md` | Audited **and fixed** |
| `OPERATOR.md` | Audited; no false claims. All 20 commands need `initialize` first — that precondition is still unstated in the file |
| `docs/PROVENANCE.md` | **Audited, NOT fixed** — the one piece of unfinished work |

`PROVENANCE.md` states legal conclusions as fact: "does not copy", "the repository owner
identified these projects as their own work", "avoids carrying CC-BY-NC-ND terms", "does not
inherit this repository's license". Both seats marked these **UNVERIFIABLE** — no authorization
record is stored, no external repo revisions or licence files are cited. Codex also flagged that
`src/brain/contract.ts` says it was *"modelled on and adapted from Star Slug's contract"*, which
sits awkwardly beside "does not copy". Attribute the claims (*"According to the repository
owner…"*) rather than asserting them, and cite revisions.

**The systemic finding:** reasoning ages well; **paths, counts and status markers rot**.
`.ai-bus/bin` and `.ai-bus/scripts` appeared in three documents and existed in none — they are
real, but only after `initialize`, and no document said so. `HUMAN_GUIDE.md` now has a
"Running from a clone" section.

## Ensouled

Phase 3's blocking precondition is **resolved**: the shipped `Mantella.exe` is byte-identical to
the Nexus v0.14 archive (SHA-256 `B103FB5C…`). Gates green — 8 passed, 0 failed, 2 delegated.

Open: identify the upstream **commit** that produced the archive. You cannot `git branch` from a
zip. Narrow by 26 action JSONs carrying `enabled`, `skyrim_characters.csv` at 3,156 rows with
duplicate headers, `_internal` at 3,596 files. **If no commit matches, the archive was built
from something not in public history — that is itself the answer and changes Phase 3 again.**

Two paths that cost hours, both counter-intuitive: the program lives **inside** the mod folder
(`…\[NoDelete] [051.00001] Mantella\SKSE\Plugins\MantellaSoftware\`), and the authoritative log
is `…\Documents\My Games\Mantella\logging.log`, not the one beside the exe.

## Restarting

```bash
node scripts/bus-up.js --root "<bus root>" --console <your seat> --brains claude,codex,grok,worker
node scripts/bus-tick.js --root "<bus root>" --interval-s 240   # under your host's watcher
```

**Restart brains AFTER every build.** I lost three cycles dispatching work to brains running
pre-fix code, and the logs looked identical to a working bus. Compare the brain start time
against `dist/brain/brains/agent.js`.

The pre-commit hook honours `BUS_SEAT`; commit with `BUS_SEAT=<your seat> git commit`. Claim
before touching a file — the guard has caught real collisions, including mine.
