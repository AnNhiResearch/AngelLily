// Plugin system: a tiny loader plus a registry. Plugins are npm packages
// (or local folders) listed in plugins.json; each default-exports an
// AngelPlugin. Nothing here knows about Telegram, the AI or the shell —
// main.ts wires the registry into the existing modules.
//
// A plugin can also run in its own worker thread (isolation): the same
// module is loaded inside a dedicated V8 instance and the host talks to it
// over postMessage. Workers only support commands, tools and systemPrompt —
// hooks are synchronous per-tick transforms and stay in-process only.

import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';

export interface PluginContext {
  /** Telegram chat id (the AI session id is the same value as a string). */
  chatId: number;
}

export interface PluginCommand {
  /** Name without the leading / or # — "weather" matches /weather and #weather. */
  command: string;
  description?: string;
  /** args = everything after the command word. Return the reply text (HTML allowed). */
  run(args: string, ctx: PluginContext): string | Promise<string>;
}

export interface PluginTool {
  /** Unique name the LLM references in <tool name="...">input</tool>. */
  name: string;
  /** Shown to the LLM so it knows when to use the tool. */
  description: string;
  /** Ask the owner via the inline keyboard before running. Default: false. */
  approval?: boolean;
  run(input: string, ctx: PluginContext): string | Promise<string>;
}

export interface PluginHooks {
  /** Transform a user message before the AI sees it. Return null to swallow it. */
  onIncoming?(text: string, ctx: PluginContext): string | null;
  /** Transform the AI reply (accumulated so far) before it is displayed. */
  onOutgoing?(text: string, ctx: PluginContext): string;
  /** Rewrite a shell command before it is shown for approval. */
  onShellCommand?(command: string, ctx: PluginContext): string;
}

export interface AngelPlugin {
  /** Unique plugin name. The first plugin wins on name conflicts. */
  name: string;
  /** Passive: appended to the system prompt for every session. */
  systemPrompt?: string;
  /** User-invoked commands with a / or # prefix. */
  commands?: PluginCommand[];
  /** Proactive: LLM-invoked tools, like the built-in shell. */
  tools?: PluginTool[];
  /** Hooks into the default modules. */
  hooks?: PluginHooks;
}

// Wire protocol between the host and a plugin worker (src/plugin_worker.ts).
export interface WorkerRegister {
  type: 'register';
  name: string;
  systemPrompt?: string;
  hasHooks: boolean;
  commands: { command: string; description?: string }[];
  tools: { name: string; description: string; approval?: boolean }[];
}
export interface WorkerCall {
  type: 'call';
  id: number;
  kind: 'command' | 'tool';
  name: string;
  input: string;
  chatId: number;
}
export interface WorkerResult {
  type: 'result';
  id: number;
  ok: boolean;
  output: string;
}
export interface WorkerError {
  type: 'error';
  message: string;
}

export interface PluginRuntime {
  readonly names: readonly string[];
  /** Combined extra system prompt (empty string when no plugin provides one). */
  systemPrompt(): string;
  toolInfos(): { name: string; description: string }[];
  getTool(name: string): PluginTool | undefined;
  /** "/name args" or "#name args" → the registered command plus its args. */
  matchCommand(text: string): { command: PluginCommand; args: string } | undefined;
  applyIncoming(text: string, ctx: PluginContext): string | null;
  applyOutgoing(text: string, ctx: PluginContext): string;
  applyShellCommand(command: string, ctx: PluginContext): string;
}

const LIST_FILE = 'plugins.json';
const RPC_TIMEOUT_MS = 60_000;

interface PluginConfig {
  /** npm package name or local folder path. */
  spec: string;
  /** Run in a dedicated worker thread instead of the bot process. */
  worker: boolean;
}

