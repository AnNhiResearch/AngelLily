// Shared Telegram Mini App static hosting (plans A + B).
// Used by the webhook server (telegram.ts, zero extra port) and by the
// standalone server (main.ts MINIAPP_PORT, polling-friendly + tunnel).
// Zero dependencies: node:http/fs/path/crypto only.

import { createHmac } from 'node:crypto';
import { existsSync, readFileSync, statSync, readdirSync } from 'node:fs';
import { join, resolve, normalize } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';

export const MINIAPP_CSP =
  "default-src 'self' https://telegram.org; script-src 'self' 'unsafe-inline' https://telegram.org; style-src 'self' 'unsafe-inline'";

/** Base dir for Mini App static files: .angellily/miniapp/<id>/index.html */
export function miniAppBaseDir(): string {
  return resolve(process.cwd(), '.angellily', 'miniapp');
}

/**
 * Resolve a /miniapp/<id>/... request path to a real file.
 * Returns null on traversal attempts or unknown ids.
 * V1 serves only single-file index.html per app.
 */
export function resolveMiniAppFile(urlPath: string): { file: string; mime: string } | null {
  const clean = urlPath.split('?')[0];
  const m = clean.match(/^\/miniapp\/([A-Za-z0-9_-]{1,64})(?:\/(.*))?$/);
  if (!m) return null;
  const id = m[1];
  let rest = (m[2] ?? '').split('?')[0];
  if (!rest || rest === '/') rest = 'index.html';
  rest = rest.replace(/^\/+/, '');
  if (!/^(index\.html)?$/.test(rest)) return null; // V1: single file only
  const base = miniAppBaseDir();
  const file = normalize(join(base, id, rest));
  const rel = file.slice(base.length);
  if (!file.startsWith(base) || rel.includes('..')) return null;
  try {
    if (!existsSync(file) || !statSync(file).isFile()) return null;
  } catch {
    return null;
  }
  return { file, mime: 'text/html; charset=utf-8' };
}

/** Serve GET /miniapp/<id>/ — returns true when the request was handled. */
export function serveMiniAppGet(reqUrl: string, res: ServerResponse): boolean {
  if (!reqUrl.startsWith('/miniapp/')) return false;
  if (reqUrl === '/miniapp/health' || reqUrl.startsWith('/miniapp/health?')) return false; // handled by caller
  if (reqUrl === '/miniapp/validate' || reqUrl.startsWith('/miniapp/validate')) return false;
  const hit = resolveMiniAppFile(reqUrl);
  if (!hit) {
    res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
    return true;
  }
  try {
    const body = readFileSync(hit.file);
    res
      .writeHead(200, {
        'Content-Type': hit.mime,
        'Content-Security-Policy': MINIAPP_CSP,
        'Cache-Control': 'no-cache',
      })
      .end(body);
  } catch (err) {
    console.error('[miniapp] serve error:', err);
    res.writeHead(500).end('Error');
  }
  return true;
}

/** Health payload for tunnel/load-balancer checks. */
export function miniAppHealth(): { ok: boolean; apps: number } {
  let apps = 0;
  try {
    const base = miniAppBaseDir();
    if (existsSync(base)) {
      for (const name of readdirSync(base)) {
        if (!name.startsWith('.') && existsSync(join(base, name, 'index.html'))) apps++;
      }
    }
  } catch {}
  return { ok: true, apps };
}

/**
 * Validate Telegram WebApp initData (HMAC-SHA256 with bot token).
 * Standard Bot API scheme: secret = HMAC_SHA256(key="WebAppData", msg=token),
 * check = HMAC_SHA256(key=secret, msg=data_check_string).
 * Returns true when hash matches and auth_date is fresh (default 24h).
 */
export function validateInitData(initData: string, botToken: string, maxAgeSec = 86400): boolean {
  try {
    const params = new URLSearchParams(initData);
    const hash = params.get('hash');
    if (!hash) return false;
    params.delete('hash');
    const pairs: string[] = [];
    params.forEach((v, k) => pairs.push(`${k}=${v}`));
    pairs.sort();
    const checkString = pairs.join('\n');
    const secret = createHmac('sha256', 'WebAppData').update(botToken).digest();
    const calc = createHmac('sha256', secret).update(checkString).digest('hex');
    if (calc !== hash) return false;
    const authDate = Number(params.get('auth_date') ?? 0);
    if (authDate && maxAgeSec > 0 && Date.now() / 1000 - authDate > maxAgeSec) return false;
    return true;
  } catch {
    return false;
  }
}

/**
 * Effective public base for Mini Apps, or null when hosting is not configured.
 * Priority: MINIAPP_PUBLIC_URL (tunnel/custom domain) -> origin of
 * TELEGRAM_WEBHOOK_URL -> null (file fallback mode).
 */
export function miniappBaseUrl(): string | null {
  const direct = (process.env.MINIAPP_PUBLIC_URL ?? '').trim().replace(/\/+$/, '');
  if (direct) return `${direct}/miniapp`;
  const hook = (process.env.TELEGRAM_WEBHOOK_URL ?? '').trim();
  if (hook) {
    try {
      // Webhook URL looks like https://host/telegram — apps live at sibling /miniapp
      return `${new URL(hook).origin}/miniapp`;
    } catch {
      return null;
    }
  }
  return null;
}

export function miniappPublicUrl(appId: string): string | null {
  const base = miniappBaseUrl();
  return base ? `${base}/${appId}/` : null;
}

// Re-export http types for callers that only import this module.
export type { IncomingMessage, ServerResponse };
