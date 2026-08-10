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

## Install and initialize

1. Install the VSIX with **Extensions: Install from VSIX...** or `code --install-extension`.
2. Install Node.js 20+ and authenticate at least two provider CLIs; see `AUTH.md`.
3. Open a trusted target workspace and run **Portable AI Bus: Initialize Workspace**.
4. Put the release `devkit/` at `.ai-bus/toolchains/skse-devkit`, or set `SKSE_DEVKIT_ROOT`.
5. Start from any provider session:

   ```bash
   node .ai-bus/scripts/bus-up.js --root . --console claude
   ```

   `codex` or `grok` is equally valid as `--console`. All three brains start by default and each
   uses a cross-vendor chain.
6. Run `node .ai-bus/bin/skse-devkit.js doctor --workspace .` and
   `node .ai-bus/bin/mailbox.js doctor` before assigning work.

## Update, recovery, and uninstall

- Stop brains and the harness before update. Install the newer VSIX with `--force`, reinitialize
  to refresh managed staged files, then restart `bus-up`.
- Provider timeout/quota/auth failure falls through to another vendor. Whole-chain exhaustion
  records evidence and reassigns the baton. A dead OS process still needs `bus-up` restarted;
  v0.2 has no service supervisor.
- Clarification is an open dependency, not completion. Keep the goal open and resume after the
  answer arrives.
- Run **Portable AI Bus: Remove Workspace Bus** before uninstalling if staged workspace files
  should be removed. Operator-supplied Dev Kit payloads are not silently deleted.
