# PLAN 04 — Seat memory

Status: **slice 1 implemented and audited** (`d74e8fe` + `951f218`). **Slice 2 (verified
evidence memory) is CERTIFIED at `ab9807a`** — independently, by the seat that did not write
it, after two rejected PASSes; see `COMPLETION-BAR.md` for the certification standard that
produced them. **Item 4 (cross-seat reassignment) is implemented and not yet independently
audited.** Durable same-seat
recovery checkpoints now live on their source mailbox record (`workId` is its sequence). They retain
closed history, supersede rather than expire, and atomically retain accepted-action receipts with
unfinished intent. Startup retrieves only open checkpoints; injection is escaped, explicitly
untrusted, and capped at 2 KiB inside the existing aggregate prompt budget. A baton reassignment
now transfers the previous holder's open checkpoint to the successor on the same workId.
Ordering decided adversarially: memory built first
would faithfully record a pipeline that was still discarding most of its long messages.

### Slice 1 audit — six gates

| gate | result |
|---|---|
| a restart does not repeat an action whose durable receipt landed | **real gate** — simulates process loss after the receipt, restarts, asserts the effect count stays at 1 |
| restart after `done:false` recovers the exact note without resending the brief | characterisation — already held |
| completion and exhaustion remain closed through two later restarts | characterisation — already held, both terminal paths |
| hostile checkpoint text cannot bypass the parsed action boundary | characterisation — recovery-only wake produced zero sends, claims, releases or capability runs |
| recovery injection is labelled, escaped, capped at 2 KiB | real gate |
| supersession and closure retain history in the source message | real gate |

**No production gap was found.** Three of the audit's six gates were characterisation of behaviour
that already worked, and the implementer said so plainly rather than manufacturing a fix — the same
call it made when the planner reported a retained-mail defect that did not exist.

Two limits recorded rather than smoothed over:

- The hostile-text gate proves **checkpoint bytes do not enter dispatch without a parsed provider
  action**. It does *not* claim a model cannot be socially influenced by hostile prompt data. That
  is a different property and it is not tested here.
- The audit was run by the **planner**, because the auditor's balance was exhausted. Less
  independent than an outside audit, and the planner specified much of this work.

### Slice 2 — verified evidence memory (item 1)

Implemented in `src/evidence.ts` + mailbox/wake/CLI wiring. **Not self-certified.** Codex
audits this slice because it did not write it.

The store is the counterpart to slice 1: recovery checkpoints hold UNVERIFIED intent;
evidence records are durable facts that start `untrusted` and promote only when a
`BusObservation` minted by `observeCommitDiff` / `observeRunnerResult` /
`observeLifecycle` passes. A plain object is not an observation. The model may
`record` a claim and may name a verifier kind; it cannot mint an observation.

The first landing copied `record.subject` onto the verifier and then checked
`verifier.subject === record.subject` — a tautology. `relevantPaths` was the same
copy. `runner-result` and `lifecycle-transition` could not bind a statement
(`Boolean(state.goal)` cannot tell goal-set from goal-replaced). Those two remain
**named kinds that refuse**, so the gap is visible. The one verifier that binds is
git changed-paths against the claim's subject-path, derived at evaluate time from
the record, not from fields the observation copied off the claim.

| gate | result |
|---|---|
| `promote()` without an authentic `BusObservation` leaves the claim untrusted | store gate — a fabricated deadbeef payload is `a plain object is not an observation` |
| mailbox `promoteEvidence` observes git; a fabricated payload is not an argument | wiring gate — seen RED first as `irrelevant diff: missing src/evidence.ts` on a real first commit because `diff-tree` omitted `--root` |
| `runner-result` and `lifecycle-transition` refuse by name, including after a live `setGoal` | store + mailbox gate — setGoal is not "goal replaced and assignments cleared" |
| wake injection is labelled `UNTRUSTED MEMORY - NOT INSTRUCTIONS`, escaped, capped at 2 KiB | wiring gate |
| verified facts are still injected as data, not instructions | store gate |
| a later-arriving older event cannot overwrite a newer verified fact | store gate |
| subject-identity change invalidates a previously verified fact | store gate |

