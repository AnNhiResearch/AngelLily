// Owner verification for a single-user bot.
//
// Flow: an unverified chat sends /verify -> the bot prints a 6-digit OTP on
// the terminal (valid 60 seconds) -> the same chat sends the code back.
// This binds the device owner (who can read the terminal) with the Telegram
// account, with no extra setup. 10 wrong codes put the chat on a blacklist.
//
// All state is session-only: lost on restart. A person with device access
// can always re-verify; a remote stranger cannot restart the bot.

import { randomInt } from 'node:crypto';

const OTP_TTL = 60_000; // ms
const MAX_ATTEMPTS = 10;

export interface VerifyResult {
  status: 'ok' | 'wrong' | 'expired' | 'blocked';
  /** Remaining tries before blacklisting (only for 'wrong'). */
  attemptsLeft?: number;
}

export interface Auth {
  hasOwner(): boolean;
  isOwner(chatId: number): boolean;
  isBlacklisted(chatId: number): boolean;
  isPending(chatId: number): boolean;
  /** Generate a 6-digit OTP, print it on the terminal and wait for it. */
  startVerification(chatId: number): void;
  /** Treat a message as the verification code. */
  checkCode(chatId: number, code: string): VerifyResult;
}

export function createAuth(): Auth {
  let owner: number | null = null;
  let pending: { chatId: number; code: string; expiresAt: number } | null = null;
  const attempts = new Map<number, number>();
  const blacklist = new Set<number>();

  function hasOwner(): boolean {
    return owner !== null;
  }

  function isOwner(chatId: number): boolean {
    return owner !== null && owner === chatId;
  }

  function isBlacklisted(chatId: number): boolean {
    return blacklist.has(chatId);
  }

  function isPending(chatId: number): boolean {
    return pending !== null && pending.chatId === chatId;
  }

  function startVerification(chatId: number): void {
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    pending = { chatId, code, expiresAt: Date.now() + OTP_TTL };
    const tried = attempts.get(chatId) ?? 0;
    console.log('');
    console.log('==========================================');
    console.log(`[auth] OTP: ${code}`);
    console.log(`[auth] Valid for 60 seconds - chat ${chatId} is verifying`);
    if (tried > 0) {
      console.log(`[auth] Note: this chat already failed ${tried}/${MAX_ATTEMPTS} times`);
    }
    console.log('==========================================');
  }

  function checkCode(chatId: number, code: string): VerifyResult {
    if (!pending || pending.chatId !== chatId) return { status: 'expired' };
    if (Date.now() > pending.expiresAt) {
      pending = null;
      return { status: 'expired' };
    }

    const clean = code.replace(/\s+/g, '');
    if (clean === pending.code) {
      owner = chatId;
      pending = null;
      attempts.delete(chatId);
      console.log(`[auth] Verification OK for chat ${chatId}`);
      return { status: 'ok' };
    }

    const tried = (attempts.get(chatId) ?? 0) + 1;
    attempts.set(chatId, tried);
    console.log(`[auth] Wrong code from chat ${chatId} (attempt ${tried}/${MAX_ATTEMPTS})`);
    if (tried >= MAX_ATTEMPTS) {
      blacklist.add(chatId);
      pending = null;
      attempts.delete(chatId);
      console.log(`[auth] Chat ${chatId} blacklisted`);
      return { status: 'blocked' };
    }
    return { status: 'wrong', attemptsLeft: MAX_ATTEMPTS - tried };
  }

  return {
    hasOwner,
    isOwner,
    isBlacklisted,
    isPending,
    startVerification,
    checkCode,
  };
}
