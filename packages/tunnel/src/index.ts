import { spawn, type ChildProcess } from 'node:child_process';

export interface PluginContext {
  chatId: number;
  locale: string;
}

type Provider = 'off' | 'localhost.run' | 'serveo';

interface ProviderSpec {
  host: string;
  domain: string;
}

const PROVIDERS: Record<Exclude<Provider, 'off'>, ProviderSpec> = {
  'localhost.run': { host: 'nokey@localhost.run', domain: 'localhost.run' },
  serveo: { host: 'serveo.net', domain: 'serveo.net' },
};

// --------------- i18n ---------------

const VI = {
  descTunnel: 'Xem trạng thái SSH tunnel (URL công khai cho Mini App)',
  disabled: `SSH tunnel đang <b>TẮT</b>.\nBật bằng cách set <code>TUNNEL_PROVIDER=localhost.run</code> hoặc <code>TUNNEL_PROVIDER=serveo</code> trong .env rồi restart bot.`,
  noPort: `Chưa set <code>MINIAPP_PORT</code> (polling mode) nên tunnel không biết forward port nào.\nThêm <code>MINIAPP_PORT=3001</code> vào .env rồi restart bot.`,
  noSsh: `Không tìm thấy lệnh <code>ssh</code> trên máy. Cài OpenSSH rồi restart bot, hoặc tắt tunnel bằng <code>TUNNEL_PROVIDER=off</code>.`,
  statusTitle: `<b>SSH Tunnel</b>`,
  provider: 'Provider:',
  mode: 'Chế độ:',
  modeWebhook: 'webhook + miniapp (1 tunnel)',
  modeMiniapp: 'miniapp (polling)',
  target: 'Forward tới:',
  url: 'URL công khai:',
  waiting: 'đang chờ ssh cấp URL…',
  uptime: 'Uptime:',
  restarts: 'Số lần nối lại:',
  noteRestart: 'Ghi chú: URL đổi mỗi lần nối lại — tin nhắn Mini App cũ sẽ gãy, dùng <code>/canvas_open &lt;id&gt;</code> gửi lại nút.',
};

const EN: typeof VI = {
  descTunnel: 'Show SSH tunnel status (public URL for Mini Apps)',
  disabled: `SSH tunnel is <b>OFF</b>.\nEnable with <code>TUNNEL_PROVIDER=localhost.run</code> or <code>TUNNEL_PROVIDER=serveo</code> in .env, then restart the bot.`,
  noPort: `No <code>MINIAPP_PORT</code> set (polling mode), so the tunnel has no local port to forward.\nAdd <code>MINIAPP_PORT=3001</code> to .env, then restart the bot.`,
  noSsh: `No <code>ssh</code> command found on this machine. Install OpenSSH and restart, or disable with <code>TUNNEL_PROVIDER=off</code>.`,
  statusTitle: `<b>SSH Tunnel</b>`,
  provider: 'Provider:',
  mode: 'Mode:',
  modeWebhook: 'webhook + miniapp (one tunnel)',
  modeMiniapp: 'miniapp (polling)',
  target: 'Forwarding to:',
  url: 'Public URL:',
  waiting: 'waiting for ssh to assign a URL…',
  uptime: 'Uptime:',
  restarts: 'Reconnects:',
  noteRestart: 'Note: the URL changes on every reconnect — old Mini App messages break; use <code>/canvas_open &lt;id&gt;</code> to re-send.',
};

function i18n(locale: string): typeof VI {
  return locale.startsWith('en') ? EN : VI;
}

// --------------- Tunnel state ---------------

interface TunnelState {
  provider: Provider;
  port: number;
  webhookMode: boolean;
  url: string | null;
  child: ChildProcess | null;
  startedAt: number;
  restarts: number;
  failed: boolean;
  failReason: 'noport' | 'nossh' | null;
}

const state: TunnelState = {
  provider: 'off',
  port: 0,
  webhookMode: false,
  url: null,
  child: null,
  startedAt: 0,
  restarts: 0,
  failed: false,
  failReason: null,
};

function readProvider(): Provider {
  const p = (process.env.TUNNEL_PROVIDER ?? 'off').trim().toLowerCase();
  return p === 'localhost.run' || p === 'serveo' ? p : 'off';
}

/**
 * Ordered URL matchers per provider (first hit wins).
 * localhost.run without a key assigns *.lhr.life (the "tunneled with tls
 * termination" line) — NOT *.localhost.run. The banner also contains
 * https://admin.localhost.run and https://localhost.run/docs links which
 * must never be picked, hence the explicit admin exclusion.
 */