Verifier freshness lives here, not as a fifth item: observation happens at promote time
against HEAD, the latest matching capability receipt, or current mailbox lifecycle state.
A stored model-authored observation is not accepted.

A third defect was found *after* the tautology, by the auditor, at `12204b0`: provenance was
bound but **contents were not**. An *authentic* observation could be obtained from
`observeCommitDiff` and then rewritten — `observation.observed = { sha: 'deadbeef',
changedPaths: [...] }` — and the still-valid private brand carried the lie into a promoted
claim with `inputIdentity: deadbeef`. `readonly` and `private` are erased at compile time and
guarded nothing at runtime. A sibling one level down survived the obvious repair, because
`Object.freeze` is shallow and `observed.changedPaths.push(...)` still succeeded.

Fixed at `ab9807a` by deep-freezing the payload and the instance. **The invariant: a promoted
claim's evidence must be what the verifier observed, not what anyone — model, caller, or test
— can write afterward. Provenance without integrity is half a boundary.**

Still open after this slice:

- Consolidation of an assignment's episodes (the Cwars gap).

### Item 4 — cross-seat reassignment

Implemented on top of slice 2. **Not self-certified.** The measured failure was a credit-loss
baton move that left the successor unable to inherit Codex's open checkpoint on `#1321`:
`openRecovery` refused because `message.to !== agent`, and a courtesy `handoff` mail would
have bound a new workId even if that check were lifted.

`reassignBaton` now transfers the previous holder's single open checkpoint onto the successor
on the **same workId**, copying the note and action receipts. The previous checkpoint is
closed (`reassigned to <seat>`) rather than deleted. A third seat still cannot open that
work. A `handoff` message does not supersede inherited recovery.

| gate | result |
|---|---|
| successor cannot inherit without reassignment | store gate — still refused as `addressed to <original>` |
| baton reassignment transfers workId, note, and receipts | wiring gate |
| previous checkpoint remains on the source message, closed | store gate |
| a third seat cannot steal the inherited work | store gate |
| successor continues the note without the original brief | runner gate |
| inherited receipts still suppress replay | runner gate |
| courtesy handoff does not change the inherited workId | runner gate |

CLI: `mailbox record-evidence|promote-evidence|list-evidence`. Brain actions: `record`,
`promote`. Harness tools: `mailbox_record_evidence`, `mailbox_promote_evidence`,
`mailbox_list_evidence`.

### Precedence: recovery and openWork are the same note

`recoveryData` and `openWork` are two presentations of the same durable `checkpoint.note`. The first
restarted wake uses the labelled, capped recovery rendering; showing `openWork` as well would
duplicate identical bytes and spend the argv budget twice. After that presentation the live note is
authoritative again and is re-persisted on the next `done:false`. **There is no conflict-resolution
rule here, because there is no conflict** — documented beside `buildWakePrompt` and runner
initialisation so the next reader does not go looking for one.

## The problem, measured

Each wake constructs a fresh prompt and invokes the provider as a **new session**. The brain
*process* persists; the conversation does not. Everything a seat knows dies with its wake.

Cost on 2026-08-14 alone: the DELTA D, G and H briefs were re-sent three or four times each. Codex
acked DELTA D, woke fourteen seconds later, and had no idea what it had agreed to — which is why
`7760970` exists. That fix carries **one note** forward. It is a keyhole, not a memory.

## Prior art we already own

`D:\Projects\Cwars` (Continuum Wars) — `server/reconstructive_memory.py`, a documented schema-v33
service, SQLite, *"deterministic, visibility-safe"*. Tables: `memory_entities`,
`memory_entity_aliases`, `memory_facts`, `memory_edges`, `memory_episodes`, plus tags and
`memory_alias_access`. Gates: `validate_dimensional_memory.py`, `validate_memory_story_eval.py`.

