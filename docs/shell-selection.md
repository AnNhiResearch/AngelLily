# Shell Selection

This document explains how Angel Lily decides which shell runs the commands the AI asks for, and what happens when no suitable shell is found.

## The rule (Windows)

The rule is fixed and deterministic — no guessing, no environment inspection:

| Priority | Shell | Executable | When |
| -------- | ----- | ---------- | ---- |
| 1 | PowerShell 7 | `pwsh.exe` | Installed on the machine (checked via `PATH`) |
| 2 | Windows PowerShell 5.1 | `powershell.exe` | `pwsh.exe` is not installed |
| 3 | — | — | Neither found → **startup fails with an error** |

- `cmd.exe` is **never** used, in any situation.
- Commands are executed with `-NoProfile` so personal profiles cannot interfere or slow things down.
- If neither PowerShell executable exists, the bot refuses to start and prints:

```
No PowerShell found on this machine. Install PowerShell (pwsh.exe or powershell.exe) so the bot can run commands.
```

## The rule (Termux / macOS / Linux)

| Environment | Detection | Shell used |
| ----------- | --------- | ---------- |
| Termux | `TERMUX_VERSION` env var, or `PREFIX` containing `com.termux` | `/bin/sh` |
| macOS | `process.platform === 'darwin'` | `/bin/sh` |
| Linux | everything else | `/bin/sh` |

## Why pwsh wins when both are installed

PowerShell 7 is the modern, actively maintained shell. Using it whenever available means:

- consistent, modern syntax for the AI to write commands with;
- no dependency on which terminal the user happened to launch `npm start` from — the choice never changes between runs on the same machine.

The chosen environment is reported at startup:

```
Shell environment: PowerShell 7 (pwsh) — PowerShell syntax
```

and is included in the AI's system prompt, so the LLM always writes commands in the correct syntax.

## Related modules

- `src/shell.ts` — detection and command execution (this document).
- `src/telegram.ts` — the approval UI: every proposed command is shown to the user with **Run / Cancel** buttons before it is executed.
- `src/ai.ts` — the `<cmd>...</cmd>` protocol the LLM uses to request commands.
