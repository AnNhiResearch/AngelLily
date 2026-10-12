# Plugin System

AngelLily ships with **zero plugins** — what you see in the source tree is the whole product. But because Lily is so small, plugins are the most powerful way to extend it: a plugin can touch **everything**, including the default modules.

A plugin is just an npm package (or a local folder) that default-exports a plain object. At startup, AngelLily loads every package listed in `plugins.json`.

## What a plugin can do

| Capability | Type | How it shows up |
|---|---|---|
| User commands | Proactive (user) | Adds `/name` and `#name` commands to the chat |
| LLM tools | Proactive (LLM) | The LLM may call the tool on its own, just like the built-in shell |
| Extra system prompt | Passive | Appended to the system prompt of every session |
| Hooks | Both | Intercept user messages, transform replies, rewrite shell commands |

## Installing a plugin

```bash
npm install angellily-plugin-example
```

Then add the package name to `plugins.json` at the project root:

```json
["angellily-plugin-example"]
```

Local folders work too (useful while developing a plugin):

```json
["angellily-plugin-example", "./my-plugin"]
```

Each entry may also be an object with `package` (required) and `worker` (optional, see [Worker isolation](#worker-isolation-optional)):

```json
["angellily-plugin-example", { "package": "./my-plugin", "worker": true }]
```

Rules:

- Packages are loaded in list order, with a dynamic `import()` inside the same process — unless worker mode is enabled for them.
- A plugin that fails to load or export a valid object is **skipped with a warning** — one broken plugin never takes the bot down.
- Duplicate plugin names: the first one wins, later ones are skipped.

## Plugin anatomy

```ts
// index.js of an npm package "angellily-plugin-example" (ESM)
export default {
  // Required, unique. The first plugin with a given name wins.
  name: 'example',

  // Passive: appended to the system prompt of every session.
  systemPrompt: 'When the user asks about the weather, use the weather tool.',

  // User commands: the chat can run /example and #example.
  commands: [
    {
      command: 'example',           // without the / or # prefix
      description: 'Echo the arguments back',
      run: (args, ctx) => `Args: ${args} (chat ${ctx.chatId})`,
    },
  ],

  // LLM tools: the model calls them on its own, like the built-in shell.
  tools: [
    {
      name: 'weather',              // referenced by the LLM as <tool name="weather">
      description: 'Get the weather for a city name',
      approval: false,              // true = ask the owner via the inline keyboard first
      run: async (input, ctx) => `Weather in ${input}: sunny, 32°C`,
    },
  ],

  // Hooks into the default modules (all synchronous).
  hooks: {
    onIncoming: (text, ctx) => text,          // return null to swallow the message
    onOutgoing: (text, ctx) => text,          // transform the reply before display
    onShellCommand: (command, ctx) => command // rewrite a shell command before approval
  },
};
```

A default export may also be a factory function with no arguments; it is called and its return value is used as the plugin.

## User commands: `/name` and `#name`

- A command is invoked as `/name args` or `#name args`; `args` is everything after the command word (trimmed), empty if nothing follows.
- Commands are only available to the **verified owner**.
- The built-ins `/start`, `/clear` and the `/verify` flow are handled first and always win. Unknown `/xxx` still shows the help text; unknown `#xxx` falls through to the AI as a normal message.
- The returned string is sent as one message; Telegram HTML is attempted first and falls back to plain text (same as AI replies).
- If `run` throws, the error message is sent back instead — the bot keeps running.

## LLM tools (proactive, like the shell)

When at least one tool is registered, the AI's system prompt gains a section listing every tool and the invocation syntax:

```
<tool name="weather">Hanoi</tool>
```

The flow is the same as the built-in shell:

1. The LLM ends its reply with exactly one `<tool ...>` block.
2. If `approval: true`, the owner gets the inline keyboard (Chạy/Hủy) with a readable description of the request — the same approval UI as shell commands.
3. The result (or the denial) is sent back to the LLM as the next message and it continues, up to 5 tool rounds.
4. Tool blocks are stripped from what is displayed, and a truncated (unclosed) block is recovered the same lenient way as `<cmd>`.

Errors thrown by `run` are returned to the LLM as tool output (`Lỗi công cụ: ...`), so the model can adapt instead of crashing the chat.

## Extra system prompt (passive)

`systemPrompt` is trimmed and joined (in load order) and appended after the base prompt. A plugin can thereby change the model's behavior without touching any code — e.g. force a persona, a language, or extra formatting rules.

## Hooks (touch the default modules)

All hooks are **synchronous** transforms applied in load order — keep them cheap, they run on every message:

| Hook | When | Return |
|---|---|---|
| `onIncoming(text)` | After the message arrives, before the AI sees it | New text, or `null` to swallow the message entirely (no AI call, no reply) |
| `onOutgoing(text)` | On every streaming tick, with the reply accumulated so far, before display | New text (must be a pure function of the input) |
| `onShellCommand(command)` | After the LLM requests a shell command, **before** the approval UI | The command that will actually be shown and executed |

Notes:

- `onOutgoing` receives the *accumulated* reply each tick, so never mutate state based on it repeatedly — treat it as `f(text) => text`.
- `onShellCommand` runs before approval, so the owner always approves exactly what will run.
- Hooks do not run for plugin commands (those bypass the AI) or for the `/verify` flow.
- Hooks are only available to in-process plugins; see [Worker isolation](#worker-isolation-optional).

## Worker isolation (optional)

By default a plugin runs inside the bot process — a bad plugin can crash or hang the whole bot. A plugin can instead run in its own **worker thread**: a separate V8 instance with its own heap and event loop. A crash, memory leak or infinite loop inside the worker can never take the bot down.

Enable it per plugin in `plugins.json`:

```json
[{ "package": "angellily-plugin-example", "worker": true }]
```

The owner can also **force** every plugin into a worker — even ones that did not opt in — by setting `FORCE_WORKER=1` in `.env`. Useful for trying out a plugin you don't fully trust yet.

What to expect:

- **Same code.** The plugin is loaded exactly like before, just inside the worker — no changes are required.
- **Supported:** user commands, LLM tools, and the extra system prompt.
- **Not supported: hooks.** Hooks are synchronous transforms that run on every streaming tick and cannot cross a thread boundary. A worker plugin that declares hooks gets a warning at startup and its hooks are ignored; hooks remain an in-process feature.
- **RPC.** The host talks to the worker over `postMessage`; each command/tool call waits up to 60 seconds, then fails with a timeout error.
- **Cost.** Each worker costs a few MB of RAM — workers are only started for plugins that need one.

If a worker dies (crash, `process.exit`, OOM kill), the plugin is marked dead: a warning is logged once and every further call returns an error message. The rest of the bot, including all other plugins, is unaffected.

Worker isolation protects Lily's **uptime**, not your data — it is not a security sandbox. The plugin still runs with full Node.js permissions inside its thread.

## Security

Plugins run inside the bot process with the full permissions of Node.js — they can read files, open network connections, and execute code on the machine. Only install plugins you trust, and review the source of any plugin before adding it to `plugins.json`. Prefer tools with `approval: true` for anything with side effects. Running a plugin in [worker mode](#worker-isolation-optional) limits the damage it can do to the bot's uptime, but not what it can access.

## Related modules

- `src/plugins.ts` — loader and registry (the whole system)
- `src/plugin_worker.ts` — worker entry: loads the plugin in its own thread and serves it over RPC
- `src/ai.ts` — advertises tools in the system prompt, parses and runs `<tool>` blocks
- `src/telegram.ts` — dispatches plugin commands, hosts the approval UI
- `src/main.ts` — wires everything together
