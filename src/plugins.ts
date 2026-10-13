// Plugin system: a tiny loader plus a registry.
// Supports running plugins in an isolated Single Shared Runner child process
// with a clean environment (no bot tokens, no API keys), capability-based shell
// and config file access.

import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { fork, type ChildProcess } from 'node:child_process';
import type {
  HostToRunner,
  RunnerToHost,
  RunnerRegisterMsg,
  RunnerResultMsg,
  RunnerHostRequestMsg,
  PluginManifest,
} from './plugin_runner.js';

export interface PluginContext {
  /** Telegram chat id (the AI session id is the same value as a string). */
  chatId: number;
  /** Optional shell capability provided by host */
  shell?: {
    run(command: string): Promise<{ ok: boolean; output: string }>;
  };
  /** Optional config reader scoped to plugin */
  config?: {
    read(filename: string): Promise<string>;
  };
  /** AI controller for in-process plugins (e.g. ai-gateway). */
  ai?: {
    setConfig(config: { apiKey?: string; baseURL?: string; model?: string }): void;
    getConfig(): { apiKey: string; baseURL?: string; model: string };
  };
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
  manifest?: PluginManifest;
  /** Passive: appended to the system prompt for every session. */
  systemPrompt?: string;
  /** User-invoked commands with a / or # prefix. */
  commands?: PluginCommand[];
  /** Proactive: LLM-invoked tools, like the built-in shell. */
  tools?: PluginTool[];
  /** Hooks into the default modules. */
  hooks?: PluginHooks;
}

export interface PluginRuntimeOptions {
  onShellRequest?: (pluginName: string, command: string, chatId: number) => Promise<{ ok: boolean; output: string }>;
  onReadConfig?: (pluginName: string, filename: string) => Promise<string>;
  /** AI controller exposed to in-process plugins (e.g. ai-gateway). */
  ai?: {
    setConfig(config: { apiKey?: string; baseURL?: string; model?: string }): void;
    getConfig(): { apiKey: string; baseURL?: string; model: string };
  };
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
  stop?(): void;
}

const LIST_FILE = 'plugins.json';
const RPC_TIMEOUT_MS = 60_000;

/**
 * Official / trusted plugins that run in the main process (no fork).
 * Only @angellily-scoped packages should appear here.  Plugins NOT on this
 * list always run in the isolated child-process runner regardless of what
 * plugins.json says — this is a security boundary.
 */
const TRUSTED_PLUGINS: ReadonlySet<string> = new Set([
  '@angellily/plugin-ai-gateway',
]);

interface PluginConfig {
  spec: string;
}

/** Resolve the npm package name for a spec (local path → read package.json). */
function resolvePackageName(spec: string, cwd: string): string | undefined {
  if (!IS_LOCAL.test(spec)) return spec; // already an npm name
  const dir = resolve(cwd, spec);
  try {
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
    if (typeof pkg.name === 'string') return pkg.name;
  } catch {}
  return undefined;
}