function readList(cwd: string): PluginConfig[] {
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(cwd, LIST_FILE), 'utf8'));
    if (!Array.isArray(parsed)) {
      throw new Error('must be a JSON array of package names or { "package", "worker" } objects');
    }
    return parsed.map((entry): PluginConfig => {
      if (typeof entry === 'string') return { spec: entry, worker: false };
      const obj = entry as { package?: unknown; worker?: unknown };
      if (entry && typeof entry === 'object' && typeof obj.package === 'string') {
        return { spec: obj.package, worker: obj.worker === true };
      }
      throw new Error('each entry must be a package name or an object with a "package" field');
    });
  } catch (err) {
    if ((err as { code?: string }).code !== 'ENOENT') {
      console.warn(
        `[plugins] ${LIST_FILE} is invalid, continuing without plugins: ${(err as Error).message}`,
      );
    }
    return [];
  }
}

// "./x", "../x", "/x", "\x" or "C:\x" are local folders; anything else is an
// npm package name (scoped names like "@org/pkg" are fine).
const IS_LOCAL = /^(?:\.{1,2}[\\/]|[\\/]|[A-Za-z]:[\\/])/;

function toSpecifier(spec: string, cwd: string): string {
  if (!IS_LOCAL.test(spec)) return spec;
  const path = resolve(cwd, spec);
  // ESM cannot import a directory; resolve it to its entry file.
  if (statSync(path, { throwIfNoEntry: false })?.isDirectory()) {
    for (const index of ['index.mjs', 'index.js', 'index.cjs']) {
      if (existsSync(join(path, index))) return pathToFileURL(join(path, index)).href;
    }
  }
  return pathToFileURL(path).href;
}

interface Pending {
  resolve(output: string): void;
  reject(err: Error): void;
  timer: NodeJS.Timeout;
}

// Loads the plugin inside a worker thread and returns a normal AngelPlugin
// whose run() functions proxy over postMessage. If the worker dies, calls
// fail with an error message and the bot keeps running.
function createWorkerPlugin(config: PluginConfig, cwd: string): Promise<AngelPlugin> {
  const specifier = toSpecifier(config.spec, cwd);
  const worker = new Worker(fileURLToPath(new URL('./plugin_worker.js', import.meta.url)), {
    workerData: { specifier },
  });

  let label = config.spec;
  let loaded = false;
  let alive = true;
  let nextId = 0;
  const pending = new Map<number, Pending>();

  const failAll = (err: Error) => {
    for (const [, p] of pending) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    pending.clear();
  };
  const die = (reason: string) => {
    if (!alive) return;
    alive = false;
    failAll(new Error(`Plugin "${label}" has stopped (worker exited).`));
    if (loaded) console.warn(`[plugins] worker for "${label}" stopped: ${reason}`);
  };

  worker.on('message', (msg: WorkerResult) => {
    if (!msg || msg.type !== 'result') return;
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    clearTimeout(p.timer);
    if (msg.ok) p.resolve(msg.output);
    else p.reject(new Error(msg.output));
  });
  worker.on('error', (err) => die(err.message));
  worker.on('exit', (code) => die(`exited with code ${code}`));

  const call = (kind: 'command' | 'tool', name: string, input: string, chatId: number) => {
    if (!alive) return Promise.resolve(`Plugin "${label}" has stopped (worker exited).`);
    const id = ++nextId;
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`Plugin "${label}" did not respond within ${RPC_TIMEOUT_MS / 1000}s.`));
      }, RPC_TIMEOUT_MS);
      pending.set(id, { resolve, reject, timer });
      worker.postMessage({ type: 'call', id, kind, name, input, chatId });
    });
  };

  const info = new Promise<WorkerRegister>((resolve, reject) => {
    worker.once('message', (msg: WorkerRegister | WorkerError) => {
      if (msg?.type === 'register') resolve(msg);
      else if (msg?.type === 'error') reject(new Error(msg.message));
      else reject(new Error('unexpected first message from worker'));
    });
    worker.once('error', (err) => reject(err));
    worker.once('exit', (code) =>
      reject(new Error(`worker exited with code ${code} before registering`)),
    );
  }).then((reg): AngelPlugin => {
    loaded = true;
    label = reg.name;
    if (reg.hasHooks) {
      console.warn(
        `[plugins] "${reg.name}" declares hooks; hooks are ignored in worker mode (in-process only)`,
      );
    }
    console.log(`[plugins] loaded: ${reg.name} (worker)`);
    return {
      name: reg.name,
      ...(reg.systemPrompt ? { systemPrompt: reg.systemPrompt } : {}),
      commands: reg.commands.map((c) => ({
        command: c.command,
        ...(c.description ? { description: c.description } : {}),
        run: (args, ctx) => call('command', c.command, args, ctx.chatId),
      })),
      tools: reg.tools.map((t) => ({
        name: t.name,
        description: t.description,
        ...(t.approval ? { approval: t.approval } : {}),
        run: (input, ctx) => call('tool', t.name, input, ctx.chatId),
      })),
    };
  });

  return info;
}

