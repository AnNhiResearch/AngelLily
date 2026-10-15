// The entry file that runs INSIDE the isolated plugin runner process.
// It loads plugins, provides safe context/APIs (shell via host approval,
// scoped config files, no raw Telegram/env secrets), and serves calls over Node IPC.

import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export interface PluginContext {
  chatId: number;
  shell: {
    run(command: string): Promise<{ ok: boolean; output: string }>;
  };
  config: {
    read(filename: string): Promise<string>;
  };
}

export interface PluginCommand {
  command: string;
  description?: string;
  run(args: string, ctx: PluginContext): string | Promise<string>;
}

export interface PluginTool {
  name: string;
  description: string;
  approval?: boolean;
  run(input: string, ctx: PluginContext): string | Promise<string>;
}

export interface PluginManifest {
  name?: string;
  permissions?: {
    shell?: boolean;
    configFiles?: string[];
  };
}

export interface AngelPlugin {
  name: string;
  description?: string;
  manifest?: PluginManifest;
  systemPrompt?: string;
  commands?: PluginCommand[];
  tools?: PluginTool[];
}

export interface RunnerInitMsg {
  type: 'init';
  specs: string[];
  cwd: string;
}

export interface RunnerCallMsg {
  type: 'call';
  id: number;
  kind: 'command' | 'tool';
  name: string;
  input: string;
  chatId: number;
}

export interface RunnerHostResponseMsg {
  type: 'host_response';
  id: number;
  ok: boolean;
  data?: unknown;
  error?: string;
}

export type HostToRunner = RunnerInitMsg | RunnerCallMsg | RunnerHostResponseMsg;

export interface RunnerRegisterMsg {
  type: 'register';
  plugins: {
    name: string;
    description?: string;
    systemPrompt?: string;
    commands: { command: string; description?: string }[];
    tools: { name: string; description: string; approval?: boolean }[];
  }[];
}

export interface RunnerResultMsg {
  type: 'result';
  id: number;
  ok: boolean;
  output: string;
}

export interface RunnerHostRequestMsg {
  type: 'host_request';
  id: number;
  pluginName: string;
  action: 'shell' | 'read_config';
  payload: Record<string, unknown>;
}

export type RunnerToHost = RunnerRegisterMsg | RunnerResultMsg | RunnerHostRequestMsg;

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

const loadedPlugins = new Map<string, AngelPlugin>();
const pendingHostRequests = new Map<number, { resolve: (val: unknown) => void; reject: (err: Error) => void }>();
let nextHostReqId = 0;

function requestHost(pluginName: string, action: 'shell' | 'read_config', payload: Record<string, unknown>): Promise<unknown> {
  const id = ++nextHostReqId;
  return new Promise((res, rej) => {
    pendingHostRequests.set(id, { resolve: res, reject: rej });
    const msg: RunnerHostRequestMsg = {
      type: 'host_request',
      id,
      pluginName,
      action,
      payload,
    };
    if (process.send) {
      process.send(msg);
    } else {
      rej(new Error('Process IPC not available'));
    }
  });
}

function createPluginContext(plugin: AngelPlugin, chatId: number): PluginContext {
  return {
    chatId,
    shell: {
      async run(command: string) {
        if (!plugin.manifest?.permissions?.shell) {
          throw new Error(`Plugin "${plugin.name}" does not have "shell" permission in manifest.`);
        }
        const res = (await requestHost(plugin.name, 'shell', { command, chatId })) as { ok: boolean; output: string };
        return res;
      },
    },
    config: {
      async read(filename: string) {
        const allowedFiles = plugin.manifest?.permissions?.configFiles ?? [];
        if (!allowedFiles.includes(filename)) {
          throw new Error(`File "${filename}" is not declared in manifest configFiles for plugin "${plugin.name}".`);
        }
        const content = (await requestHost(plugin.name, 'read_config', { filename })) as string;
        return content;
      },
    },
  };
}

async function handleInit(specs: string[], cwd: string): Promise<void> {
  const registered: RunnerRegisterMsg['plugins'] = [];

  for (const spec of specs) {
    try {
      const specifier = toSpecifier(spec, cwd);
      const mod = (await import(specifier)) as Record<string, unknown>;
      const exported =
        typeof mod.default === 'function' ? await (mod.default as () => unknown)() : (mod.default ?? mod);
      const plugin = exported as AngelPlugin;

      if (!plugin || typeof plugin.name !== 'string' || !plugin.name) {
        console.warn(`[plugin-runner] "${spec}" has no valid plugin export, skipped`);
        continue;
      }
      if (loadedPlugins.has(plugin.name)) {
        console.warn(`[plugin-runner] duplicate plugin name "${plugin.name}", skipped`);
        continue;
      }

      let description = plugin.description;
      if (!description && IS_LOCAL.test(spec)) {
        try {
          const pkgPath = join(resolve(cwd, spec), 'package.json');
          if (existsSync(pkgPath)) {
            const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
            if (typeof pkg.description === 'string') description = pkg.description;
          }
        } catch {}
      }

      loadedPlugins.set(plugin.name, plugin);
      registered.push({
        name: plugin.name,
        description,
        systemPrompt: plugin.systemPrompt,
        commands: (plugin.commands ?? []).map((c) => ({ command: c.command, description: c.description })),
        tools: (plugin.tools ?? []).map((t) => ({
          name: t.name,
          description: t.description,
          approval: t.approval,
        })),
      });
    } catch (err) {
      console.warn(`[plugin-runner] failed to load "${spec}": ${(err as Error).message}`);
    }
  }

  process.send?.({
    type: 'register',
    plugins: registered,
  } as RunnerRegisterMsg);
}

async function handleCall(msg: RunnerCallMsg): Promise<void> {
  let ok = true;
  let output = '';

  try {
    let targetPlugin: AngelPlugin | undefined;
    if (msg.kind === 'command') {
      for (const p of loadedPlugins.values()) {
        if (p.commands?.some((c) => c.command === msg.name)) {
          targetPlugin = p;
          break;
        }
      }
      if (!targetPlugin) throw new Error(`Unknown command "${msg.name}".`);
      const cmd = targetPlugin.commands!.find((c) => c.command === msg.name)!;
      const ctx = createPluginContext(targetPlugin, msg.chatId);
      output = await cmd.run(msg.input, ctx);
    } else {
      for (const p of loadedPlugins.values()) {
        if (p.tools?.some((t) => t.name === msg.name)) {
          targetPlugin = p;
          break;
        }
      }
      if (!targetPlugin) throw new Error(`Unknown tool "${msg.name}".`);
      const tool = targetPlugin.tools!.find((t) => t.name === msg.name)!;
      const ctx = createPluginContext(targetPlugin, msg.chatId);
      output = await tool.run(msg.input, ctx);
    }
  } catch (err) {
    ok = false;
    output = (err as Error).message;
  }

  process.send?.({
    type: 'result',
    id: msg.id,
    ok,
    output,
  } as RunnerResultMsg);
}

process.on('message', (msg: HostToRunner) => {
  if (!msg) return;
  if (msg.type === 'init') {
    void handleInit(msg.specs, msg.cwd);
  } else if (msg.type === 'call') {
    void handleCall(msg);
  } else if (msg.type === 'host_response') {
    const p = pendingHostRequests.get(msg.id);
    if (!p) return;
    pendingHostRequests.delete(msg.id);
    if (msg.ok) p.resolve(msg.data);
    else p.reject(new Error(msg.error ?? 'Host request failed'));
  }
});
