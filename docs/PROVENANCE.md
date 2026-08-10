# Design provenance

> **What this document is, and is not.** It records the maintainers' account of where the design
> came from, and the rules the package is held to. It is **not a licence audit**, and several
> statements below cannot be checked from this repository alone — they are marked where they
> occur. An audit on 2026-08-10 by the `codex` and `worker` seats flagged the originals as
> asserting legal conclusions as fact; they are now attributed rather than asserted. Obtain legal
> review before distributing anything whose provenance matters.

Portable AI Bus is **MIT-licensed** — declared in `package.json` and in the `LICENSE` file, both
verifiable here. The maintainers state that the shipped TypeScript/JavaScript is original
implementation for a workspace coordination product, written from the design patterns below
rather than copied from them.

*Not verifiable from this repository:* originality, and the absence of copying, cannot be
established without comparing against the referenced systems and reviewing authorship history.
Neither is present here. One nuance worth stating plainly rather than leaving for a reader to
find: `src/brain/contract.ts` says in its own header that it was *modelled on and adapted from*
Star Slug's contract. "Adapted from a design" and "does not copy" are compatible claims, but only
if someone has actually compared them — verify before release.

## First-party reference systems

**According to the repository owner**, these projects are their own work, and they authorized
their **designs** (not file imports) to inform Portable AI Bus. No dated authorization record is
stored in this repository; if that matters for a release, retain one and link it here.

- **Continuum Wars live harness** (`tools/live_harness`): durable request envelopes, run receipts, bounded execution, process ownership, scenario/oracle separation, provider-neutral coordination patterns.
- **Star Slug harness** (`.harness`): provider-neutral tool contract shape, authenticated agent seats, wake notifications, external-brain separation.

Portable AI Bus **reimplements** the generic patterns needed for mailbox + loopback harness + capabilities. Project-specific game/browser adapters and third-party dependency trees are not imported.

The **intent** is to avoid carrying Star Slug's repository-level terms, or an absent Continuum
Wars public licence, into this MIT package. Whether that intent is achieved is a legal
conclusion resting on the unverified no-copy premise above, and neither referenced repository,
revision, nor licence file is cited here. To make this checkable, record for each: the exact
revision inspected and what its licence file said at that revision — *"at `<hash>`, Star Slug
declares `<licence>`; no licence file was found in Continuum Wars at `<hash>`."*

## External references (not dependencies unless noted)

| Reference | Role | Shipped? |
|-----------|------|----------|
| **VS Code Extension API** (Microsoft) | Extension host, chat participant, `vscode.lm` consumer contracts | Uses published API typings only |
| **vscode-unify-chat-provider** (MIT) | Evidence that third-party providers can expose models via `vscode.lm` | **No** dependency; Unify is **optional** at runtime if the user installs it |
| **SKSE DevKit / CommonLibSSE-NG** installations | Discovered by `src/adapters/skse-devkit.ts` | Not embedded in VSIX; optional separately licensed release payload |
| **Node.js** | Runtime for CLIs and tests | Dev/engine requirement |

## What the package is allowed to ship

- Original mailbox, harness, capabilities, bus staging, extension UX, provider **templates** (markdown standing orders), capability **JSON allowlists**, docs.
- Compiled `dist/*.js` generated from this repo’s `src/`.

## What the package must not ship

- Mantella / Skyrim / SKSE plugin binaries or assets
- Unlicensed CommonLibSSE-NG source trees or vcpkg package caches
- Compiler toolchains without explicit redistribution rights and required notices
- LLM weights or provider API keys
- GPL multiplayer mod sources (e.g. Skyrim Together / TiltedEvolution) — clean-room rule for any future native actuation code living elsewhere (Ensouled)
- Copied Star Slug or Continuum Wars source files

## Runtime discovery (not bundling)

- **SKSE adapter** resolves, in this order: an explicit root passed by the caller (`--root`),
  then `SKSE_DEVKIT_ROOT`, then `.ai-bus/toolchains/skse-devkit` — see `resolveDevkitRoot()` in
  `src/adapters/skse-devkit.ts`. It then runs fixed-argv tools found there.
- **LM worker** selects models already registered with VS Code; credentials stay with the model provider extension.
- **Harness tokens** live under the user profile credentials directory, not the git worktree.

## Optional offline Dev Kit payload

`scripts/build-distribution.js` may copy an operator-supplied Dev Kit beside the VSIX and hash it.
Verified in code: the payload is placed **beside, not inside**, the VSIX, and internal links are
dereferenced — so it is a self-contained content copy rather than a byte-exact mirror of link
identity and metadata.

Whether such a payload "inherits" this repository's licence is a legal conclusion that code
cannot establish. **The distributor determines all applicable licences and obligations.** Never
commit the generated payload, and never represent the integrity manifest as a licence audit — it
proves transfer integrity, nothing more.

> **The 2026-08-10 audit's component finding, recorded because it blocks distribution.** For a
> typical kit: CMake is BSD-3-Clause, Ninja Apache-2.0, vcpkg itself MIT **but every installed
> port keeps its own licence**, and CommonLibSSE-NG/SKSE material is version- and file-specific.
> Microsoft permits redistribution only of files on its designated **REDIST** list — not MSVC
> Build Tools or Windows SDK trees. On that basis the Dev Kit **could not be cleared for lawful
> redistribution** at the time of audit. Before shipping one, produce a per-file bill of
> materials and a licence allowlist, preserve required notices, and treat every port, CommonLib
> and SKSE component separately.

## Language Model worker boundary

The optional LM worker is an **explicit, user-started**, turn-bounded client of `vscode.lm`. It is not a background autonomous agent. Portable AI Bus does not implement unsupported silent `sendRequest` loops against chat UIs (Kilo, Codex, Claude Code, etc.).

## Shipment rule

Any future borrowed code or bundled asset must have its own compatible licence and attribution
recorded in this file before merge. Portable AI Bus is distributed under MIT; anything influenced
by an external system must remain independently written, and its provenance reviewed, before it
ships.
