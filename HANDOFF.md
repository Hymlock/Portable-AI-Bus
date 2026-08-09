# Handoff — 2026-08-09, evening

Written by the `claude` seat as its session limit approached. Hymlock is continuing on Codex.
Everything below is committed; nothing is in flight on disk.

## Read this first

**Brains are STOPPED, deliberately.** Not crashed. Console windows flash while they run (see
below), and Hymlock asked for that to stop. Starting them again is a decision, not a repair.

**When the Anthropic session runs out, the `cli` link fails and every chain falls through to
`codex` or `grok`.** That is the designed behaviour, and it is the thing the whole evening was
about. It needs no intervention. If a seat goes quiet instead of falling through, that is a bug
worth chasing.

## State

Three vendors, three wallets, all verified live tonight:

| Link | Vendor | Auth | Verified |
|---|---|---|---|
| `cli` | Anthropic | existing Claude subscription | `pong`, 4.1 s |
| `codex` | OpenAI | `Logged in using ChatGPT` | `pong`, 6.7 s |
| `grok` | xAI | `grok login`, SuperGrok / X Premium+ | `pong`, 3.0 s |

No chain is single-vendor. Each seat leads with its own vendor and falls through to the others
(`brains/ensouled-seat.js`, `CHAINS`).

Three-way relay verified end to end, from the mailbox record:

```
362 claude->grok [task] leg 1     365 grok->claude  [note] leg 1 done
363 grok->claude [ack]            366 codex->grok   [ack]
364 grok->codex  [task] leg 2     367 codex->claude [ack] "The relay arrived."
```

Every leg landed, every seat echoed, and the exchange **terminated** — `wake-acks-only` shows the
ack guard cutting the ping-pong that ran away earlier.

161 tests green. Recent commits: `6aa07b1` codex provider + four window bugs, `6666b22` ack guard,
`b5db723` grok provider, `1e3ce35` idle-skip + reverted PATH theory.

## The open problem: console flashes

Every flash is `git.exe`, spawned **by the agent CLI**, not by us. Captured with a
`SetWinEventHook` on window creation — polling never caught them, they live under one frame.

```
CREATE pid=13796 conhost class=ConsoleWindowClass title=C:\Program Files\Git\mingw64\bin\git.exe
```

Root cause, from the `worker` seat's analysis (mailbox #360, the best account anyone produced):
a console-subsystem child gets a window only when it needs a console and does **not inherit**
one. The one thing a whole process tree inherits by default is the console object. Every fix
that operates on *our* `CreateProcess` call is therefore aimed at the wrong process.

Tried and **measured as insufficient** — do not repeat these:

| # | Attempt | Result |
|---|---|---|
| 1 | `windowsHide: true` on our spawn | applies to the CLI only, never to git |
| 2 | `detached: true` + `windowsHide` | hides ours, survives the parent; git still flashes |
| 3 | `Start-Process -WindowStyle Hidden` | worse — Win11 hands the console to Windows Terminal |
| 4 | default console host → `conhost` | helped, did not stop it (`HKCU\Console\%%Startup`) |
| 5 | non-repo `cwd` | probes walk *upward* and read user config; the failing call is the flash |
| 6 | one shared console, `stdio: 'inherit'` | 37 windows — handles are not console *ownership* |
| 7 | strip git from child `PATH` | 37 → 35. git is invoked by **absolute path**. Reverted. |

Next step, already commissioned to the `worker` seat: `src/brain/console-host.ts` — give the tree
a console object with no window (ConPTY, or `AllocConsole` + immediate `ShowWindow(SW_HIDE)`).
**Open question it must answer honestly:** the repo currently ships with *zero* runtime
dependencies, and Node cannot make Win32 calls without a native addon. If the fix needs a
dependency, that needs saying plainly rather than working around.

Pass criterion: re-run the window hook over a 75 s one-wake scenario. **Zero** `ConsoleWindowClass`
creates. Keep the hook — it is the only instrument that ever caught these.

The guaranteed-zero alternative, if the console route costs too much: in-process SDK providers.
No child process, so no grandchild, so no console. It does not cover CLI-shaped vendors.

## Audit in flight (dispatched, mostly unanswered — brains stopped before they finished)

- **A → grok** — initiation from any seat. Includes a confirmed bug: `bus-up` prints a recovery
  instruction telling the user to run `mailbox reassign`, and **that verb does not exist**;
  `reassignBaton()` exists in `src/mailbox.ts` but is not exposed on the CLI. The recovery
  instruction we print is impossible to follow. Not yet fixed.
- **B → codex** — failover and handoff. Key question: if all three vendors are exhausted at once,
  does the bus report loudly or stall silently?
- **C → worker** — distributability and dev kit. Note `package.json` declares `engines.vscode`
  only — no Node version, no dependencies — and the C++/dev-kit access Hymlock wants is, as far as
  I can see, **aspirational**: no capability exists for it today. Needs confirming.
- **D → grok** — de-Ensoul the bus. Hymlock: *"this bus is NOT specifically for Ensouled, it is
  meant to be used with any production."* `brains/ensouled-seat.js` is the default brain every
  seat loads and its name alone contradicts that. Inventory requested; rename not yet done.

Task bodies are in the scratchpad under `tasks/A.txt`…`E.txt` and were sent with `--body-file`
(`--body` mangles anything containing quotes — that is why the first dispatch failed).

## Restarting

```
node scripts/bus-up.js --root "<bus root>" --console <your seat> --brains codex,grok,worker
```

`bus-up` is idempotent, refuses to take the baton from an active holder, and now detects existing
brains correctly. Expect flashes until `console-host` lands.

To stop everything:

```powershell
Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match 'brain[\\/]cli\.js' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
```

## Machine changes made tonight

- Installed the xAI CLI: `npm i -g @xai-official/grok`. Real binary at `~/.grok/bin/grok.exe`
  (the `%APPDATA%\npm` entry is a trampoline Node 24 cannot spawn).
- Set default console host to `conhost`: `HKCU\Console\%%Startup`, both `DelegationConsole` and
  `DelegationTerminal`. **Revert = delete that key**; prior state was "Let Windows decide".
