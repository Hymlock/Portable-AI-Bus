# The bus completion bar

What "the bus is finished" means, item by item. Written down on 2026-08-14 because until
then the bar lived only in a chat context — two of these items exist *only* because an audit
failed, and losing that would mean re-deriving them by failing the same way twice.

Status values are deliberately harsh. **Implemented is not certified.** An item is done when a
seat that did not write it has attacked it and said so on the record.

| # | item | status |
|---|---|---|
| 1 | verified evidence memory | **implemented, FAILED certification twice** |
| 2 | consolidation of an assignment's episodes | open — deliberately last |
| 3 | supersede a sent message | open |
| 4 | cross-seat reassignment | implemented (`c755a42`), audit open |
| 5 | distinguish *stalled* from *spent* | open — measured 2026-08-14, see below |
| 6 | claim guard cannot express sibling paths | open |
| 7 | claim schema | open |

## Item 1 — why it is still not certified

The surface has now failed twice, each time because the guard bound the wrong quantity.

1. **Tautology** (caught by grok, fixed in `12204b0`). The verifier copied `record.subject`
   onto itself and then compared the two. A check that cannot fail is not a check.
2. **Mutable payload** (caught by codex against `12204b0`). Provenance was bound — a plain
   object is refused with `a plain object is not an observation`, and the private constructor
   plus unexported mint token make that real. Contents were **not** bound. Codex obtained an
   *authentic* observation from `observeCommitDiff` whose real diff touched only `README.md`,
   assigned `observation.observed = { commitExists: true, sha: 'deadbeef', changedPaths:
   ['src/evidence.ts'] }`, and `promote()` accepted it. The claim reached `trust: verified`
   with `inputIdentity: deadbeef`.

`readonly`, `private` and `Readonly<T>` are **erased at compile time**. They proved nothing at
runtime, which is exactly how this survived the first audit. Every guard on this surface must
be a runtime guard, and every probe must run against the compiled `dist`, not `src`.

**The sibling, found before the repair landed:** `src/evidence.ts:116` is
`Object.freeze({ ...observed })`, which is **shallow**. Freezing the instance closes codex's
exact attack while leaving `observation.observed.changedPaths.push('src/evidence.ts')` open —
the same false promotion one level down. Fixing the reported instance rather than the class
would have produced a gate that passes the probe and still cannot go red.

The invariant to hold: **a promoted claim's evidence must be what the verifier observed, not
what anyone — model, caller, or test — can write afterward.** Provenance without integrity is
half a boundary.

Certification gates (red first, all four):

- mutate `observation.observed` wholesale → refused
- mutate `observed.changedPaths` in place via `push` → refused
- mutate `observed.sha` / `observed.commitExists` in place → refused
- **an honest observation whose real diff touches the subject path still promotes** — not
  optional. Without it, the first three pass trivially if `promote()` simply always refuses,
  which is a gate that cannot go green.

## Item 5 — measured, and it is not the shape the name suggests

Measured across both seats' brain logs on 2026-08-14:

| seat | `provider-stalled` | recovered on their own |
|---|---|---|
| codex | 26 | 24 |
| grok | 11 | 9 |
| **total** | **37** | **33 (89%)** |

**A stall is usually benign.** The signal fires often and resolves by itself nearly nine times
in ten. The defect is not that stalls occur — it is that at the moment one is logged, the 33
that will clear in ninety seconds are indistinguishable from the 4 that never will.

That ambiguity has a measured cost in both directions. A benign stall was read as failure and
a seat was killed mid-implementation. A real credit exhaustion was read as a mechanical fault
and chased for hours. Both were the same missing distinction.

So item 5 is **not** "add a third state to an enum." A stall needs a **duration and an
outcome**, not just an edge:

- emit stall start and stall resolution as a pair, so unresolved stalls are countable;
- separate *provider is slow* from *provider chain is spent* — the second is a fallthrough
  result, the first is a timer, and they are not the same measurement;
- a direct CLI probe answering `PONG` in ~4 s while the brain's call hangs is evidence of a
  **transport** condition, not a credit condition. Both seats' CLIs were verified healthy
  (`exit 0`, 3.5 s and 6.7 s) while their brain calls sat stalled.

Do not conclude a cause from this. Prompt size was the obvious suspect and is **not**
established — the argv-ceiling story was asserted and withdrawn once already (`81809dc`), and
five diagnoses today were plausible and wrong. Instrument first.

## Ordering

Item 2 is last on purpose: consolidation built early would faithfully compress a pipeline that
was still discarding most of its long messages.

The temporal-binding slice does **not** start until item 1 is certified. It rewrites
`observeLifecycle` / `observeCommitDiff` / `observeRunnerResult` and would replace the named
refusals codex was asked to attack; stacking it on an uncertified surface makes both slices
un-auditable. That ordering was proposed by the implementer and confirmed, not imposed.

## The rule that produced every finding here

**The auditor is never the author.** Two adversarial gates: the goal is argued before a plan
exists, the plan before code.

Seats are *assignments, not identities* — any vendor can hold any role, and they rotate when
credits run out. What is fixed is the invariant, not who sits where. It held tonight without
enforcement: offered the baton and the opportunity to self-certify, the implementer refused —

> *"Running my own probes would be a heartbeat wearing a verdict."*

Every defect on this page was found by someone who did not write the code.
