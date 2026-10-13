import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';

export interface ProviderAccount {
  apiKey: string;
}

export interface ProviderConfig {
  baseURL?: string;
  accounts: Record<string, ProviderAccount>;
  models: string[];
}

export interface GatewayStore {
  activeProvider: string;
  activeAccount: string;
  activeModel: string;
  providers: Record<string, ProviderConfig>;
}

export interface PluginContext {
  chatId: number;
  ai?: {
    setConfig(config: { apiKey?: string; baseURL?: string; model?: string }): void;
    getConfig(): { apiKey: string; baseURL?: string; model: string };
  };
}

function getStorePath(): string {
  return resolve(process.cwd(), '.angellily', 'gateways.json');
}

export function loadStore(initialAi?: { apiKey: string; baseURL?: string; model: string }): GatewayStore {
  const file = getStorePath();
  if (existsSync(file)) {
    try {
      const raw = readFileSync(file, 'utf8').trim();
      if (raw) {
        const data = JSON.parse(raw);
        if (data && data.providers && typeof data.providers === 'object') {
          return data as GatewayStore;
        }
      }
    } catch (err) {
      console.warn('[ai-gateway] could not parse gateways.json, resetting:', err);
    }
  }

  // Fallback to active runtime from bot if available
  const defaultProvider = 'default';
  const defaultAccount = 'default';
  const defaultModel = initialAi?.model ?? 'gpt-4o-mini';
  const defaultApiKey = initialAi?.apiKey ?? '';
  const defaultBaseURL = initialAi?.baseURL;

  const initialStore: GatewayStore = {
    activeProvider: defaultProvider,
    activeAccount: defaultAccount,
    activeModel: defaultModel,
    providers: {
      [defaultProvider]: {
        baseURL: defaultBaseURL,
        accounts: {
          [defaultAccount]: { apiKey: defaultApiKey },
        },
        models: [defaultModel],
      },
    },
  };
  saveStore(initialStore);
  return initialStore;
}

