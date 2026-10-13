// Raw Telegram Bot API over fetch — zero dependencies (Node 18+).
import type { Auth } from './auth.js';
import { t } from './i18n.js';

const TG_LIMIT = 4096;
const POLL_TIMEOUT = 25; // long polling timeout, seconds
const RETRY_DELAY = 3000; // ms before retrying after a poll failure
const UPDATE_INTERVAL = 5000; // live-edit interval while the LLM is writing
const TYPING_INTERVAL = 3500; // Telegram typing indicator expires at ~5s; refresh every ~3.5s to ensure continuous status
// When the live preview reaches this size it is committed as a permanent
// message and a new preview message continues, until the answer is done.
const CLOSE_AT = 4000;

// Only cut messages at natural boundaries, never mid-word.
const BREAK_CHARS = ['\n', '.', '!', '?', ';', ':', ','];

export interface TelegramOptions {
  token: string;
  /** Owner verification gate. Only the verified owner reaches onText. */
  auth: Auth;
  /**
   * Called for every plain text message (not a command).
   * onPartial receives the accumulated reply while the LLM is still writing,
   * for live previews. onCommit is awaited by the AI right before a shell
   * command is approved; it must finalize the current preview so the next
   * part of the answer opens as a new message below the command result.
   * The resolved value is the final reply.
   */
  onText: (
    chatId: number,
    text: string,
    onPartial: (accumulated: string) => void,
    onCommit: () => Promise<void>,
  ) => Promise<string>;
  /** Called on /clear. Optional. */
  onClear?: (chatId: number) => void;
  /**
   * Plugin commands. Called for owner messages starting with / or # before
   * the unknown-command fallback; return the reply text (HTML allowed) or
   * null to let the message continue (AI or the unknown-command help).
   */
  onExternalCommand?: (chatId: number, text: string) => Promise<string | null>;
  /** Runs an already-approved shell command (wired to shell.run in main). */
  runCommand?: (command: string) => Promise<{ ok: boolean; output: string }>;
}

export interface CommandApproval {
  approved: boolean;
  output: string;
}

export interface TelegramClient {
  stop(): void;
  /**
   * Ask the owner to approve via the inline keyboard, then run `execute`
   * (defaults to the configured shell runner when omitted).
   */
  requestApproval(
    chatId: number,
    command: string,
    execute?: (command: string) => Promise<{ ok: boolean; output: string }>,
  ): Promise<CommandApproval>;
}

interface TgChat {
  id: number;
}

interface TgMessage {
  message_id: number;
  text?: string;
  chat: TgChat;
}

interface TgCallbackQuery {
  id: string;
  data?: string;
  message?: TgMessage;
}

interface TgUpdate {
  update_id: number;
  message?: TgMessage;
  callback_query?: TgCallbackQuery;
}

