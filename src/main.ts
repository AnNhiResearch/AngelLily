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
import {
  serveMiniAppGet,
  miniAppHealth,
  validateInitData,
  miniappBaseUrl,
  miniappPublicUrl,
} from './miniapp_serve.js';

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

const locale = (process.env.BOT_LANGUAGE ?? 'vi').trim().toLowerCase().startsWith('en') ? 'en' : 'vi';
const shell = await createShell();
const auth = createAuth();

// Late-bound: the approval UI lives in the Telegram module and is assigned
// right after startTelegram returns.
let telegram: TelegramClient | null = null;

// ---------- Telegram Mini Apps host (plans A + B + C) ----------
// A: webhook server in telegram.ts serves GET /miniapp/<id>/ (zero extra port).
// B: MINIAPP_PORT>0 starts a tiny standalone server here (any transport) —
//    expose it with a tunnel and set MINIAPP_PUBLIC_URL to the tunnel URL.
//    Polling-friendly, Termux/NAT-friendly, no extra dependencies.
// C: no public HTTPS -> sendButton falls back to sending index.html as a file.
const miniappHost = {
  getPublicUrl(appId: string): string | null {
    return miniappPublicUrl(appId);
  },
  async sendButton(chatId: number, appId: string, title: string): Promise<void> {
    const url = this.getPublicUrl(appId);
    if (url && telegram) {
      await telegram.sendMiniApp(chatId, title, url);
      return;
    }
    // Fallback C: no HTTPS or telegram not ready — send single-file HTML.
    try {
      const file = resolve(process.cwd(), '.angellily', 'miniapp', appId, 'index.html');
      if (telegram && existsSync(file)) {
        await telegram.sendDocument(chatId, `${appId}.html`, readFileSync(file), 'text/html');
        return;
      }
    } catch (err) {
      console.warn(`[miniapp] file fallback failed for ${appId}:`, err);
    }
    console.warn(`[miniapp] no public URL and no file fallback for ${appId}`);
  },
};

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
  miniapp: miniappHost,
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
  extraSystemPrompt: () => plugins.systemPrompt() || '',
  runCommand: async (sessionId, command) => {
    const chatId = Number(sessionId);
    const finalCommand = plugins.applyShellCommand(command, { chatId, locale });
    const keepTyping = setInterval(() => {
      telegram?.sendTyping(chatId).catch(() => {});
    }, 2500);
    try {
      return telegram
        ? await telegram.requestApproval(chatId, finalCommand)
        : { approved: false, output: '' };
    } finally {
      clearInterval(keepTyping);
    }
  },
  tools: () => [
    {
      name: 'inspect_plugins',
      description: 'Request permission to inspect available installed plugins, their descriptions, user-only commands (which only the user can run), and available AI tools.',
    },
    ...plugins.toolInfos(),
  ],
  runTool: async (sessionId, name, input) => {
    const chatId = Number(sessionId);
    // Streaming stalls while a tool runs (tool exec, approval wait, next
    // first token) and clients would otherwise show a dead bot — keep the
    // typing indicator alive until the tool round resolves.
    const keepTyping = setInterval(() => {
      telegram?.sendTyping(chatId).catch(() => {});
    }, 2500);
    try {
    if (name === 'inspect_plugins') {
      if (!telegram) return { approved: false, output: '' };
      return await telegram.requestApproval(
        chatId,
        t.pluginInspectApproval,
        async () => {
          const list = plugins.listStatus();
          const tools = plugins.toolInfos();
          const info = [
            'Installed plugins:',
            ...list.map((p) => {
              const desc = p.description ? ` - ${p.description}` : '';
              const cmds = p.commands && p.commands.length > 0
                ? `\n    User-only commands: ${p.commands.map((c) => `/${c.command}${c.description ? ` (${c.description})` : ''}`).join(', ')}`
                : '';
              return `- ${p.name}${p.verified ? ' (VERIFIED)' : ''} [${p.enabled ? 'ACTIVE' : 'DISABLED'}]${desc}${cmds}`;
            }),
            '',
            'Active plugin tools (callable by AI):',
            ...(tools.length ? tools.map((t) => '- ' + t.name + ': ' + t.description) : ['(none)']),
            '',
            'Note: Some plugins only provide user-only commands (e.g. /gateway, /model) for user-driven configuration. You (the AI) cannot execute user-only commands directly, but you can suggest them to the user.',
          ].join('\n');
          return { ok: true, output: info };
        },
      );
    }
    const tool = plugins.getTool(name);
    if (!tool) return { approved: false, output: t.noTool(name) };
    const toolCtx = {
      chatId,
      locale,
      miniapp: miniappHost,
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
    } finally {
      clearInterval(keepTyping);
    }
  },
});

// Now bind the deferred proxy so in-process plugins can control the AI.
realAI = ai;

// Initialize plugins (e.g. ai-gateway loads active provider/account/model from gateways.json)
await plugins.init({ chatId: 0, locale, ai: aiProxy, miniapp: miniappHost });

const webhookUrl = process.env.TELEGRAM_WEBHOOK_URL;
const webhookPort = Number(process.env.TELEGRAM_WEBHOOK_PORT) || 3000;
const webhookSecret = process.env.TELEGRAM_WEBHOOK_SECRET;
const transportMode = process.env.TELEGRAM_TRANSPORT === 'polling' ? 'polling' : (webhookUrl ? 'webhook' : 'polling');

