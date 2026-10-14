# AngelLily

A featherweight autonomous agent — built to run anywhere, even on a 4 GB RAM laptop or an Android TV 1GB RAM box through Termux.

## What is AngelLily?

AngelLily is a small autonomous agent in the same spirit as OpenClaw or Hermes Agent, but with a radically different priority: **minimal footprint above everything else**.

It is written in TypeScript and runs as a single, tiny Node.js process with only one runtime dependency (the OpenAI client). No background services, no bundled plugins, no database, no persistent memory layer — just the agent core.

## Features

- **Telegram chat with an LLM.** Streaming replies through any OpenAI-compatible API — cloud or local — configured with `OPENAI_BASE_URL` and `OPENAI_MODEL`.
- **Owner-only by design.** The first user verifies with `/verify`; a 6-digit OTP is printed on the terminal (valid 60 seconds) and must be sent back from the same chat. Ten wrong codes put the chat on a blacklist. No passwords, no config files — the person who can read the terminal is the owner.
- **Commands with human approval.** The AI can ask to run shell commands, but every command is shown in Telegram as a **Run / Cancel** prompt and only executes after explicit approval. Plugin hooks may rewrite a command *before* it is shown, so you always approve exactly what will run.
- **Deterministic shell selection.** PowerShell 7 → PowerShell 5.1 on Windows (never `cmd.exe`), `/bin/sh` on Termux, macOS and Linux. The chosen environment is described to the model so it always writes commands in the right syntax — see [docs/shell-selection.md](docs/shell-selection.md).
- **Optional external plugins.** Load extra commands and LLM tools isolated in a Single Shared Runner process — see [docs/plugins.md](docs/plugins.md).
- **Editable persona.** The system prompt lives in [.angellily/AGENTS.md](.angellily/AGENTS.md). Edit it and restart — no code changes needed. It sits in the `.angellily/` folder so coding agents (Trae, Copilot, …) don't mistake it for their own workspace rules.
- **Localized UI.** Bot messages (help, approvals, errors) in English or Vietnamese via `BOT_LANGUAGE`.
- **Session-only memory.** Conversation context lives in RAM for the current session and is discarded on restart — no unbounded growth.

## Design Philosophy

- **Compactness first.** Every feature must justify its cost in RAM and complexity. If it does not fit on a 4 GB laptop or an Android TV box running Termux, it does not belong in AngelLily.
- **No bundled plugins.** Unlike OpenClaw, AngelLily ships with zero plugins built in. What you see in the source tree is the whole product.
- **No persistent memory.** Unlike Hermes Agent, AngelLily keeps no long-term memory between sessions.
- **Single process, single dependency.** One runtime, one entry point, one npm dependency.

## How It Compares

| | AngelLily | OpenClaw | Hermes Agent |
|---|---|---|---|
| Bundled plugins / background services | None | Ships with large plugin ecosystem | Varies |
| Persistent memory | None (session-only context) | Partial | Yes |
| Footprint | Runs on 4 GB RAM laptop / Android TV box via Termux | Heavier | Heavier |
| Language | TypeScript | TypeScript | — |

## Requirements

- Node.js **24 LTS (recommended)** — the bot loads `.env` through the built-in `--env-file` flag, so `process.env` is populated natively by Node itself (no dotenv package)
- > ⚠️ **Do not use Node.js 26+ yet.** Node 26 ships Undici 8, which changes the internal `fetch` dispatcher and is known to cause delayed/out-of-order Telegram replies in this bot. Use Node 24 LTS on both Windows and Termux.
- An OpenAI-compatible LLM API endpoint
- On Windows only: **PowerShell** (`pwsh.exe` or `powershell.exe`) so commands can be executed

## Getting Started

### Option A: npm (fastest)

Install globally and run from your project directory:

```sh
npm install -g @angellily/app
npx @angellily/app
```

Or as a one-off without installing:

```sh
npx @angellily/app
```

Either way, the app auto-discovers `.angellily/AGENTS.md` / `.env` from the current directory. Create them first:

```sh
# in your project folder
npx @angellily/app --init
```

`--init` copies the default `.angellily/AGENTS.md` and `.env.example` into your project. Edit `.env`, add your token, then run `npx @angellily/app`.

### Option B: from source

1. Clone:

   ```sh
   git clone https://github.com/AnNhiResearch/AngelLily.git
   cd AngelLily
   ```

2. Install dependencies:

   ```sh
   npm install
   ```

3. Create your configuration:

   ```sh
   cp .env.example .env
   ```

   On Windows (PowerShell): `Copy-Item .env.example .env`

   Fill in `TELEGRAM_BOT_TOKEN` (from [@BotFather](https://t.me/BotFather)) and `OPENAI_API_KEY`. Point `OPENAI_BASE_URL` and `OPENAI_MODEL` at any OpenAI-compatible provider.

4. Build and start:

   ```sh
   npm run build
   npm start
   ```

5. Pair your Telegram account: send `/verify` to the bot, read the 6-digit OTP from the terminal, and send it back within 60 seconds. You are now the owner — everyone else is ignored.

## Configuration

| Variable | Default | Description |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | *(required)* | Bot token from @BotFather |
| `OPENAI_API_KEY` | *(required)* | API key for the LLM provider |
| `OPENAI_BASE_URL` | `https://api.openai.com/v1` | Any OpenAI-compatible endpoint |
| `OPENAI_MODEL` | `gpt-4o-mini` | Model name sent to the API |
| `MAX_HISTORY` | `10` | Messages kept per chat (older ones are dropped) |
| `BOT_LANGUAGE` | `vi` | UI language: `en` or `vi` |
| `TELEGRAM_TRANSPORT` | `polling` (or `webhook` if url is set) | Mode: `polling` or `webhook` |
| `TELEGRAM_WEBHOOK_URL` | *(optional)* | Webhook HTTPS URL (e.g. `https://example.com/telegram`) |
| `TELEGRAM_WEBHOOK_PORT` | `3000` | Port for local webhook HTTP server |
| `TELEGRAM_WEBHOOK_SECRET` | *(optional)* | Secret token checked against `X-Telegram-Bot-Api-Secret-Token` |

## Customizing the Persona

The bot's identity and behavior rules live in [.angellily/AGENTS.md](.angellily/AGENTS.md). Edit the file, restart the bot — done. The current model is injected automatically so the agent can answer questions about what powers it.

## Documentation

- [docs/plugins.md](docs/plugins.md) — the plugin system (Vietnamese: [docs/plugins_vi.md](docs/plugins_vi.md))
- [docs/shell-selection.md](docs/shell-selection.md) — how the shell is chosen (Vietnamese: [docs/shell-selection_vi.md](docs/shell-selection_vi.md))

## License

Licensed under the [Apache License 2.0](LICENSE).
