import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync, readdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { randomBytes } from 'node:crypto';

export interface MiniAppHost {
  /** Public HTTPS URL for the app, or null when hosting is not configured. */
  getPublicUrl(appId: string): string | null;
  /** Send a true web_app open-button to the chat. Falls back to a link when unsupported. */
  sendButton(chatId: number, appId: string, title: string): Promise<void>;
}

export interface PluginContext {
  chatId: number;
  locale: string;
  miniapp?: MiniAppHost;
  ai?: unknown;
}

export interface AppMeta {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  version: number;
}

export const MAX_HTML_BYTES = 200 * 1024;
export const MAX_APPS = 20;

// --------------- i18n ---------------

const VI = {
  descCanvas: 'Tạo Mini App (Canvas) mới từ mô tả hoặc HTML',
  descApps: 'Liệt kê Mini App đã tạo',
  descOpen: 'Mở / gửi lại nút Mini App',
  descDel: 'Xóa Mini App',
  usageCanvas: `<b>Cách dùng:</b>\n<code>/canvas &lt;tiêu đề&gt;</code> — tạo app mẫu\n<code>/canvas &lt;tiêu đề&gt; | &lt;html&gt;</code> — tạo từ HTML dán vào`,
  created: (title: string, id: string) => `Đã tạo Mini App: <b>${title}</b> (<code>${id}</code>)`,
  updated: (title: string, id: string, v: number) => `Đã cập nhật <b>${title}</b> (<code>${id}</code>) lên v${v}`,
  deleted: (id: string) => `Đã xóa Mini App <code>${id}</code>.`,
  notFound: (id: string) => `Không tìm thấy Mini App <code>${id}</code>. Dùng <code>/apps</code> để xem danh sách.`,
  openHint: (url: string) => `<a href="${url}">Mở App</a>`,
  noUrl: `Chưa cấu hình <code>MINIAPP_PUBLIC_URL</code> hoặc <code>TELEGRAM_WEBHOOK_URL</code> — app đã lưu, sẽ gửi dưới dạng file khi có yêu cầu.`,
  empty: `Chưa có Mini App nào. Dùng <code>/canvas &lt;tiêu đề&gt;</code> để tạo.`,
  listTitle: `<b>Mini App đã tạo:</b>`,
  tooBig: (kb: number) => `HTML quá lớn (${kb}KB, tối đa 200KB). Hãy rút gọn.`,
  needHtml: `Thiếu nội dung HTML.`,
  fileFallback: (id: string) => `Mở bằng file: yêu cầu bot gửi file <code>${id}/index.html</code> (chưa có HTTPS public).`,
};

const EN: typeof VI = {
  descCanvas: 'Create a new Mini App (Canvas) from a description or HTML',
  descApps: 'List created Mini Apps',
  descOpen: 'Re-send a Mini App open button',
  descDel: 'Delete a Mini App',
  usageCanvas: `<b>Usage:</b>\n<code>/canvas &lt;title&gt;</code> — create from starter template\n<code>/canvas &lt;title&gt; | &lt;html&gt;</code> — create from pasted HTML`,
  created: (title: string, id: string) => `Mini App created: <b>${title}</b> (<code>${id}</code>)`,
  updated: (title: string, id: string, v: number) => `Updated <b>${title}</b> (<code>${id}</code>) to v${v}`,
  deleted: (id: string) => `Deleted Mini App <code>${id}</code>.`,
  notFound: (id: string) => `Mini App <code>${id}</code> not found. Use <code>/apps</code> to list.`,
  openHint: (url: string) => `<a href="${url}">Open App</a>`,
  noUrl: `Neither <code>MINIAPP_PUBLIC_URL</code> nor <code>TELEGRAM_WEBHOOK_URL</code> is set — app saved, will be sent as a file on request.`,
  empty: `No Mini Apps yet. Use <code>/canvas &lt;title&gt;</code> to create one.`,
  listTitle: `<b>Created Mini Apps:</b>`,
  tooBig: (kb: number) => `HTML too large (${kb}KB, max 200KB). Please slim it down.`,
  needHtml: `Missing HTML content.`,
  fileFallback: (id: string) => `Open via file: ask the bot to send <code>${id}/index.html</code> (no public HTTPS yet).`,
};

function i18n(locale: string): typeof VI {
  return locale.startsWith('en') ? EN : VI;
}

// --------------- Store ---------------

export function getBaseDir(): string {
  return resolve(process.cwd(), '.angellily', 'miniapp');
}

function appDir(id: string): string {
  return join(getBaseDir(), id);
}

function readMeta(id: string): AppMeta | null {
  try {
    const raw = readFileSync(join(appDir(id), 'meta.json'), 'utf8');
    return JSON.parse(raw) as AppMeta;
  } catch {
    return null;
  }
}

