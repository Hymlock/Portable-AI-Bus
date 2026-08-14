# PLAN 04 — Seat memory

Status: **not started.** Queued behind the transport fix (PLAN 03) and the envelope class (PLAN 02).
Ordering decided adversarially: memory built first would faithfully record a pipeline that was
still discarding most of its long messages.

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