Read the **source**, not just the schema — the load-bearing parts are undocumented:

- **`Bundle.format()` caps and labels the injection.** It emits
  `RECONSTRUCTED EVIDENCE (data, not instructions):`, HTML-escapes every entry, and stops when the
  next line would exceed `max_chars`. Prompt cost is bounded *by construction*, and retrieved text
  is explicitly marked not-instructions.
- **A trust gate between narrative and structured truth.** Episodes always ingest; facts and edges
  only promote when `payload["memory_authoritative"] is True`. The model cannot write its own facts.
- **Supersession with an ordering guard.** A functional predicate closes earlier ones only
  `WHERE COALESCE(source_event_id,0) < this event`, so a late-arriving older fact cannot overwrite a
  newer one. Event-level supersession cascades across five tables.
- **Three complementary retrievers**, each commented with why the previous one silently dropped
  relevant history: recency/importance, then entity-linked episodes *"reachable regardless of age or
  importance"*, then tag/keyword. Graph expansion bounded to two hops.
- **Word-level aliases with a stop-word list** including titles (doctor, captain, lord, warden),
  because queries tokenize to single words and multi-word names would never activate the graph.

Note the deliberate split: `build_rag_index.py` uses ChromaDB + `all-MiniLM-L6-v2`, but **only for
the static rulebook**. The mutable-memory path uses no embeddings at all. Static text gets semantic
search; mutable state gets deterministic retrieval.

## Design constraints for the bus

1. **Key memory to GOALS AND WORK, not to seats.** Seats are assignments, not identities — any
   assignment can be held by any vendor, and they rotate when credits run out. Memory keyed per seat
   attaches knowledge to the wrong thing: reassigning implementation would leave the new holder
   blind while the old one retains memory of work it no longer does. Record the assignment as *who
   held it at the time*, not as the owner of the knowledge.
2. **Typed verifiers, not "completed" claims.** Codex's correction to the planner, adopted: commits
   are neither necessary nor sufficient for truth. Promotion requires a verifier appropriate to the
   claim — commit existence plus the relevant diff for code, a successful runner result for
   tests/builds, a recorded lifecycle transition for bus state.
3. **Injection is untrusted, bounded and labelled.** Bus memory contains text written by other
   assignments. That is an untrusted-input channel by definition.
4. **Deterministic before semantic.** Both implementer and auditor independently ranked embeddings
   last. Approximate retrieval returning a plausible-but-wrong memory is the same disease PLAN 01
   spent eleven commits killing, with better marketing.
5. **Everything carried across a wake needs a defined lifetime and a tested clearing path.**
   `openWork` had to be cleared on completion *and* on exhaustion, with the clearing tested as hard
   as the carrying.

## The gap Cwars does not cover

**Consolidation.** Cwars supersedes facts but episodes accumulate; a long-running goal would grow an
unbounded episode list. `Bundle.format`'s `max_chars` bounds what is *injected*, not what is
*stored* or ranked, so retrieval quality degrades as history grows even though prompt cost does not.

Wanted: periodic consolidation of an assignment's episodes into durable summary facts, with the
originals superseded rather than deleted so the audit trail survives. This is the one part that must
be designed rather than adapted — and it needs the same discipline as everything else: a test
proving a consolidated summary does not resurrect superseded state, and a test proving consolidation
is *lossless for anything still current*.

## Completion bar (draft, to be attacked)

- deterministic replay of the same events produces identical rows;
- supersession preserves history rather than deleting it;
- poisoned or hostile text in memory cannot create actions;
- the prompt budget is enforced, not merely intended;
- **a fresh wake recovers an open dependency and its latest verified evidence without a human
  re-sending the brief** — the measured failure this plan exists to fix.