const URL_MATCHERS: Record<Exclude<Provider, 'off'>, RegExp[]> = {
  'localhost.run': [
    /https:\/\/[A-Za-z0-9-]+\.lhr\.life/i,
    /https:\/\/(?!admin\.)[A-Za-z0-9-]+\.localhost\.run/i,
  ],
  serveo: [
    /Forwarding HTTP traffic from\s+(https:\/\/\S+)/i,
    /https:\/\/[A-Za-z0-9-]+\.serveo\.net/i,
  ],
};

function extractUrl(text: string, provider: Exclude<Provider, 'off'>): string | null {
  for (const re of URL_MATCHERS[provider]) {
    const m = text.match(re);
    if (m) return (m[1] ?? m[0]).replace(/\/+$/, '').replace(/[).,;]+$/, '');
  }
  return null;
}

/**
 * Fill public URLs from the assigned tunnel URL.
 * Only fills EMPTY values — never overrides explicit user config.
 * MINIAPP_PUBLIC_URL takes effect immediately (read per call by the host);
 * TELEGRAM_WEBHOOK_URL is read by the host right after plugin init, so on
 * first boot the webhook also picks it up when we wait for the URL.
 */
function fillEnv(url: string): void {
  if (!process.env.MINIAPP_PUBLIC_URL?.trim()) {
    process.env.MINIAPP_PUBLIC_URL = url;
    console.log(`[tunnel] MINIAPP_PUBLIC_URL=${url} (auto)`);
  }
  if (state.webhookMode && !process.env.TELEGRAM_WEBHOOK_URL?.trim()) {
    process.env.TELEGRAM_WEBHOOK_URL = url;
    console.log(`[tunnel] TELEGRAM_WEBHOOK_URL=${url} (auto)`);
  }
}

function launch(tag: string): void {
  if (state.failed || state.provider === 'off') return;
  const spec = PROVIDERS[state.provider as Exclude<Provider, 'off'>];
  const sshBin = (process.env.TUNNEL_SSH_BIN ?? 'ssh').trim() || 'ssh';
  const sub = (process.env.TUNNEL_SUBDOMAIN ?? '').trim();
  const remote = sub ? `${sub}:80:localhost:${state.port}` : `80:localhost:${state.port}`;
  // NOTE: no "-N" on purpose. localhost.run only delivers the assigned-domain
  // line ("*.lhr.life tunneled with tls termination") inside a shell session;
  // with -N (no remote command) the banner arrives but the URL never does.
  const args = [
    '-o',
    'StrictHostKeyChecking=no',
    '-o',
    'ServerAliveInterval=30',
    '-o',
    'ServerAliveCountMax=3',
    '-R',
    remote,
    spec.host,
  ];
  console.log(`[tunnel] ${tag}: ${sshBin} -R ${remote} ${spec.host}`);

  let child: ChildProcess;
  try {
    child = spawn(sshBin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (err) {
    console.warn(`[tunnel] cannot spawn "${sshBin}": ${(err as Error).message}`);
    state.failed = true;
    state.failReason = 'nossh';
    return;
  }
  state.child = child;
  if (!state.startedAt) state.startedAt = Date.now();

  // Best-effort cleanup: don't leave orphaned ssh behind on restart/Ctrl+C
  // (orphans hold tunnel slots and can get the IP throttled).
  if (!(globalThis as Record<symbol, unknown>)[Symbol.for('angellily.tunnel.cleanup')]) {
    (globalThis as Record<symbol, unknown>)[Symbol.for('angellily.tunnel.cleanup')] = true;
    const kill = () => {
      try {
        state.child?.kill();
      } catch {}
    };
    process.once('SIGINT', () => {
      kill();
      process.exit(130);
    });
    process.once('SIGTERM', () => {
      kill();
      process.exit(143);
    });
    process.once('exit', kill);
  }

  // Nudge after 30s of silence so users aren't staring at a stuck banner.
  const nag = setTimeout(() => {
    if (!state.url && !state.failed && state.child) {
      console.warn(
        '[tunnel] still waiting for a public URL after 30s — the provider may be throttling this IP. ' +
          'Kill leftover ssh processes and retry, try TUNNEL_PROVIDER=serveo, or get a free localhost.run key for faster allocation.',
      );
    }
  }, 30000);
  nag.unref?.();

  const provider = state.provider as Exclude<Provider, 'off'>;
  const sniff = (chunk: unknown) => {
    const text = String(chunk);
    // Keep logs readable: only the interesting lines.
    for (const line of text.split('\n')) {
      const t = line.trim();
      if (t && /forward|https?:|authenticated|allocat|tunneled/i.test(t)) {
        console.log(`[tunnel][${state.provider}] ${t.slice(0, 200)}`);
      }
    }
    if (!state.url) {
      const found = extractUrl(text, provider);
      if (found) {
        state.url = found;
        console.log(`[tunnel] public URL assigned: ${state.url}`);
        fillEnv(state.url);
      }
    }
  };
  child.stdout?.on('data', sniff);
  child.stderr?.on('data', sniff);

  child.on('error', (err) => {
    const msg = (err as Error).message;
    if (/ENOENT/i.test(msg)) {
      console.warn(
        `[tunnel] "${sshBin}" not found — install an SSH client or unset TUNNEL_PROVIDER. Tunnel disabled.`,
      );
      state.failed = true;
      state.failReason = 'nossh';
      try {
        child.kill();
      } catch {}
      return;
    }
    console.warn(`[tunnel] ssh error: ${msg}`);
  });

  child.on('exit', (code) => {
    state.child = null;
    if (state.failed) return;
    state.restarts += 1;
    const delay = Math.min(5000 * 2 ** Math.min(state.restarts - 1, 3), 30000);
    console.warn(`[tunnel] ssh exited (code ${code}), reconnecting in ${delay / 1000}s… (attempt ${state.restarts})`);
    setTimeout(() => {
      state.url = null; // a reconnect gets a fresh domain
      launch('reconnect');
    }, delay);
  });
}

function waitForUrl(timeoutMs: number): Promise<void> {
  if (state.url) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      clearInterval(tick);
      resolve();
    }, timeoutMs);
    const tick = setInterval(() => {
      if (state.url || state.failed) {
        clearTimeout(timer);
        clearInterval(tick);
        resolve();
      }
    }, 250);
    timer.unref?.();
    tick.unref?.();
  });
}

