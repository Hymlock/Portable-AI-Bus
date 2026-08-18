# Audit evidence — the 23 rounds that certified the completion bar

These are the working files from the audit that took `docs/COMPLETION-BAR.md` from 8 of 20
certified to 20 of 20. They lived untracked at the repo root while the work was running and
were moved here on 2026-08-18, because one `git clean` would have destroyed the only record
of *why* anything is certified.

**Nothing here is source.** Nothing imports it, no test runs it, and `npm test` does not
touch it. It is kept for one reason: a certification you cannot re-derive is a claim, not
evidence.

## What the files are

| pattern | what it is |
|---|---|
| `tmp-audit-r<N>-grok-verdict.md` | the verdict for round N — the authoritative record |
| `tmp-audit-r<N>-grok.cjs` | the instrument for round N, written fresh each round |
| `tmp-audit-r<N>-*-out.json` | that instrument's raw output |
| `tmp-audit-1842-report.txt` | the round-2 report, written before the `r<N>` naming settled |
| `tmp-audit-r6-patches/` | the patch grok built across rounds 6–18 while blocked, plus `APPLY.md` |

Round numbering is not contiguous with the narrative rounds 1–4 in the git history: grok
renumbered when it began the leftover hunts. The verdicts are self-dating — each names the
HEAD it attacked.

## How to read a verdict

Each one states the HEAD or hook blob it attacked, then a table of attacks with PASS / FAIL /
NOTE. The distinctions are load-bearing and were set by the auditor, not the author:

- **FAIL** — the stated rule does not decide this attack, or decides it **wrongly**. A hole.
- **NOTE** — real behaviour, but not red-capable in that spelling, or already classified.
- **VARIANT** — a new spelling of something the stated rule already decides. Not a hole.

## The two rules this audit ran under

1. **Rules are stated positively.** Every round lost was lost to an enumeration of bad cases,
   and an enumeration always has an edge to step around.
2. **The auditor classifies each leftover. The author may argue; the author may not decide.**
   This replaced a weaker rule proposed by the author, which would have permitted certifying
   a class that was still open.

## Where the certifications landed

`docs/COMPLETION-BAR.md` is authoritative for status. `docs/RESUME-HERE.md` carries the round
history and the findings worth not re-deriving.

## What this evidence does not cover

Portability. Every item here is correctness under audit on **this machine**. The absolute
Windows paths, the node-pty coupling and partial native installs are untouched, and the
last real defect found — a scratch root that resolved wrongly wherever `os.tmpdir()` is a
link, which would have refused every commit on macOS — is a fair sample of what a
portability pass would surface. It was found by sweeping, not by the suite: nothing in 523
tests would ever have shown it, because this machine's tmpdir is not a link.
