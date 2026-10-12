// The entry file that runs INSIDE a plugin worker thread. It loads the very
// same plugin module the host would load, registers a serializable
// description of itself (no functions — functions cannot cross a thread
// boundary), and then serves command/tool calls over postMessage.
//
// The worker is a separate V8 instance with its own heap and event loop: a
// crash, memory leak or infinite loop here can never take the bot down.

import { parentPort, workerData } from 'node:worker_threads';
import type { AngelPlugin, WorkerCall, WorkerRegister } from './plugins.js';

async function main(): Promise<void> {
  const port = parentPort;
  if (!port) throw new Error('plugin_worker must run inside a Worker thread');
  const { specifier } = workerData as { specifier: string };

  const mod = (await import(specifier)) as Record<string, unknown>;
  // Object or factory function; await also supports async factories.
  const exported =
    typeof mod.default === 'function' ? await (mod.default as () => unknown)() : (mod.default ?? mod);
  const plugin = exported as AngelPlugin;
  if (!plugin || typeof plugin.name !== 'string' || !plugin.name) {
    throw new Error('module has no default export with a plugin name');
  }

  const register: WorkerRegister = {
    type: 'register',
    name: plugin.name,
    systemPrompt: plugin.systemPrompt,
    hasHooks: !!plugin.hooks,
    commands: (plugin.commands ?? []).map((c) => ({ command: c.command, description: c.description })),
    tools: (plugin.tools ?? []).map((t) => ({
      name: t.name,
      description: t.description,
      approval: t.approval,
    })),
  };
  port.postMessage(register);

  const serve = async (msg: WorkerCall): Promise<void> => {
    let ok = true;
    let output: string;
    try {
      const ctx = { chatId: msg.chatId };
      if (msg.kind === 'command') {
        const cmd = plugin.commands?.find((c) => c.command === msg.name);
        output = cmd ? await cmd.run(msg.input, ctx) : `Unknown command "${msg.name}".`;
      } else {
        const tool = plugin.tools?.find((t) => t.name === msg.name);
        output = tool ? await tool.run(msg.input, ctx) : `Unknown tool "${msg.name}".`;
      }
    } catch (err) {
      ok = false;
      output = (err as Error).message;
    }
    port.postMessage({ type: 'result', id: msg.id, ok, output });
  };

  port.on('message', (msg: WorkerCall) => {
    if (!msg || msg.type !== 'call') return;
    void serve(msg);
  });
}

main().catch((err) => {
  // Tell the host why loading failed, then exit — the host logs and moves on.
  parentPort?.postMessage({ type: 'error', message: (err as Error).message });
  process.exitCode = 1;
});
