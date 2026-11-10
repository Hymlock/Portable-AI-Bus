# Distribution and lifecycle

## Build the release directory

The offline builder places the VSIX beside an exact copy of an operator-supplied C++ Dev Kit:

```powershell
npm ci
npm run check:release
npm run distribution -- --devkit-root "C:\SDKs\SKSEDevKit" --out "C:\release\Portable-AI-Bus"
```

Use `--dry-run` first. It inventories file count and bytes without creating output, copying the
payload, hashing gigabytes, or packaging a VSIX. A real build refuses a non-empty output
directory, copies the kit to `devkit/`, creates the VSIX, and writes `manifest.json` with SHA-256
and byte size for the VSIX and every payload file. `--vsix PATH` can reuse a verified VSIX.
Internal directory links are validated and dereferenced so the result is self-contained. Links
that escape the Dev Kit root and cyclic links are rejected before copying.
The default `release/` output is Git-ignored; never force-add its multi-gigabyte payload.

The builder copies; it does not audit licenses or invent missing tools. Distribute only payloads
you have permission to redistribute. Verify the supplied kit contains the desired CMake, Ninja,
vcpkg/CommonLib material and that MSVC Build Tools and the required Windows SDK are installed or
legally included in that payload.

### Preset builds and compiler environment

The devkit adapter passes an explicit jailed `-B` directory even with `--preset`; configure,
build, test and the receipt therefore use the same build tree. For presets pinning a specific
Visual Studio installation, set `SKSE_VCVARS64` to that installation's `vcvars64.bat` before
both configure and build. The adapter validates this path under Program Files, reinitializes
the environment even if another `cl.exe` is on PATH, and refuses an invalid explicit selection.
It also selects the same installation for vcpkg and normalizes away the trailing slash, as
required by [Microsoft's vcpkg documentation](https://learn.microsoft.com/en-us/vcpkg/users/triplets#vcpkg_visual_studio_path).
This avoids combining a preset's older compiler with headers from automatic newer discovery.
It does not install a compiler or waive SDK, licensing or clean-build verification.

## Install and initialize

1. Install the VSIX with **Extensions: Install from VSIX...** or `code --install-extension`.
2. Install Node.js 20+ and authenticate each vendor whose named brain you will run; see `AUTH.md`.
3. Open a trusted target workspace and run **Portable AI Bus: Initialize Workspace**.
4. Put the release `devkit/` at `.ai-bus/toolchains/skse-devkit`, or set `SKSE_DEVKIT_ROOT`.
5. Start from any provider session:

   ```bash
   node .ai-bus/scripts/bus-up.js --root . --console claude
   ```

   `codex` or `grok` is equally valid as `--console`. The other two funded seats start as brains,
   and each brain is restricted to the vendor its name represents.
6. Run `node .ai-bus/bin/skse-devkit.js doctor --workspace .` and
   `node .ai-bus/bin/mailbox.js doctor` before assigning work.

## Update, recovery, and uninstall

- Stop brains and the harness before update. Install the newer VSIX with `--force`, reinitialize
  to refresh managed staged files, then restart `bus-up`.
- Provider timeout/quota/auth failure may fall through only to another authentication route for
  the same vendor (Claude has `cli`, `oauth`, and `api`). Grok never falls through to Codex or
  Claude, and Codex never falls through to Grok or Claude. Check `servedBy` for proof.
- Whole-chain exhaustion is always **logged**; the baton moves only if the exhausted seat holds
  it, has a successor, is outside the five-minute cooldown, and the compare-and-move succeeds.
  Reassignment is conditional, not automatic.
- The source tools include `bus-supervise` for configured brain processes. Its presence is
  not proof that a supervisor is running or that a provider has credits. Restart only the
  intended seats; a live console must not also get a duplicate brain.
- Clarification is an open dependency, not completion. Keep the goal open and resume after the
  answer arrives.

### Removal and operator toolchains

Current `removeUnlocked` preserves `.ai-bus/toolchains/` and keeps its Git exclusion after
removing the other bus files. The installed-extension integration test checks a retained
operator marker and the surviving exclusion. This supersedes the historical whole-directory
deletion warning; it does not make arbitrary files elsewhere in `.ai-bus/` persistent.
Keep independent backups, and verify the installed extension version before relying on this
behavior. Keeping the kit outside the workspace with `SKSE_DEVKIT_ROOT` remains supported.