export async function loadPlugins(cwd: string = process.cwd()): Promise<PluginRuntime> {
  const list: AngelPlugin[] = [];
  const forceWorker = ['1', 'true'].includes((process.env.FORCE_WORKER ?? '').toLowerCase());
  for (const config of readList(cwd)) {
    try {
      if (config.worker || forceWorker) {
        list.push(await createWorkerPlugin(config, cwd));
      } else {
        const mod: Record<string, unknown> = await import(toSpecifier(config.spec, cwd));
        const exported =
          typeof mod.default === 'function'
            ? (mod.default as () => unknown)()
            : (mod.default ?? mod);
        const plugin = exported as AngelPlugin;
        if (!plugin || typeof plugin.name !== 'string' || !plugin.name) {
          console.warn(`[plugins] "${config.spec}" has no default export with a name, skipped`);
          continue;
        }
        if (list.some((p) => p.name === plugin.name)) {
          console.warn(`[plugins] duplicate plugin name "${plugin.name}" from "${config.spec}", skipped`);
          continue;
        }
        list.push(plugin);
        console.log(`[plugins] loaded: ${plugin.name}`);
      }
    } catch (err) {
      // One broken plugin must not take the whole bot down.
      console.warn(`[plugins] failed to load "${config.spec}": ${(err as Error).message}`);
    }
  }
  return createRuntime(list);
}

function createRuntime(list: AngelPlugin[]): PluginRuntime {
  const commands = new Map<string, PluginCommand>();
  const tools = new Map<string, PluginTool>();
  for (const plugin of list) {
    for (const command of plugin.commands ?? []) {
      if (!commands.has(command.command)) commands.set(command.command, command);
    }
    for (const tool of plugin.tools ?? []) {
      if (!tools.has(tool.name)) tools.set(tool.name, tool);
    }
  }
  const hooks = list.map((p) => p.hooks).filter((h): h is PluginHooks => !!h);

  return {
    names: list.map((p) => p.name),
    systemPrompt: () =>
      list
        .map((p) => p.systemPrompt?.trim())
        .filter((s): s is string => !!s)
        .join('\n\n'),
    toolInfos: () => [...tools.values()].map((t) => ({ name: t.name, description: t.description })),
    getTool: (name) => tools.get(name),
    matchCommand: (text) => {
      const m = text.match(/^([/#])([A-Za-z0-9_-]+)(?:\s+([\s\S]*))?$/);
      const command = m ? commands.get(m[2]) : undefined;
      if (!m || !command) return undefined;
      return { command, args: (m[3] ?? '').trim() };
    },
    applyIncoming: (text, ctx) => {
      let t = text;
      for (const h of hooks) {
        const out = h.onIncoming?.(t, ctx);
        if (out === null) return null;
        if (typeof out === 'string') t = out;
      }
      return t;
    },
    applyOutgoing: (text, ctx) => {
      let t = text;
      for (const h of hooks) t = h.onOutgoing?.(t, ctx) ?? t;
      return t;
    },
    applyShellCommand: (command, ctx) => {
      let t = command;
      for (const h of hooks) t = h.onShellCommand?.(t, ctx) ?? t;
      return t;
    },
  };
}
