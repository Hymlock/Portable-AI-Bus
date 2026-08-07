# Design provenance

Portable AI Bus is **MIT-licensed**. Shipped TypeScript/JavaScript in this repository is original implementation for a workspace coordination product. It does **not** copy source files, binaries, models, game assets, or proprietary harness trees from the systems named below.

## First-party reference systems

The repository owner identified these projects as their own work and authorized their **designs** (not file imports) to inform Portable AI Bus:

- **Continuum Wars live harness** (`tools/live_harness`): durable request envelopes, run receipts, bounded execution, process ownership, scenario/oracle separation, provider-neutral coordination patterns.
- **Star Slug harness** (`.harness`): provider-neutral tool contract shape, authenticated agent seats, wake notifications, external-brain separation.

Portable AI Bus **reimplements** the generic patterns needed for mailbox + loopback harness + capabilities. Project-specific game/browser adapters and third-party dependency trees are not imported.

This also avoids carrying Star Slug repository-level **CC-BY-NC-ND** terms, or an absent Continuum Wars public licence, into this MIT package.

## External references (not dependencies unless noted)

| Reference | Role | Shipped? |
|-----------|------|----------|
| **VS Code Extension API** (Microsoft) | Extension host, chat participant, `vscode.lm` consumer contracts | Uses published API typings only |
| **vscode-unify-chat-provider** (MIT) | Evidence that third-party providers can expose models via `vscode.lm` | **No** dependency; Unify is **optional** at runtime if the user installs it |
| **SKSE DevKit / CommonLibSSE-NG** installations | Discovered by `src/adapters/skse-devkit.ts` | **Not** vendored; adapter only |
| **Node.js** | Runtime for CLIs and tests | Dev/engine requirement |

## What the package is allowed to ship

- Original mailbox, harness, capabilities, bus staging, extension UX, provider **templates** (markdown standing orders), capability **JSON allowlists**, docs.
- Compiled `dist/*.js` generated from this repo’s `src/`.

## What the package must not ship

- Mantella / Skyrim / SKSE plugin binaries or assets
- CommonLibSSE-NG source trees or vcpkg package caches
- Compiler toolchains (MSVC, CMake, Ninja)
- LLM weights or provider API keys
- GPL multiplayer mod sources (e.g. Skyrim Together / TiltedEvolution) — clean-room rule for any future native actuation code living elsewhere (Ensouled)
- Copied Star Slug or Continuum Wars source files

## Runtime discovery (not bundling)

- **SKSE adapter** resolves `SKSE_DEVKIT_ROOT` or `.ai-bus/toolchains/skse-devkit` and runs fixed-argv tools found there.
- **LM worker** selects models already registered with VS Code; credentials stay with the model provider extension.
- **Harness tokens** live under the user profile credentials directory, not the git worktree.

## Language Model worker boundary

The optional LM worker is an **explicit, user-started**, turn-bounded client of `vscode.lm`. It is not a background autonomous agent. Portable AI Bus does not implement unsupported silent `sendRequest` loops against chat UIs (Kilo, Codex, Claude Code, etc.).

## Shipment rule

Any future borrowed code or bundled asset must have its own compatible licence and attribution recorded in this file before merge. Architectural inspiration alone remains implemented inside Portable AI Bus under MIT.
