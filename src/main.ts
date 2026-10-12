#!/usr/bin/env node
import { readFileSync, existsSync, copyFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createAI } from './ai.js';
import { createAuth } from './auth.js';
import { t } from './i18n.js';
import { loadPlugins } from './plugins.js';
import { createShell } from './shell.js';
import { startTelegram, type TelegramClient } from './telegram.js';

// CLI flag handling
const args = process.argv.slice(2);

if (args.includes('--init')) {
  const cwd = process.cwd();
  const agentSrc = existsSync(resolve(cwd, 'AGENTS.md'))
    ? resolve(cwd, 'AGENTS.md')
    : resolve(new URL('../AGENTS.md', import.meta.url).pathname);
  const envSrc = existsSync(resolve(cwd, '.env.example'))
    ? resolve(cwd, '.env.example')
    : resolve(new URL('../.env.example', import.meta.url).pathname);

  const targetAgent = resolve(cwd, 'AGENTS.md');
  const targetEnv = resolve(cwd, '.env');

  if (!existsSync(targetAgent)) {
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
  console.log('  --init     Copy AGENTS.md and .env.example into the current directory');
  console.log('  --help     Show this help');
  console.log('');
  console.log('The bot auto-discovers AGENTS.md and .env from the current directory.');
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

// The bot's system prompt lives in AGENTS.md. Try CWD first (user's project),
// fall back to the package root (dev mode).
function loadSystemPrompt(): string {
  const candidates = [
    resolve(process.cwd(), 'AGENTS.md'),
    resolve(new URL('../AGENTS.md', import.meta.url).pathname),
  ];
  for (const p of candidates) {
    if (existsSync(p)) return readFileSync(p, 'utf8').trim();
  }
  console.error('Missing AGENTS.md (the bot\'s system prompt).');
  console.error('Run `npx @angellily/app --init` to create one, or create AGENTS.md manually.');
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

const plugins = await loadPlugins();
const shell = await createShell();
const auth = createAuth();

// Late-bound: the approval UI lives in the Telegram module and is assigned
// right after startTelegram returns.
let telegram: TelegramClient | null = null;

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
    // Plugin hooks may rewrite the command BEFORE it is shown for approval,
    // so the owner always approves exactly what will run.
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
    try {
      if (tool.approval) {
        if (!telegram) return { approved: false, output: '' };
        return await telegram.requestApproval(
          chatId,
          t.toolApproval(name, input),
          () =>
            Promise.resolve(tool.run(input, { chatId })).then((output) => ({
              ok: true,
              output,
            })),
        );
      }
      return { approved: true, output: await tool.run(input, { chatId }) };
    } catch (err) {
      console.error(`[plugins] tool ${name} failed:`, err);
      return { approved: true, output: t.toolError((err as Error).message) };
    }
  },
});

telegram = startTelegram({
  token,
  auth,
  runCommand: (command) => shell.run(command),
  onExternalCommand: async (chatId, text) => {
    const match = plugins.matchCommand(text);
    if (!match) return null;
    try {
      return await match.command.run(match.args, { chatId });
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