interface TgResponse<T> {
  ok: boolean;
  result?: T;
  description?: string;
  parameters?: { retry_after?: number };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function api(token: string, method: string, params?: Record<string, string>): string {
  const base = `https://api.telegram.org/bot${token}/${method}`;
  return params ? `${base}?${new URLSearchParams(params)}` : base;
}

function helpText(chatId: number): string {
  return t.help(chatId);
}

// Find the best cut position <= limit: last break char (newline, punctuation),
// else last space, else a hard cut.
function splitPoint(text: string, limit: number): number {
  if (text.length <= limit) return text.length;
  const window = text.slice(0, limit + 1);
  for (const ch of BREAK_CHARS) {
    const idx = window.lastIndexOf(ch);
    if (idx > 0) return idx + 1; // keep the break char at the end of the chunk
  }
  const sp = window.lastIndexOf(' ');
  if (sp > 0) return sp + 1;
  return limit;
}

function splitForTelegram(text: string): string[] {
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > TG_LIMIT) {
    const cut = splitPoint(rest, TG_LIMIT);
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  if (rest) chunks.push(rest);
  return chunks;
}

function friendlyError(err: unknown): string {
  const e = err as { status?: number; code?: string };
  if (e?.status === 401) return t.errAuth;
  if (e?.status === 429) return t.errRate;
  if (e?.code === 'ENOTFOUND') return t.errConn;
  return t.errGeneric;
}

// ---------- Bot API calls ----------

async function callApi<T>(
  token: string,
  method: string,
  params: Record<string, string> | undefined,
  init?: RequestInit,
): Promise<T> {
  const res = await fetch(api(token, method, params), init);
  const data = (await res.json()) as TgResponse<T>;
  if (!data.ok || data.result === undefined) {
    const err = new Error(`Telegram ${method} failed: ${data.description ?? res.status}`);
    (err as { status?: number }).status = res.status;
    (err as { retryAfter?: number }).retryAfter = data.parameters?.retry_after;
    throw err;
  }
  return data.result;
}

// POST with one automatic retry honoring Telegram's 429 retry_after.
async function post<T>(token: string, method: string, body: unknown): Promise<T> {
  const init: RequestInit = {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
  try {
    return await callApi<T>(token, method, undefined, init);
  } catch (err) {
    const retryAfter = (err as { retryAfter?: number }).retryAfter;
    if (!retryAfter) throw err;
    await sleep(retryAfter * 1000);
    return callApi<T>(token, method, undefined, init);
  }
}

function sendChatAction(token: string, chatId: number): Promise<void> {
  return post(token, 'sendChatAction', { chat_id: chatId, action: 'typing' }).then(() => undefined);
}

async function send(token: string, chatId: number, text: string, parseMode?: 'HTML'): Promise<void> {
  for (const chunk of splitForTelegram(text)) {
    await postText(token, 'sendMessage', { chat_id: chatId }, chunk, parseMode);
  }
}

// Send/edit text with an optional HTML parse mode. The LLM is instructed to
// write Telegram HTML directly; if it still slips (e.g. a raw < in code) and
// Telegram rejects the entities, the original text is resent as plain.
async function postText<T>(
  token: string,
  method: string,
  base: Record<string, unknown>,
  text: string,
  parseMode?: 'HTML',
): Promise<T> {
  const body: Record<string, unknown> = { ...base, text };
  if (parseMode) body.parse_mode = parseMode;
  try {
    return await post<T>(token, method, body);
  } catch (err) {
    if (!parseMode || !/can't parse entities/i.test(String(err))) throw err;
    return post<T>(token, method, { ...base, text });
  }
}

// Send one message, return its id for later edits.
function sendOnce(token: string, chatId: number, text: string, parseMode?: 'HTML'): Promise<number> {
  return postText<TgMessage>(token, 'sendMessage', { chat_id: chatId }, text, parseMode)
    .then((m) => m.message_id);
}

function editText(
  token: string,
  chatId: number,
  messageId: number,
  text: string,
  parseMode?: 'HTML',
): Promise<void> {
  return postText(
    token,
    'editMessageText',
    { chat_id: chatId, message_id: messageId },
    text,
    parseMode,
  ).then(() => undefined);
}

// ---------- Long polling loop ----------

export function startTelegram(opts: TelegramOptions): TelegramClient {
  const { token } = opts;
  let running = true;
  let controller: AbortController | null = null;

  async function sendSafe(chatId: number, text: string, parseMode: 'HTML' = 'HTML'): Promise<void> {
    try {
      await send(token, chatId, text, parseMode);
    } catch (err) {
      console.error(`[telegram] sendSafe failed for chat ${chatId}:`, err);
    }
  }

  // Gate: only the verified owner (or the /verify flow) gets a response.
  async function handleMessage(msg: TgMessage): Promise<void> {
    const chatId = msg.chat.id;
    const text = msg.text;
    if (!text) return;
    const { auth } = opts;

    if (auth.isBlacklisted(chatId)) {
      console.log(`[telegram] ignored message from blacklisted chat ${chatId}`);
      return;
    }

    if (auth.isOwner(chatId)) {
      await handleOwnerMessage(chatId, text);
      return;
    }

    if (text === '/verify') {
      if (auth.hasOwner()) {
        console.log(`[auth] denied /verify from chat ${chatId} (owner already exists)`);
        await sendSafe(chatId, t.alreadyOwned);
        return;
      }
      console.log(`[auth] /verify requested by chat ${chatId}`);
      auth.startVerification(chatId);
      await sendSafe(chatId, t.otpSent);
      return;
    }

    if (auth.isPending(chatId)) {
      console.log(`[auth] code received from chat ${chatId}`);
      // Every message after /verify is treated as the verification code.
      const result = auth.checkCode(chatId, text);
      if (result.status === 'ok') {
        await sendSafe(chatId, t.verifyOk);
      } else if (result.status === 'expired') {
        await sendSafe(chatId, t.verifyExpired);
      } else if (result.status === 'blocked') {
        await sendSafe(chatId, t.verifyBlocked);
      } else {
        await sendSafe(chatId, t.verifyWrong(result.attemptsLeft ?? 0));
      }
      return;
    }

    console.log(`[auth] unverified chat ${chatId} prompted to /verify`);
    await sendSafe(chatId, t.needVerify);
  }

  async function handleOwnerMessage(chatId: number, text: string): Promise<void> {
    if (text === '/start') {
      console.log(`[cmd] /start from chat ${chatId}`);
      await sendSafe(chatId, helpText(chatId));
      return;
    }
    if (text === '/clear') {
      console.log(`[cmd] /clear from chat ${chatId}`);
      opts.onClear?.(chatId);
      await sendSafe(chatId, t.cleared);
      return;
    }
    // Plugin commands (registered via the plugin system) get a chance before
    // the unknown-command fallback; they may use either a / or # prefix.
    if (opts.onExternalCommand) {
      const reply = await opts.onExternalCommand(chatId, text);
      if (reply !== null) {
        console.log(`[cmd] plugin command "${text}" from chat ${chatId}`);
        if (reply.trim()) await sendSafe(chatId, reply);
        return;
      }
    }
    if (text.startsWith('/')) {
      console.log(`[cmd] unknown command "${text}" from chat ${chatId}`);
      await sendSafe(chatId, helpText(chatId));
      return;
    }

    console.log(`[chat ${chatId}] user: ${text}`);

    // --- Streaming reply with a rolling live preview ---
    let acc = '';          // accumulated answer (grows as the LLM streams)
    let shown = '';        // text currently displayed in the live message
    let committedLen = 0;  // chars of acc already in permanent messages
    let liveId: number | null = null; // current preview message id
    let done = false;
    let newRound = false;  // next onPartial starts a fresh segment

    const onPartial = (s: string) => {
      if (newRound) {
        committedLen = 0; // after a commit the next text is a new segment
        newRound = false;
      }
      acc = s;
    };

    // Immediately trigger typing indicator, then keep alive until the answer is done.
    sendChatAction(token, chatId).catch(() => {});
    const typer = (async () => {
      while (!done) {
        await sleep(TYPING_INTERVAL);
        if (done) break;
        await sendChatAction(token, chatId).catch(() => {});
      }
    })();

    // Serialized publish: updates never overlap (the final flush waits for
    // any in-flight tick instead of racing it).
    let chain: Promise<void> = Promise.resolve();
    const publish = (): Promise<void> => {
      const next = chain.then(async () => {
        // Commit any pending text that filled up: edit the live preview into
        // a permanent message, then keep going in a new preview message.
        let pending = acc.slice(committedLen);
        while (pending.length >= CLOSE_AT) {
          const cut = splitPoint(pending, TG_LIMIT);
          const part = pending.slice(0, cut);
          try {
            if (liveId !== null) {
              await editText(token, chatId, liveId, part, 'HTML');
              liveId = null;
            } else {
              await sendOnce(token, chatId, part, 'HTML');
            }
          } catch (err) {
            console.error('[telegram] commit error:', err);
          }
          committedLen += cut;
          shown = '';
          pending = acc.slice(committedLen);
        }
        // Update or open the live preview with what remains.
        if (pending && pending !== shown) {
          try {
            if (liveId === null) {
              liveId = await sendOnce(token, chatId, pending, 'HTML');
              // Sending a message automatically clears Telegram typing indicator; renew it if still streaming.
              if (!done) sendChatAction(token, chatId).catch(() => {});
            } else {
              await editText(token, chatId, liveId, pending, 'HTML');
            }
            shown = pending;
          } catch (err) {
            console.error('[telegram] live update error:', err);
          }
        }
      });
      chain = next.catch(() => {});
      return next;
    };

    const updater = (async () => {
      while (!done) {
        await sleep(UPDATE_INTERVAL);
        if (done) break;
        await publish();
      }
    })();

    // Called by the AI right before it asks the user to approve a command:
    // display the current text and turn the preview into a permanent message,
    // so the next round opens as a new message below the command result.
    const finalizePreview = (): Promise<void> => {
      const next = chain.then(async () => {
        if (acc && acc !== shown) {
          if (liveId === null) {
            liveId = await sendOnce(token, chatId, acc, 'HTML');
          } else {
            await editText(token, chatId, liveId, acc, 'HTML');
          }
          shown = acc;
        }
        // The preview message now stays as-is; the next round opens a new one.
        liveId = null;
        shown = '';
        committedLen = acc.length;
        newRound = true;
      });
      chain = next.catch(() => {});
      return next;
    };

    try {
      const reply = await opts.onText(chatId, text, onPartial, finalizePreview);
      console.log(`[chat ${chatId}] lily: ${reply}`);
      await publish(); // flush the tail of the final round
    } catch (err) {
      console.error('[telegram] error:', err);
      await sendSafe(chatId, friendlyError(err));
    } finally {
      done = true;
    }
  }

  // ---------- Shell command approval (inline keyboard) ----------

  const APPROVAL_TIMEOUT = 120_000; // ms to wait for Chạy/Hủy decision
  // message id -> resolve with the callback_data that was pressed
  const waiters = new Map<number, (data: string) => void>();

  // Answer the callback so the button stops showing a loading spinner.
  function answerCallback(cb: TgCallbackQuery): void {
    post(token, 'answerCallbackQuery', { callback_query_id: cb.id }).catch(() => {});
  }

  async function handleCallback(cb: TgCallbackQuery): Promise<void> {
    answerCallback(cb);
    const msgId = cb.message?.message_id;
    const data = cb.data;
    if (!msgId || !data) return;
    const resolve = waiters.get(msgId);
    if (resolve) {
      waiters.delete(msgId);
      resolve(data);
    }
  }

  async function requestApproval(
    chatId: number,
    command: string,
    execute?: (command: string) => Promise<{ ok: boolean; output: string }>,
  ): Promise<CommandApproval> {
    if (!opts.runCommand && !execute) return { approved: false, output: '' };
    const header = t.approval(`\`${command}\``);
    let messageId: number;
    try {
      const m = await post<TgMessage>(token, 'sendMessage', {
        chat_id: chatId,
        text: header,
        reply_markup: JSON.stringify({
          inline_keyboard: [
            [
              { text: t.btnRun, callback_data: 'cmd:run' },
              { text: t.btnCancel, callback_data: 'cmd:cancel' },
            ],
          ],
        }),
      });
      messageId = m.message_id;
      console.log(`[cmd-exec] approval requested: ${command}`);
    } catch (err) {
      console.error('[telegram] approval send error:', err);
      return { approved: false, output: '' };
    }

    const decision = await new Promise<string>((resolve) => {
      waiters.set(messageId, resolve);
      setTimeout(() => {
        if (waiters.has(messageId)) {
          waiters.delete(messageId);
          resolve('timeout');
        }
      }, APPROVAL_TIMEOUT);
    });

    const finish = (text: string): void => {
      // Omitting reply_markup removes the two buttons.
      post(token, 'editMessageText', { chat_id: chatId, message_id: messageId, text }).catch(
        (err) => console.error('[telegram] approval edit error:', err),
      );
    };

    if (decision === 'cmd:run') {
      console.log(`[cmd-exec] approved by user, running: ${command}`);
      finish(`${header}\n\n${t.running}`);
      const run = execute ?? opts.runCommand!;
      const res = await run(command);
      console.log(`[cmd-exec] finished, ok=${res.ok}`);
      const shown =
        res.output.length > 3000 ? `${res.output.slice(0, 3000)}\n${t.truncated}` : res.output;
      finish(`${header}\n\n${t.result}\n<${shown}>`);
      return { approved: res.ok, output: res.output };
    }

    if (decision === 'timeout') {
      console.log(`[cmd-exec] timed out, treated as cancelled: ${command}`);
      finish(`${header}\n\n${t.approvalTimeout}`);
    } else {
      console.log(`[cmd-exec] cancelled by user: ${command}`);
      finish(`${header}\n\n${t.approvalCancelled}`);
    }
    return { approved: false, output: '' };
  }

  // Per-chat task chains: messages from the same chat run one after another,
  // different chats run in parallel. This keeps the poll loop free so button
  // callbacks are always processed promptly, even mid-answer.
  const chatChains = new Map<number, Promise<void>>();

  function enqueueMessage(chatId: number, task: () => Promise<void>): void {
    const next = (chatChains.get(chatId) ?? Promise.resolve())
      .then(task)
      .catch((err) => console.error('[telegram] handler error:', err))
      .finally(() => {
        if (chatChains.get(chatId) === next) chatChains.delete(chatId);
      });
    chatChains.set(chatId, next);
  }

  async function pollLoop(): Promise<void> {
    let offset = 0;
    while (running) {
      controller = new AbortController();
      try {
        const updates = await callApi<TgUpdate[]>(
          token,
          'getUpdates',
          {
            timeout: String(POLL_TIMEOUT),
            offset: String(offset),
            allowed_updates: '["message","callback_query"]',
          },
          { signal: controller.signal },
        );
        for (const update of updates) {
          offset = update.update_id + 1;
          // Callbacks (Chạy/Hủy) must never wait: handling them here even
          // while an answer is in progress is the whole point.
          if (update.callback_query) {
            await handleCallback(update.callback_query);
          }
          const msg = update.message;
          if (msg) {
            enqueueMessage(msg.chat.id, () => handleMessage(msg));
          }
        }
      } catch (err) {
        if (!running) break; // aborted by stop()
        console.error('[telegram] poll error:', err);
        await sleep(RETRY_DELAY);
      }
    }
  }

  void pollLoop();

  return {
    stop(): void {
      running = false;
      controller?.abort();
    },
    requestApproval,
  };
}