export function saveStore(store: GatewayStore): void {
  const file = getStorePath();
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(store, null, 2), 'utf8');
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export default function createGatewayPlugin() {
  let store: GatewayStore | null = null;

  function ensureStore(ctx: PluginContext): GatewayStore {
    if (!store) {
      const current = ctx.ai?.getConfig();
      store = loadStore(current);
    }
    return store;
  }

  function applyActiveConfig(ctx: PluginContext, s: GatewayStore): void {
    if (!ctx.ai) return;
    const provider = s.providers[s.activeProvider];
    if (!provider) return;
    const account = provider.accounts[s.activeAccount];
    ctx.ai.setConfig({
      apiKey: account ? account.apiKey : undefined,
      baseURL: provider.baseURL,
      model: s.activeModel,
    });
  }

  return {
    name: 'ai-gateway',
    commands: [
      {
        command: 'model',
        description: 'View or switch the AI model within the current provider',
        run: (args: string, ctx: PluginContext) => {
          const s = ensureStore(ctx);
          const currentProvider = s.providers[s.activeProvider];

          if (!currentProvider) {
            return `<b>Error:</b> No config found for provider <code>${escapeHtml(s.activeProvider)}</code>.`;
          }

          const targetModel = args.trim();
          if (!targetModel) {
            const list = currentProvider.models.map((m) => {
              const active = m === s.activeModel ? ' <b>(active)</b>' : '';
              return `• <code>${escapeHtml(m)}</code>${active}`;
            });
            return (
              `<b>Current model:</b> <code>${escapeHtml(s.activeModel)}</code>\n` +
              `<b>Provider:</b> <code>${escapeHtml(s.activeProvider)}</code>\n\n` +
              `<b>Available models:</b>\n` +
              (list.length ? list.join('\n') : '<i>(none)</i>') +
              `\n\n<i>Use <code>/model &lt;name&gt;</code> to switch.</i>`
            );
          }

          // Switch model
          s.activeModel = targetModel;
          if (!currentProvider.models.includes(targetModel)) {
            currentProvider.models.push(targetModel);
          }
          saveStore(s);
          applyActiveConfig(ctx, s);

          return (
            `Switched to model: <code>${escapeHtml(targetModel)}</code>\n` +
            `Provider: <code>${escapeHtml(s.activeProvider)}</code>`
          );
        },
      },
      {
        command: 'gateway',
        description: 'Manage AI Gateway: providers, accounts, add config',
        run: (args: string, ctx: PluginContext) => {
          const s = ensureStore(ctx);
          const parts = args.trim().split(/\s+/).filter(Boolean);
          const sub = parts[0]?.toLowerCase();

          // /gateway providers [name]
          if (sub === 'providers') {
            const targetProvider = parts[1];
            if (!targetProvider) {
              const pNames = Object.keys(s.providers);
              const list = pNames.map((name) => {
                const isCurrent = name === s.activeProvider ? ' <b>(active)</b>' : '';
                const p = s.providers[name];
                const accs = Object.keys(p.accounts).join(', ');
                return `• <code>${escapeHtml(name)}</code>${isCurrent}\n  URL: <code>${escapeHtml(p.baseURL ?? 'default')}</code>\n  Accounts: ${escapeHtml(accs || 'none')}`;
              });

              return (
                `<b>Providers:</b>\n\n` +
                (list.length ? list.join('\n\n') : '<i>No providers configured.</i>') +
                `\n\n<i>Use <code>/gateway providers &lt;name&gt;</code> to switch.</i>`
              );
            }

            // Switch provider
            const target = s.providers[targetProvider];
            if (!target) {
              return `Provider <code>${escapeHtml(targetProvider)}</code> not found. Use <code>/gateway providers</code> to list.`;
            }

            s.activeProvider = targetProvider;
            // Pick first account if current active doesn't exist in target provider
            if (!target.accounts[s.activeAccount]) {
              const firstAcc = Object.keys(target.accounts)[0] ?? 'default';
              s.activeAccount = firstAcc;
            }
            // Pick first model if target provider models available
            if (target.models.length && !target.models.includes(s.activeModel)) {
              s.activeModel = target.models[0];
            }
            saveStore(s);
            applyActiveConfig(ctx, s);

            return (
              `Switched to provider: <code>${escapeHtml(targetProvider)}</code>\n` +
              `• Account: <code>${escapeHtml(s.activeAccount)}</code>\n` +
              `• Model: <code>${escapeHtml(s.activeModel)}</code>`
            );
          }

          // /gateway use <account_name>
          if (sub === 'use') {
            const targetAccount = parts[1];
            if (!targetAccount) {
              const currentProvider = s.providers[s.activeProvider];
              const accs = currentProvider ? Object.keys(currentProvider.accounts) : [];
              const list = accs.map((a) => {
                const active = a === s.activeAccount ? ' <b>(active)</b>' : '';
                return `• <code>${escapeHtml(a)}</code>${active}`;
              });
              return (
                `<b>Accounts in [${escapeHtml(s.activeProvider)}]:</b>\n\n` +
                (list.length ? list.join('\n') : '<i>No accounts.</i>') +
                `\n\n<i>Usage: <code>/gateway use &lt;account&gt;</code></i>`
              );
            }

            const currentProvider = s.providers[s.activeProvider];
            if (!currentProvider || !currentProvider.accounts[targetAccount]) {
              return `Account <code>${escapeHtml(targetAccount)}</code> not found in provider <code>${escapeHtml(s.activeProvider)}</code>.`;
            }

            s.activeAccount = targetAccount;
            saveStore(s);
            applyActiveConfig(ctx, s);

            return `Switched to account: <code>${escapeHtml(targetAccount)}</code> (Provider: <code>${escapeHtml(s.activeProvider)}</code>)`;
          }

          // /gateway add <provider> <baseURL> <account> <apiKey> <model>
          if (sub === 'add') {
            const providerName = parts[1];
            const baseURL = parts[2];
            const accountName = parts[3];
            const apiKey = parts[4];
            const modelName = parts[5];

            if (!providerName || !baseURL || !accountName || !apiKey || !modelName) {
              return (
                `<b>Usage:</b>\n` +
                `<code>/gateway add &lt;provider&gt; &lt;baseURL&gt; &lt;account&gt; &lt;apiKey&gt; &lt;model&gt;</code>\n\n` +
                `<i>Example:</i>\n` +
                `<code>/gateway add groq https://api.groq.com/openai/v1 main gsk_xxxx llama-3.3-70b-versatile</code>`
              );
            }

            if (!s.providers[providerName]) {
              s.providers[providerName] = {
                baseURL: baseURL === 'default' ? undefined : baseURL,
                accounts: {},
                models: [],
              };
            }

            const p = s.providers[providerName];
            p.baseURL = baseURL === 'default' ? undefined : baseURL;
            p.accounts[accountName] = { apiKey };
            if (!p.models.includes(modelName)) {
              p.models.push(modelName);
            }

            saveStore(s);

            return (
              `Saved new config:\n` +
              `• Provider: <code>${escapeHtml(providerName)}</code>\n` +
              `• Account: <code>${escapeHtml(accountName)}</code>\n` +
              `• Model: <code>${escapeHtml(modelName)}</code>\n\n` +
              `Switch now: <code>/gateway providers ${escapeHtml(providerName)}</code>`
            );
          }

          // Default status display & help
          const currentP = s.providers[s.activeProvider];
          return (
            `<b>AI Gateway Status</b>\n\n` +
            `• <b>Provider:</b> <code>${escapeHtml(s.activeProvider)}</code>\n` +
            `• <b>Account:</b> <code>${escapeHtml(s.activeAccount)}</code>\n` +
            `• <b>Model:</b> <code>${escapeHtml(s.activeModel)}</code>\n` +
            `• <b>Base URL:</b> <code>${escapeHtml(currentP?.baseURL ?? 'default')}</code>\n\n` +
            `<b>Commands:</b>\n` +
            `• <code>/model [name]</code> — View or switch model\n` +
            `• <code>/gateway providers [name]</code> — List or switch provider\n` +
            `• <code>/gateway use &lt;account&gt;</code> — Switch account\n` +
            `• <code>/gateway add ...</code> — Add provider / account`
          );
        },
      },
    ],
  };
}
