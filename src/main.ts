#!/usr/bin/env node
import { readFileSync, existsSync, copyFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAI, type AI } from './ai.js';
import { createAuth } from './auth.js';
import { t } from './i18n.js';
import { loadPlugins } from './plugins.js';
import { createShell } from './shell.js';
import { startTelegram, type TelegramClient } from './telegram.js';

// CLI flag handling
const args = process.argv.slice(2);

if (args.includes('--init')) {
  const cwd = process.cwd();
  // The bot's prompt lives in .angellily/ so coding agents (which treat a
  // root-level AGENTS.md as their own workspace rules) don't pick it up.
  const agentSrc = existsSync(resolve(cwd, '.angellily', 'AGENTS.md'))
    ? resolve(cwd, '.angellily', 'AGENTS.md')
    : fileURLToPath(new URL('../.angellily/AGENTS.md', import.meta.url));
  const envSrc = existsSync(resolve(cwd, '.env.example'))
    ? resolve(cwd, '.env.example')
    : fileURLToPath(new URL('../.env.example', import.meta.url));

  const targetAgent = resolve(cwd, '.angellily', 'AGENTS.md');
  const targetEnv = resolve(cwd, '.env');

  if (!existsSync(targetAgent)) {
    mkdirSync(resolve(cwd, '.angellily'), { recursive: true });
    copyFileSync(agentSrc, targetAgent);
    console.log(`Created ${targetAgent}`);
  } else {
    console.log(`${targetAgent} already exists — skipping.`);
  }

  if (!existsSync(targetEnv)) {
    copyFileSync(envSrc, targetEnv);
    console.log(`Created ${targetEnv} — edit it with your tokens, then run: npx @angellily/app`);
  } else {
    console.log(`${targetEnv} already exists — skipping.`);
  }

  console.log('Done. Edit .env, then start the bot.');
  process.exit(0);
}

if (args.includes('--help') || args.includes('-h')) {
  console.log('Usage: npx @angellily/app [options]');
  console.log('');
  console.log('Options:');
  console.log('  --init     Copy .angellily/AGENTS.md and .env.example into the current directory');
  console.log('  --help     Show this help');
  console.log('');
  console.log('The bot auto-discovers .angellily/AGENTS.md and .env from the current directory.');
  process.exit(0);
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`Missing required environment variable: ${name}`);
    console.error('Run `npx @angellily/app --init` first, or create .env manually.');
    process.exit(1);
  }
  return value;
}

// The bot's system prompt lives in .angellily/AGENTS.md. Try CWD first
// (user's project), fall back to the package root (dev mode).
function loadSystemPrompt(): string {
  const candidates = [
    resolve(process.cwd(), '.angellily', 'AGENTS.md'),
    fileURLToPath(new URL('../.angellily/AGENTS.md', import.meta.url)),
  ];
  for (const p of candidates) {
    if (existsSync(p)) return readFileSync(p, 'utf8').trim();
  }
  console.error('Missing .angellily/AGENTS.md (the bot\'s system prompt).');
  console.error('Run `npx @angellily/app --init` to create one, or create .angellily/AGENTS.md manually.');
  process.exit(1);
}

// Auto-load .env from CWD if not already loaded (Node >= 20.6 has --env-file,
// but npx doesn't pass it — read it manually as a fallback).
if (!process.env.TELEGRAM_BOT_TOKEN && !process.env.OPENAI_API_KEY) {
  const envPath = resolve(process.cwd(), '.env');
  if (existsSync(envPath)) {
    for (const line of readFileSync(envPath, 'utf8').split('\n')) {
      const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
      if (m) process.env[m[1]] = m[2];
    }
  }
}

const token = requireEnv('TELEGRAM_BOT_TOKEN');
const apiKey = requireEnv('OPENAI_API_KEY');

const maxHistory = Number(process.env.MAX_HISTORY);

const shell = await createShell();
const auth = createAuth();

// Late-bound: the approval UI lives in the Telegram module and is assigned
// right after startTelegram returns.
let telegram: TelegramClient | null = null;

// Deferred AI controller proxy: plugins load before createAI(), but in-process
// plugins (e.g. ai-gateway) need setConfig/getConfig at command time, which is
// always after ai is initialized. The proxy forwards calls to the real AI once
// it exists.
let realAI: AI | null = null;
const aiProxy = {
  setConfig(config: { apiKey?: string; baseURL?: string; model?: string }) {
    if (!realAI) throw new Error('AI not initialized yet');
    realAI.setConfig(config);
  },
  getConfig() {
    if (!realAI) throw new Error('AI not initialized yet');
    return realAI.getConfig();
  },
};

