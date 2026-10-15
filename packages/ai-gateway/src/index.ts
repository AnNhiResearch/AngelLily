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
  locale: string;
  ai?: {
    setConfig(config: { apiKey?: string; baseURL?: string; model?: string }): void;
    getConfig(): { apiKey: string; baseURL?: string; model: string };
  };
}

// --------------- i18n ---------------

const VI = {
  descModel: 'Xem hoặc chuyển model AI trong nhà cung cấp hiện tại',
  descGateway: 'Quản lý AI Gateway: nhà cung cấp, tài khoản, thêm cấu hình',
  errNoProvider: (name: string) => `<b>Lỗi:</b> Không tìm thấy cấu hình cho nhà cung cấp <code>${name}</code>.`,
  currentModel: 'Model hiện tại:',
  provider: 'Nhà cung cấp:',
  availableModels: 'Các model có sẵn:',
  none: '(không có)',
  switchHint: (cmd: string) => `Dùng <code>${cmd}</code> để chuyển.`,
  switchedModel: (model: string) => `Đã chuyển sang model: <code>${model}</code>`,
  providers: 'Nhà cung cấp:',
  noProviders: 'Chưa cấu hình nhà cung cấp nào.',
  active: '(đang dùng)',
  accounts: 'Tài khoản:',
  noAccounts: 'Không có tài khoản.',
  providerNotFound: (name: string) => `Nhà cung cấp <code>${name}</code> không tồn tại. Dùng <code>/gateway providers</code> để xem danh sách.`,
  switchedProvider: (name: string) => `Đã chuyển sang nhà cung cấp: <code>${name}</code>`,
  account: 'Tài khoản:',
  model: 'Model:',
  accountsIn: (provider: string) => `Tài khoản trong [${provider}]:`,
  usage: 'Cách dùng:',
  accountNotFound: (account: string, provider: string) => `Tài khoản <code>${account}</code> không tồn tại trong nhà cung cấp <code>${provider}</code>.`,
  switchedAccount: (account: string, provider: string) => `Đã chuyển sang tài khoản: <code>${account}</code> (Nhà cung cấp: <code>${provider}</code>)`,
  addUsage: 'Cách dùng:',
  example: 'Ví dụ:',
  savedConfig: 'Đã lưu cấu hình mới:',
  switchNow: (name: string) => `Chuyển ngay: <code>/gateway providers ${name}</code>`,
  statusTitle: 'Trạng thái AI Gateway',
  baseURL: 'Base URL:',
  commands: 'Lệnh:',
  cmdModelDesc: 'Xem hoặc chuyển model',
  cmdProvidersDesc: 'Liệt kê hoặc chuyển nhà cung cấp',
  cmdUseDesc: 'Chuyển tài khoản',
  cmdAddDesc: 'Thêm nhà cung cấp / tài khoản',
};

const EN: typeof VI = {
  descModel: 'View or switch the AI model within the current provider',
  descGateway: 'Manage AI Gateway: providers, accounts, add config',
  errNoProvider: (name: string) => `<b>Error:</b> No config found for provider <code>${name}</code>.`,
  currentModel: 'Current model:',
  provider: 'Provider:',
  availableModels: 'Available models:',
  none: '(none)',
  switchHint: (cmd: string) => `Use <code>${cmd}</code> to switch.`,
  switchedModel: (model: string) => `Switched to model: <code>${model}</code>`,
  providers: 'Providers:',
  noProviders: 'No providers configured.',
  active: '(active)',
  accounts: 'Accounts:',
  noAccounts: 'No accounts.',
  providerNotFound: (name: string) => `Provider <code>${name}</code> not found. Use <code>/gateway providers</code> to list.`,
  switchedProvider: (name: string) => `Switched to provider: <code>${name}</code>`,
  account: 'Account:',
  model: 'Model:',
  accountsIn: (provider: string) => `Accounts in [${provider}]:`,
  usage: 'Usage:',
  accountNotFound: (account: string, provider: string) => `Account <code>${account}</code> not found in provider <code>${provider}</code>.`,
  switchedAccount: (account: string, provider: string) => `Switched to account: <code>${account}</code> (Provider: <code>${provider}</code>)`,
  addUsage: 'Usage:',
  example: 'Example:',
  savedConfig: 'Saved new config:',
  switchNow: (name: string) => `Switch now: <code>/gateway providers ${name}</code>`,
  statusTitle: 'AI Gateway Status',
  baseURL: 'Base URL:',
  commands: 'Commands:',
  cmdModelDesc: 'View or switch model',
  cmdProvidersDesc: 'List or switch provider',
  cmdUseDesc: 'Switch account',
  cmdAddDesc: 'Add provider / account',
};

function i18n(locale: string): typeof VI {
  return locale.startsWith('en') ? EN : VI;
}

// --------------- Store ---------------

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

