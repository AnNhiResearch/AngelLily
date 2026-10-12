import { readFileSync } from 'node:fs';
import { createAI } from './ai.js';
import { createAuth } from './auth.js';
import { t } from './i18n.js';
import { loadPlugins } from './plugins.js';
import { createShell } from './shell.js';
import { startTelegram, type TelegramClient } from './telegram.js';

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`Missing required environment variable: ${name}`);
    process.exit(1);
  }
  return value;
}

// The bot's system prompt lives in AGENTS.md (project root) so the persona can
// be edited without touching the code.
function loadSystemPrompt(): string {
  try {
    return readFileSync(new URL('../AGENTS.md', import.meta.url), 'utf8').trim();
  } catch {
    console.error("Missing AGENTS.md in the project root (the bot's system prompt).");
    process.exit(1);
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