const plugins = await loadPlugins(process.cwd(), {
  ai: aiProxy,
  onShellRequest: async (pluginName, command, chatId) => {
    if (!telegram) return { ok: false, output: 'Telegram not ready' };
    const approval = await telegram.requestApproval(
      chatId,
      `[Plugin: ${pluginName}] yêu cầu chạy lệnh shell:\n${command}`,
      () => shell.run(command),
    );
    if (!approval.approved) {
      return { ok: false, output: 'Chủ sở hữu từ chối phê duyệt lệnh.' };
    }
    return { ok: true, output: approval.output };
  },
  onReadConfig: async (pluginName, filename) => {
    // Files are safely isolated in .angellily/plugins/<pluginName>/<filename>
    const safePath = resolve(process.cwd(), '.angellily', 'plugins', pluginName, filename);
    if (!existsSync(safePath)) {
      throw new Error(`File config "${filename}" không tồn tại cho plugin "${pluginName}".`);
    }
    return readFileSync(safePath, 'utf8');
  },
});

const ai = createAI({
  apiKey,
  baseURL: process.env.OPENAI_BASE_URL,
  model: process.env.OPENAI_MODEL,
  maxHistory: Number.isFinite(maxHistory) && maxHistory > 0 ? maxHistory : undefined,
  system: `${loadSystemPrompt()}\n\nUnderlying model: ${process.env.OPENAI_MODEL ?? 'gpt-4o-mini'}.`,
  environment: shell.describe(),
  extraSystem: plugins.systemPrompt() || undefined,
  runCommand: (sessionId, command) => {
    const chatId = Number(sessionId);
    const finalCommand = plugins.applyShellCommand(command, { chatId });
    return telegram
      ? telegram.requestApproval(chatId, finalCommand)
      : Promise.resolve({ approved: false, output: '' });
  },
  tools: plugins.toolInfos(),
  runTool: async (sessionId, name, input) => {
    const chatId = Number(sessionId);
    const tool = plugins.getTool(name);
    if (!tool) return { approved: false, output: t.noTool(name) };
    const toolCtx = {
      chatId,
    };
    try {
      if (tool.approval) {
        if (!telegram) return { approved: false, output: '' };
        return await telegram.requestApproval(
          chatId,
          t.toolApproval(name, input),
          () =>
            Promise.resolve(tool.run(input, toolCtx)).then((output) => ({
              ok: true,
              output,
            })),
        );
      }
      return { approved: true, output: await tool.run(input, toolCtx) };
    } catch (err) {
      console.error(`[plugins] tool ${name} failed:`, err);
      return { approved: true, output: t.toolError((err as Error).message) };
    }
  },
});

// Now bind the deferred proxy so in-process plugins can control the AI.
realAI = ai;

telegram = startTelegram({
  token,
  auth,
  runCommand: (command) => shell.run(command),
  onExternalCommand: async (chatId, text) => {
    const match = plugins.matchCommand(text);
    if (!match) return null;
    try {
      return await match.command.run(match.args, {
        chatId,
      });
    } catch (err) {
      console.error(`[plugins] command ${text} failed:`, err);
      return t.pluginError((err as Error).message);
    }
  },
  onText: (chatId, text, onPartial, onCommit) => {
    const incoming = plugins.applyIncoming(text, { chatId });
    if (incoming === null) {
      console.log(`[chat ${chatId}] a plugin swallowed the message`);
      return Promise.resolve('');
    }
    return ai.chat(
      String(chatId),
      incoming,
      (t) => onPartial(plugins.applyOutgoing(t, { chatId })),
      onCommit,
    );
  },
  onClear: (chatId) => ai.clear(String(chatId)),
});

console.log('Angel Lily started. Listening for messages...');
console.log(`Model: ${process.env.OPENAI_MODEL ?? 'gpt-4o-mini'}`);
console.log(`Base URL: ${process.env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1'}`);
console.log(`Shell environment: ${shell.describe()}`);
console.log(`Plugins: ${plugins.names.length ? plugins.names.join(', ') : '(none)'}`);

// Register bot commands with Telegram (built-in + plugin commands)
const builtinCommands = [
  { command: 'start', description: 'Show help' },
  { command: 'clear', description: 'Clear conversation' },
];
const allCommands = [...builtinCommands, ...plugins.commandInfos()];
telegram.setMyCommands(allCommands).catch(() => {});