// --------------- Plugin ---------------

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
    description: 'Dynamic AI provider, account, and model gateway for AngelLily',
    init: (ctx: PluginContext) => {
      const s = ensureStore(ctx);
      applyActiveConfig(ctx, s);
      console.log(`[ai-gateway] active: ${s.activeProvider} (account: ${s.activeAccount}, model: ${s.activeModel})`);
    },
    commands: [
      {
        command: 'model',
        description: 'View or switch AI model',
        run: (args: string, ctx: PluginContext) => {
          const L = i18n(ctx.locale);
          const s = ensureStore(ctx);
          const currentProvider = s.providers[s.activeProvider];

          if (!currentProvider) {
            return L.errNoProvider(escapeHtml(s.activeProvider));
          }

          const targetModel = args.trim();
          if (!targetModel) {
            const list = currentProvider.models.map((m) => {
              const tag = m === s.activeModel ? ` <b>${L.active}</b>` : '';
              return `• <code>${escapeHtml(m)}</code>${tag}`;
            });
            return (
              `<b>${L.currentModel}</b> <code>${escapeHtml(s.activeModel)}</code>\n` +
              `<b>${L.provider}</b> <code>${escapeHtml(s.activeProvider)}</code>\n\n` +
              `<b>${L.availableModels}</b>\n` +
              (list.length ? list.join('\n') : `<i>${L.none}</i>`) +
              `\n\n<i>${L.switchHint('/model &lt;name&gt;')}</i>`
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
            `${L.switchedModel(escapeHtml(targetModel))}\n` +
            `${L.provider} <code>${escapeHtml(s.activeProvider)}</code>`
          );
        },
      },
      {
        command: 'gateway',
        description: 'Manage AI Gateway',
        run: (args: string, ctx: PluginContext) => {
          const L = i18n(ctx.locale);
          const s = ensureStore(ctx);
          const parts = args.trim().split(/\s+/).filter(Boolean);
          const sub = parts[0]?.toLowerCase();

          // /gateway providers [name]
          if (sub === 'providers') {
            const targetProvider = parts[1];
            if (!targetProvider) {
              const pNames = Object.keys(s.providers);
              const list = pNames.map((name) => {
                const isCurrent = name === s.activeProvider ? ` <b>${L.active}</b>` : '';
                const p = s.providers[name];
                const accs = Object.keys(p.accounts).join(', ');
                return `• <code>${escapeHtml(name)}</code>${isCurrent}\n  URL: <code>${escapeHtml(p.baseURL ?? 'default')}</code>\n  ${L.accounts} ${escapeHtml(accs || 'none')}`;
              });

              return (
                `<b>${L.providers}</b>\n\n` +
                (list.length ? list.join('\n\n') : `<i>${L.noProviders}</i>`) +
                `\n\n<i>${L.switchHint('/gateway providers &lt;name&gt;')}</i>`
              );
            }

            // Switch provider
            const target = s.providers[targetProvider];
            if (!target) {
              return L.providerNotFound(escapeHtml(targetProvider));
            }

            s.activeProvider = targetProvider;
            if (!target.accounts[s.activeAccount]) {
              const firstAcc = Object.keys(target.accounts)[0] ?? 'default';
              s.activeAccount = firstAcc;
            }
            if (target.models.length && !target.models.includes(s.activeModel)) {
              s.activeModel = target.models[0];
            }
            saveStore(s);
            applyActiveConfig(ctx, s);

            return (
              `${L.switchedProvider(escapeHtml(targetProvider))}\n` +
              `• ${L.account} <code>${escapeHtml(s.activeAccount)}</code>\n` +
              `• ${L.model} <code>${escapeHtml(s.activeModel)}</code>`
            );
          }

          // /gateway use <account_name>
          if (sub === 'use') {
            const targetAccount = parts[1];
            if (!targetAccount) {
              const currentProvider = s.providers[s.activeProvider];
              const accs = currentProvider ? Object.keys(currentProvider.accounts) : [];
              const list = accs.map((a) => {
                const tag = a === s.activeAccount ? ` <b>${L.active}</b>` : '';
                return `• <code>${escapeHtml(a)}</code>${tag}`;
              });
              return (
                `<b>${L.accountsIn(escapeHtml(s.activeProvider))}</b>\n\n` +
                (list.length ? list.join('\n') : `<i>${L.noAccounts}</i>`) +
                `\n\n<i>${L.usage} <code>/gateway use &lt;account&gt;</code></i>`
              );
            }

            const currentProvider = s.providers[s.activeProvider];
            if (!currentProvider || !currentProvider.accounts[targetAccount]) {
              return L.accountNotFound(escapeHtml(targetAccount), escapeHtml(s.activeProvider));
            }

            s.activeAccount = targetAccount;
            saveStore(s);
            applyActiveConfig(ctx, s);

            return L.switchedAccount(escapeHtml(targetAccount), escapeHtml(s.activeProvider));
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
                `<b>${L.addUsage}</b>\n` +
                `<code>/gateway add &lt;provider&gt; &lt;baseURL&gt; &lt;account&gt; &lt;apiKey&gt; &lt;model&gt;</code>\n\n` +
                `<i>${L.example}</i>\n` +
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
              `${L.savedConfig}\n` +
              `• ${L.provider} <code>${escapeHtml(providerName)}</code>\n` +
              `• ${L.account} <code>${escapeHtml(accountName)}</code>\n` +
              `• ${L.model} <code>${escapeHtml(modelName)}</code>\n\n` +
              L.switchNow(escapeHtml(providerName))
            );
          }

          // Default status display & help
          const currentP = s.providers[s.activeProvider];
          return (
            `<b>${L.statusTitle}</b>\n\n` +
            `• <b>${L.provider}</b> <code>${escapeHtml(s.activeProvider)}</code>\n` +
            `• <b>${L.account}</b> <code>${escapeHtml(s.activeAccount)}</code>\n` +
            `• <b>${L.model}</b> <code>${escapeHtml(s.activeModel)}</code>\n` +
            `• <b>${L.baseURL}</b> <code>${escapeHtml(currentP?.baseURL ?? 'default')}</code>\n\n` +
            `<b>${L.commands}</b>\n` +
            `• <code>/model [name]</code> — ${L.cmdModelDesc}\n` +
            `• <code>/gateway providers [name]</code> — ${L.cmdProvidersDesc}\n` +
            `• <code>/gateway use &lt;account&gt;</code> — ${L.cmdUseDesc}\n` +
            `• <code>/gateway add ...</code> — ${L.cmdAddDesc}`
          );
        },
      },
    ],
  };
}