// --------------- Plugin ---------------

export default function createTunnelPlugin() {
  return {
    name: 'tunnel',
    description: 'Zero-config public URL for Mini Apps (and webhook) via SSH tunnel',
    init: async () => {
      const provider = readProvider();
      state.provider = provider;
      if (provider === 'off') {
        console.log('[tunnel] disabled (set TUNNEL_PROVIDER=localhost.run or serveo to enable)');
        return;
      }
      const transport = (process.env.TELEGRAM_TRANSPORT ?? '').trim().toLowerCase();
      const webhookMode = transport === 'webhook';
      const port = webhookMode
        ? Number(process.env.TELEGRAM_WEBHOOK_PORT) || 3000
        : Number(process.env.MINIAPP_PORT) || 0;
      if (!webhookMode && !port) {
        console.warn('[tunnel] polling mode needs MINIAPP_PORT (e.g. 3001). Tunnel disabled.');
        state.failed = true;
        state.failReason = 'noport';
        return;
      }
      state.port = port;
      state.webhookMode = webhookMode;
      launch('start');

      // Webhook mode needs the URL BEFORE the host registers setWebhook
      // (host reads TELEGRAM_WEBHOOK_URL right after plugin init).
      // Polling mode needs nothing — buttons pick up the URL when it arrives.
      const explicitHook = (process.env.TELEGRAM_WEBHOOK_URL ?? '').trim();
      if (webhookMode && !explicitHook) {
        const timeout = Number(process.env.TUNNEL_TIMEOUT_MS) || 45000;
        await waitForUrl(timeout);
        if (!state.url) {
          console.warn('[tunnel] no URL assigned in time — starting without tunnel URL (webhook may fail, miniapp falls back to file).');
        }
      }
    },
    commands: [
      {
        command: 'tunnel',
        description: 'SSH tunnel status',
        run: (args: string, ctx: PluginContext) => {
          const L = i18n(ctx.locale);
          void args;
          if (state.provider === 'off' || state.failed) {
            if (state.provider === 'off') return L.disabled;
            return state.failReason === 'nossh' ? L.noSsh : L.noPort;
          }
          const up = state.startedAt ? Math.max(0, Math.round((Date.now() - state.startedAt) / 1000)) : 0;
          const ago = up < 60 ? `${up}s` : `${Math.floor(up / 60)}m ${up % 60}s`;
          return (
            `${L.statusTitle}\n` +
            `• ${L.provider} <code>${state.provider}</code>\n` +
            `• ${L.mode} ${state.webhookMode ? L.modeWebhook : L.modeMiniapp}\n` +
            `• ${L.target} <code>localhost:${state.port}</code>\n` +
            `• ${L.url} ${state.url ? `<code>${state.url}</code>` : `<i>${L.waiting}</i>`}\n` +
            `• ${L.uptime} ${ago} · ${L.restarts} ${state.restarts}\n\n` +
            `<i>${L.noteRestart}</i>`
          );
        },
      },
    ],
  };
}