// Plan B (full): standalone Mini App server. Runs whenever MINIAPP_PORT>0,
// on ANY transport — polling (no webhook server exists) or webhook (split
// traffic: Telegram updates on webhook port, Mini Apps on this port).
// Same routes as the webhook server: GET /miniapp/<id>/, GET /miniapp/health,
// POST /miniapp/validate. Expose with a tunnel, set MINIAPP_PUBLIC_URL.
const miniappPort = Number(process.env.MINIAPP_PORT) || 0;
if (miniappPort > 0) {
  const { createServer: createMiniServer } = await import('node:http');
  createMiniServer((req, res) => {
    const url = req.url ?? '/';
    if (req.method === 'GET' && (url === '/miniapp/health' || url.startsWith('/miniapp/health?'))) {
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(miniAppHealth()));
      return;
    }
    if (req.method === 'POST' && (url === '/miniapp/validate' || url.startsWith('/miniapp/validate?'))) {
      let raw = '';
      req.on('data', (chunk) => {
        raw += chunk;
        if (raw.length > 64 * 1024) req.destroy();
      });
      req.on('end', () => {
        try {
          const body = JSON.parse(raw || '{}') as { initData?: unknown };
          const ok =
            typeof body.initData === 'string' && body.initData
              ? validateInitData(body.initData, token)
              : false;
          res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ ok }));
        } catch {
          res.writeHead(400, { 'Content-Type': 'application/json' }).end(JSON.stringify({ ok: false }));
        }
      });
      return;
    }
    if (req.method === 'GET' && url.startsWith('/miniapp/')) {
      if (serveMiniAppGet(url, res)) return;
      res.writeHead(404).end('Not found');
      return;
    }
    res.writeHead(404).end('Not found');
  }).listen(miniappPort, () => {
    const pub = miniappBaseUrl();
    console.log(`[miniapp] standalone server on port ${miniappPort}`);
    if (pub) {
      console.log(`[miniapp] public base: ${pub} (transport=${transportMode})`);
    } else {
      console.log('[miniapp] set MINIAPP_PUBLIC_URL to your tunnel URL to enable web_app buttons (e.g. https://<tunnel>/miniapp/<id>/)');
    }
  });
}

telegram = startTelegram({
  token,
  auth,
  mode: transportMode,
  webhookUrl,
  webhookPort,
  webhookSecret,
  runCommand: (command) => shell.run(command),
  onExternalCommand: async (chatId, text) => {
    const trimmed = text.trim();
    if (trimmed === '/plugin' || trimmed.startsWith('/plugin ')) {
      const parts = trimmed.split(/\s+/);
      const action = (parts[1] ?? '').toLowerCase();
      const target = parts[2] ?? '';
      if (action === 'enable' && target) {
        const ok = plugins.enable(target);
        if (!ok) return t.pluginNotFound(target);
        return t.pluginEnabled(target);
      }
      if (action === 'disable' && target) {
        const ok = plugins.disable(target);
        if (!ok) return t.pluginNotFound(target);
        return t.pluginDisabled(target);
      }
      const list = plugins.listStatus();
      if (list.length === 0) return t.pluginEmpty;
      const lines = [
        t.pluginListHeader,
        ...list.map((p, idx) => `${idx + 1}. ${p.name}${p.verified ? ` (${t.pluginVerified})` : ''} [${p.enabled ? t.pluginStatusEnabled : t.pluginStatusDisabled}]`),
        t.pluginUsage,
      ];
      return lines.join('\n');
    }
    const match = plugins.matchCommand(text);
    if (!match) return null;
    try {
      return await match.command.run(match.args, {
        chatId,
        locale,
        miniapp: miniappHost,
      });
    } catch (err) {
      console.error(`[plugins] command ${text} failed:`, err);
      return t.pluginError((err as Error).message);
    }
  },
  onText: (chatId, text, onPartial, onCommit) => {
    const incoming = plugins.applyIncoming(text, { chatId, locale });
    if (incoming === null) {
      console.log(`[chat ${chatId}] a plugin swallowed the message`);
      return Promise.resolve('');
    }
    return ai.chat(
      String(chatId),
      incoming,
      (t) => onPartial(plugins.applyOutgoing(t, { chatId, locale })),
      onCommit,
    );
  },
  onClear: (chatId) => ai.clear(String(chatId)),
});

const currentConfig = ai.getConfig();
console.log('Angel Lily started. Listening for messages...');
console.log(`Model: ${currentConfig.model}`);
console.log(`Base URL: ${currentConfig.baseURL ?? 'https://api.openai.com/v1'}`);
console.log(`Shell environment: ${shell.describe()}`);
console.log(`Plugins: ${plugins.names.length ? plugins.names.join(', ') : '(none)'}`);
console.log(`Mini Apps: ${miniappBaseUrl() ?? '(no public URL — file fallback mode)'}`);

// Register bot commands with Telegram (built-in + plugin commands)
const builtinCommands = [
  { command: 'start', description: 'Show help' },
  { command: 'clear', description: 'Clear conversation' },
  { command: 'plugin', description: 'Manage plugins' },
];
const allCommands = [...builtinCommands, ...plugins.commandInfos()];
telegram.setMyCommands(allCommands).catch(() => {});