function readList(cwd: string): PluginConfig[] {
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(cwd, LIST_FILE), 'utf8'));
    if (!Array.isArray(parsed)) {
      throw new Error('must be a JSON array of package names or { "package" } objects');
    }
    return parsed.map((entry): PluginConfig => {
      if (typeof entry === 'string') return { spec: entry };
      const obj = entry as { package?: unknown };
      if (entry && typeof entry === 'object' && typeof obj.package === 'string') {
        return { spec: obj.package };
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

const IS_LOCAL = /^(?:\.{1,2}[\\/]|[\\/]|[A-Za-z]:[\\/])/;

function toSpecifier(spec: string, cwd: string): string {
  if (!IS_LOCAL.test(spec)) return spec;
  const path = resolve(cwd, spec);
  if (statSync(path, { throwIfNoEntry: false })?.isDirectory()) {
    const pkgPath = join(path, 'package.json');
    if (existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
        if (pkg.main && existsSync(join(path, pkg.main))) {
          return pathToFileURL(join(path, pkg.main)).href;
        }
      } catch {}
    }
    for (const index of ['index.mjs', 'index.js', 'index.cjs', 'dist/index.js', 'dist/index.mjs']) {
      if (existsSync(join(path, index))) return pathToFileURL(join(path, index)).href;
    }
  }
  return pathToFileURL(path).href;
}

interface PendingCall {
  resolve(output: string): void;
  reject(err: Error): void;
  timer: NodeJS.Timeout;
}

export async function loadPlugins(
  cwd: string = process.cwd(),
  options: PluginRuntimeOptions = {},
): Promise<PluginRuntime> {
  const configs = readList(cwd);
  if (configs.length === 0) {
    return createRuntime([]);
  }

  // Split by hardcoded whitelist — plugin cannot opt itself in
  const inProcessConfigs: PluginConfig[] = [];
  const runnerConfigs: PluginConfig[] = [];
  for (const cfg of configs) {
    const pkgName = resolvePackageName(cfg.spec, cwd);
    if (pkgName && TRUSTED_PLUGINS.has(pkgName)) {
      inProcessConfigs.push(cfg);
    } else {
      runnerConfigs.push(cfg);
    }
  }

  // --- In-process plugins: import directly, full context ---
  const inProcessPlugins: AngelPlugin[] = [];
  for (const cfg of inProcessConfigs) {
    try {
      const specifier = toSpecifier(cfg.spec, cwd);
      const mod = (await import(specifier)) as Record<string, unknown>;
      const exported =
        typeof mod.default === 'function' ? await (mod.default as () => unknown)() : (mod.default ?? mod);
      const plugin = exported as AngelPlugin;

      if (!plugin || typeof plugin.name !== 'string' || !plugin.name) {
        console.warn(`[plugins] in-process "${cfg.spec}" has no valid plugin export, skipped`);
        continue;
      }

      // Wrap commands/tools to inject full context (ai, shell, config)
      const wrappedCommands: PluginCommand[] = (plugin.commands ?? []).map((c) => ({
        ...c,
        run: (args: string, ctx: PluginContext) => {
          const richCtx: PluginContext = { ...ctx, ai: options.ai };
          return c.run(args, richCtx as any);
        },
      }));
      const wrappedTools: PluginTool[] = (plugin.tools ?? []).map((t) => ({
        ...t,
        run: (input: string, ctx: PluginContext) => {
          const richCtx: PluginContext = { ...ctx, ai: options.ai };
          return t.run(input, richCtx as any);
        },
      }));

      inProcessPlugins.push({
        ...plugin,
        commands: wrappedCommands,
        tools: wrappedTools,
      });
      console.log(`[plugins] loaded: ${plugin.name} (in-process)`);
    } catch (err) {
      console.warn(`[plugins] failed to load in-process "${cfg.spec}": ${(err as Error).message}`);
    }
  }

  // --- Runner plugins: fork child process for isolation ---
  if (runnerConfigs.length === 0) {
    return createRuntime(inProcessPlugins);
  }

  // Create isolated environment for runner: exclude secrets
  const safeEnv: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue;
    // Strip sensitive keys
    if (
      k.includes('TOKEN') ||
      k.includes('KEY') ||
      k.includes('SECRET') ||
      k.startsWith('TELEGRAM_') ||
      k.startsWith('OPENAI_')
    ) {
      continue;
    }
    safeEnv[k] = v;
  }

  const runnerEntry = resolve(cwd, 'dist/plugin_runner.js');
  let child: ChildProcess;
  try {
    child = fork(runnerEntry, [], {
      cwd,
      env: safeEnv,
      stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
    });
  } catch (err) {
    console.warn(`[plugins] failed to start plugin runner: ${(err as Error).message}`);
    return createRuntime([]);
  }

  child.stdout?.on('data', (d) => process.stdout.write(d));
  child.stderr?.on('data', (d) => process.stderr.write(d));

  let alive = true;
  let nextCallId = 0;
  const pendingCalls = new Map<number, PendingCall>();

  const failAll = (err: Error) => {
    for (const [, p] of pendingCalls) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    pendingCalls.clear();
  };

  const die = (reason: string) => {
    if (!alive) return;
    alive = false;
    failAll(new Error(`Plugin runner stopped: ${reason}`));
    console.warn(`[plugins] runner stopped: ${reason}`);
  };

  child.on('error', (err) => die(err.message));
  child.on('exit', (code) => die(`exited with code ${code}`));

  child.on('message', async (msg: RunnerToHost) => {
    if (!msg) return;
    if (msg.type === 'result') {
      const p = pendingCalls.get(msg.id);
      if (!p) return;
      pendingCalls.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.ok) p.resolve(msg.output);
      else p.reject(new Error(msg.output));
    } else if (msg.type === 'host_request') {
      await handleHostRequest(msg);
    }
  });

  async function handleHostRequest(req: RunnerHostRequestMsg) {
    let ok = true;
    let data: unknown;
    let error: string | undefined;

    try {
      if (req.action === 'shell') {
        const cmd = String(req.payload.command ?? '');
        const chatId = Number(req.payload.chatId ?? 0);
        if (!options.onShellRequest) throw new Error('Shell execution not supported on host');
        data = await options.onShellRequest(req.pluginName, cmd, chatId);
      } else if (req.action === 'read_config') {
        const filename = String(req.payload.filename ?? '');
        if (!options.onReadConfig) throw new Error('Config reading not supported on host');
        data = await options.onReadConfig(req.pluginName, filename);
      } else {
        throw new Error(`Unsupported host action "${req.action}"`);
      }
    } catch (err) {
      ok = false;
      error = (err as Error).message;
    }

    if (alive && child.send) {
      child.send({
        type: 'host_response',
        id: req.id,
        ok,
        data,
        error,
      } as HostToRunner);
    }
  }

  const callPlugin = (kind: 'command' | 'tool', name: string, input: string, chatId: number) => {
    if (!alive) return Promise.resolve(`Plugin runner has stopped.`);
    const id = ++nextCallId;
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        pendingCalls.delete(id);
        reject(new Error(`Call "${name}" timed out after ${RPC_TIMEOUT_MS / 1000}s.`));
      }, RPC_TIMEOUT_MS);
      pendingCalls.set(id, { resolve, reject, timer });
      child.send({
        type: 'call',
        id,
        kind,
        name,
        input,
        chatId,
      } as HostToRunner);
    });
  };

  const registerPromise = new Promise<RunnerRegisterMsg>((resolve, reject) => {
    const handler = (msg: RunnerToHost) => {
      if (msg?.type === 'register') {
        child.off('message', handler);
        resolve(msg);
      }
    };
    child.on('message', handler);
    child.once('error', reject);
    child.once('exit', (code) => reject(new Error(`Runner exited with code ${code} before registering`)));
  });

  child.send({
    type: 'init',
    specs: runnerConfigs.map((c) => c.spec),
    cwd,
  } as HostToRunner);

  let reg: RunnerRegisterMsg;
  try {
    reg = await registerPromise;
  } catch (err) {
    console.warn(`[plugins] registration failed: ${(err as Error).message}`);
    child.kill();
    return createRuntime([]);
  }

  const pluginList: AngelPlugin[] = reg.plugins.map((p) => {
    console.log(`[plugins] loaded: ${p.name} (isolated runner)`);
    return {
      name: p.name,
      ...(p.systemPrompt ? { systemPrompt: p.systemPrompt } : {}),
      commands: p.commands.map((c) => ({
        command: c.command,
        ...(c.description ? { description: c.description } : {}),
        run: (args, ctx) => callPlugin('command', c.command, args, ctx.chatId),
      })),
      tools: p.tools.map((t) => ({
        name: t.name,
        description: t.description,
        ...(t.approval ? { approval: t.approval } : {}),
        run: (input, ctx) => callPlugin('tool', t.name, input, ctx.chatId),
      })),
    };
  });

  // Merge: in-process plugins first (higher priority), then runner plugins
  const allPlugins = [...inProcessPlugins, ...pluginList];
  const runtime = createRuntime(allPlugins);
  return {
    ...runtime,
    stop: () => {
      if (alive) {
        alive = false;
        child.kill();
      }
    },
  };
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