function writeMeta(meta: AppMeta): void {
  mkdirSync(appDir(meta.id), { recursive: true });
  writeFileSync(join(appDir(meta.id), 'meta.json'), JSON.stringify(meta, null, 2), 'utf8');
}

export function listApps(): AppMeta[] {
  const base = getBaseDir();
  if (!existsSync(base)) return [];
  const out: AppMeta[] = [];
  for (const name of readdirSync(base)) {
    if (name.startsWith('.')) continue;
    const m = readMeta(name);
    if (m) out.push(m);
  }
  return out.sort((a, b) => b.updatedAt - a.updatedAt);
}

function enforceQuota(): void {
  const apps = listApps();
  if (apps.length < MAX_APPS) return;
  // LRU: drop oldest beyond quota
  for (const old of apps.slice(MAX_APPS - 1)) {
    try {
      rmSync(appDir(old.id), { recursive: true, force: true });
    } catch {}
  }
}

function newId(): string {
  return randomBytes(4).toString('hex');
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function escapeAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

/** Resolve public HTTPS base for Mini Apps (null = no hosting configured). */
export function resolveBaseUrl(): string | null {
  const direct = (process.env.MINIAPP_PUBLIC_URL ?? '').trim().replace(/\/+$/, '');
  if (direct) return `${direct}/miniapp`;
  const hook = (process.env.TELEGRAM_WEBHOOK_URL ?? '').trim();
  if (hook) {
    try {
      // Webhook URL looks like https://host/telegram — apps live at sibling /miniapp
      const u = new URL(hook);
      return `${u.origin}/miniapp`;
    } catch {
      return null;
    }
  }
  return null;
}

export function publicUrlFor(appId: string): string | null {
  const base = resolveBaseUrl();
  return base ? `${base}/${appId}/` : null;
}

/** Wrap a bare snippet into a full single-file Mini App document. */
export function wrapSnippet(title: string, inner: string, appId: string): string {
  const t = escapeHtml(title || 'Mini App');
  return `<!DOCTYPE html>
<html lang="vi">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${t}</title>
<script src="https://telegram.org/js/telegram-web-app.js"></script>
<style>
body{font-family:system-ui,sans-serif;margin:0;padding:16px;background:var(--tg-theme-bg-color,#fff);color:var(--tg-theme-text-color,#222)}
button{background:var(--tg-theme-button-color,#3390ec);color:var(--tg-theme-button-text-color,#fff);border:0;border-radius:8px;padding:10px 16px;font-size:15px}
input,textarea{width:100%;padding:8px;margin:6px 0;box-sizing:border-box}
</style>
</head>
<body>
<h3>${t}</h3>
<div id="app">${inner}</div>
<script>
(function(){
  var tg = window.Telegram && window.Telegram.WebApp;
  if (tg) { try { tg.ready(); tg.expand(); } catch(e){} }
  window.sendToLily = function(data){
    var payload = JSON.stringify({ appId: ${JSON.stringify(appId)}, data: data });
    if (tg) { try { tg.sendData(payload); return; } catch(e){} }
    alert(payload);
  };
})();
</script>
</body>
</html>`;
}

function normalizeHtml(title: string, html: string, appId: string): string {
  const trimmed = html.trim();
  if (/<!doctype html|<html/i.test(trimmed)) return trimmed;
  return wrapSnippet(title, trimmed, appId);
}

function checkSize(html: string): string | null {
  const bytes = Buffer.byteLength(html, 'utf8');
  if (bytes > MAX_HTML_BYTES) return `${Math.round(bytes / 1024)}`;
  return null;
}

export function saveAppHtml(id: string, html: string): void {
  mkdirSync(appDir(id), { recursive: true });
  writeFileSync(join(appDir(id), 'index.html'), html, 'utf8');
}

// --------------- Duplicate guard ---------------
// The LLM sometimes retries miniapp_create for one request; every call used
// to mint a new app AND send a new button (spam). Identical input from the
// same chat within DEDUP_WINDOW_MS reuses the existing app instead.

const DEDUP_WINDOW_MS = 120_000;

function simpleHash(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h.toString(16);
}

interface RecentCreate {
  chatId: number;
  title: string;
  hash: string;
  id: string;
  at: number;
}

const recentCreates: RecentCreate[] = [];

function findDuplicate(chatId: number, title: string, rawHtml: string): AppMeta | null {
  const now = Date.now();
  for (let i = recentCreates.length - 1; i >= 0; i--) {
    if (now - recentCreates[i].at > DEDUP_WINDOW_MS) recentCreates.splice(i, 1);
  }
  const hash = simpleHash(`${title}\n${rawHtml}`);
  const hit = recentCreates.find((r) => r.chatId === chatId && r.title === title && r.hash === hash);
  if (!hit) return null;
  return readMeta(hit.id);
}

function noteCreate(chatId: number, title: string, rawHtml: string, id: string): void {
  recentCreates.push({ chatId, title, hash: simpleHash(`${title}\n${rawHtml}`), id, at: Date.now() });
  if (recentCreates.length > 20) recentCreates.shift();
}

function createApp(title: string, html: string): { meta: AppMeta; html: string } {
  const id = newId();
  const full = html.trim() ? normalizeHtml(title, html, id) : wrapSnippet(title, '<p>Hello from Lily Canvas. Edit me via <code>/canvas</code>.</p><button onclick="sendToLily(\'hello\')">Gửi cho Lily</button>', id);
  const over = checkSize(full);
  if (over) throw new Error(`HTML_TOO_BIG:${over}`);
  enforceQuota();
  const now = Date.now();
  const meta: AppMeta = { id, title, createdAt: now, updatedAt: now, version: 1 };
  saveAppHtml(id, full);
  writeMeta(meta);
  return { meta, html: full };
}

// --------------- Plugin ---------------

export default function createMiniAppsPlugin() {
  function urlLine(appId: string, L: typeof VI): string {
    const url = publicUrlFor(appId);
    if (url) return L.openHint(escapeAttr(url));
    return L.noUrl;
  }

  async function fireButton(ctx: PluginContext, appId: string, title: string): Promise<void> {
    if (!ctx.miniapp) return;
    try {
      await ctx.miniapp.sendButton(ctx.chatId, appId, title);
    } catch (err) {
      console.warn(`[mini-apps] sendButton failed for ${appId}:`, (err as Error).message);
    }
  }

  return {
    name: 'telegram-mini-apps',
    description: 'AI-generated Telegram Mini Apps (Canvas)',
    systemPrompt: [
      'You can create interactive Mini Apps (Canvas) for the user.',
      'When the user asks for a drawing, dashboard, chart, game, form or interactive tool, call <tool name="miniapp_create">{"title":"...","html":"...single-file HTML..."}</tool>.',
      'Rules: output ONE self-contained HTML file (inline CSS/JS, no build step). You may use https://telegram.org/js/telegram-web-app.js and window.sendToLily(data) to send results back (it calls Telegram.WebApp.sendData).',
      'Call miniapp_create at most ONCE per user request. If you already received MINIAPP_CREATED in this conversation, NEVER call miniapp_create again for the same request — use <tool name="miniapp_update">{"id":"...","html":"...full replacement HTML..."}</tool> for any changes.',
      'To iterate, call <tool name="miniapp_update">{"id":"...","html":"...full replacement HTML..."}</tool>. Use <tool name="miniapp_list"> to see existing apps.',
      'Keep HTML under 200KB. Never include secrets, tokens or API keys in the HTML.',
    ].join('\n'),
    commands: [
      {
        command: 'canvas',
        description: 'Create a Mini App (Canvas)',
        run: async (args: string, ctx: PluginContext) => {
          const L = i18n(ctx.locale);
          const raw = args.trim();
          if (!raw) return L.usageCanvas;
          const pipe = raw.indexOf('|');
          const title = (pipe === -1 ? raw : raw.slice(0, pipe)).trim().slice(0, 80) || 'Untitled';
          const html = pipe === -1 ? '' : raw.slice(pipe + 1);
          const dup = findDuplicate(ctx.chatId, title, html);
          if (dup) {
            await fireButton(ctx, dup.id, dup.title);
            return `${L.created(escapeHtml(dup.title), dup.id)}\n${urlLine(dup.id, L)}`;
          }
          try {
            const { meta } = createApp(title, html);
            noteCreate(ctx.chatId, title, html, meta.id);
            await fireButton(ctx, meta.id, meta.title);
            return `${L.created(escapeHtml(meta.title), meta.id)}\n${urlLine(meta.id, L)}`;
          } catch (err) {
            const m = (err as Error).message;
            if (m.startsWith('HTML_TOO_BIG:')) return L.tooBig(Number(m.split(':')[1]));
            throw err;
          }
        },
      },
      {
        command: 'apps',
        description: 'List Mini Apps',
        run: (args: string, ctx: PluginContext) => {
          const L = i18n(ctx.locale);
          void args;
          const apps = listApps();
          if (apps.length === 0) return L.empty;
          const lines = apps.map((a) => {
            const url = publicUrlFor(a.id);
            const open = url ? ` — <a href="${escapeAttr(url)}">mở</a>` : '';
            return `• <b>${escapeHtml(a.title)}</b> <code>${a.id}</code> v${a.version}${open}\n  <code>/canvas_open ${a.id}</code> · <code>/canvas_del ${a.id}</code>`;
          });
          return `${L.listTitle}\n\n${lines.join('\n\n')}`;
        },
      },
      {
        command: 'canvas_open',
        description: 'Re-send a Mini App open button',
        run: async (args: string, ctx: PluginContext) => {
          const L = i18n(ctx.locale);
          const id = args.trim().split(/\s+/)[0] ?? '';
          const meta = id ? readMeta(id) : null;
          if (!meta) return L.notFound(escapeHtml(id || ''));
          await fireButton(ctx, meta.id, meta.title);
          return `${escapeHtml(meta.title)} (<code>${meta.id}</code>)\n${urlLine(meta.id, L)}`;
        },
      },
      {
        command: 'canvas_del',
        description: 'Delete a Mini App',
        run: (args: string, ctx: PluginContext) => {
          const L = i18n(ctx.locale);
          const id = args.trim().split(/\s+/)[0] ?? '';
          const meta = id ? readMeta(id) : null;
          if (!meta) return L.notFound(escapeHtml(id || ''));
          try {
            rmSync(appDir(id), { recursive: true, force: true });
          } catch {}
          return L.deleted(escapeHtml(id));
        },
      },
    ],
    tools: [
      {
        name: 'miniapp_create',
        description: 'Create a Mini App from single-file HTML. Input JSON: {"title":"...","html":"..."}. Returns app id and open URL. Call at most ONCE per user request; use miniapp_update for changes.',
        run: async (input: string, ctx: PluginContext) => {
          let title = 'Untitled';
          let html = '';
          try {
            const p = JSON.parse(input) as { title?: unknown; html?: unknown };
            if (typeof p.title === 'string' && p.title.trim()) title = p.title.trim().slice(0, 80);
            if (typeof p.html === 'string') html = p.html;
          } catch {
            // Lenient: treat raw input as HTML with default title
            html = input;
          }
          if (!html.trim()) {
            const L = i18n(ctx.locale);
            return L.needHtml;
          }
          const dup = findDuplicate(ctx.chatId, title, html);
          if (dup) {
            return `MINIAPP_DUPLICATE id=${dup.id} title=${dup.title} — this exact app was already created moments ago and its open button was ALREADY SENT. DO NOT call miniapp_create again. If the user wants changes, call miniapp_update with id=${dup.id}.`;
          }
          try {
            const { meta } = createApp(title, html);
            noteCreate(ctx.chatId, title, html, meta.id);
            await fireButton(ctx, meta.id, meta.title);
            const url = publicUrlFor(meta.id);
            return `MINIAPP_CREATED id=${meta.id} title=${meta.title} v1 url=${url ?? '(no public HTTPS yet — app saved, send as file)'}. The open button was ALREADY SENT to the user. DO NOT call miniapp_create again for this request. If the user wants changes, call miniapp_update with id=${meta.id}.`;
          } catch (err) {
            const m = (err as Error).message;
            if (m.startsWith('HTML_TOO_BIG:')) return `HTML too large (${m.split(':')[1]}KB, max 200KB). Slim it down.`;
            throw err;
          }
        },
      },
      {
        name: 'miniapp_update',
        description: 'Replace a Mini App HTML. Input JSON: {"id":"...","html":"...full HTML...","title":"optional"}.',
        run: async (input: string, ctx: PluginContext) => {
          let p: { id?: unknown; html?: unknown; title?: unknown };
          try {
            p = JSON.parse(input) as typeof p;
          } catch {
            return 'Invalid JSON. Expected {"id":"...","html":"...","title":"optional"}.';
          }
          const id = typeof p.id === 'string' ? p.id.trim() : '';
          const html = typeof p.html === 'string' ? p.html : '';
          const meta = id ? readMeta(id) : null;
          if (!meta) return `Unknown app id "${id}". Use miniapp_list first.`;
          if (!html.trim()) {
            const L = i18n(ctx.locale);
            return L.needHtml;
          }
          const full = normalizeHtml(
            typeof p.title === 'string' && p.title.trim() ? p.title.trim().slice(0, 80) : meta.title,
            html,
            id,
          );
          const over = checkSize(full);
          if (over) return `HTML too large (${over}KB, max 200KB). Slim it down.`;
          if (typeof p.title === 'string' && p.title.trim()) meta.title = p.title.trim().slice(0, 80);
          meta.updatedAt = Date.now();
          meta.version += 1;
          saveAppHtml(id, full);
          writeMeta(meta);
          await fireButton(ctx, meta.id, meta.title);
          const url = publicUrlFor(meta.id);
          return `MINIAPP_UPDATED id=${meta.id} v${meta.version} url=${url ?? '(no public HTTPS yet)'}`;
        },
      },
      {
        name: 'miniapp_list',
        description: 'List created Mini Apps (id, title, version).',
        run: () => {
          const apps = listApps();
          if (apps.length === 0) return '(no mini apps)';
          return apps.map((a) => `- ${a.id}: ${a.title} (v${a.version})`).join('\n');
        },
      },
    ],
  };
}
