// Shell tool: decides which shell executes commands and runs them.
// Pure execution — the Telegram approval UI lives in telegram.ts.
//
// Windows rule (fixed, deterministic):
//   1. pwsh.exe (PowerShell 7)  — used whenever it is installed
//   2. powershell.exe (5.1)     — used when pwsh is not installed
//   3. neither found            — startup fails with a clear error
//   The bot NEVER runs commands through cmd.exe.
// Elsewhere: /bin/sh (Termux, macOS and Linux are told apart for the prompt).

import { spawn } from 'node:child_process';

export interface ShellResult {
  ok: boolean; // exit code 0
  output: string; // combined stdout/stderr, truncated
}

export interface Shell {
  /** One-line description of the environment, for the LLM system prompt. */
  describe(): string;
  /** Run a command with this environment's own shell. */
  run(command: string, timeoutMs?: number): Promise<ShellResult>;
}

const MAX_OUTPUT = 6000; // chars handed back to the LLM
const DEFAULT_TIMEOUT = 60_000;

type Env = 'termux' | 'macos' | 'linux' | 'win-ps5' | 'win-ps7';

const DESCRIPTIONS: Record<Env, string> = {
  termux: 'Termux on Android — Linux shell (bash/sh), some utilities are limited',
  macos: 'macOS — zsh/bash shell',
  linux: 'Linux — sh/bash shell',
  'win-ps5': 'Windows PowerShell 5.1 — PowerShell syntax',
  'win-ps7': 'PowerShell 7 (pwsh) — PowerShell syntax',
};

// Run `where.exe <exe>` to test whether a Windows executable is on PATH.
function which(exe: string): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn('where.exe', [exe], { windowsHide: true });
    child.on('error', () => resolve(false));
    child.on('close', (code) => resolve(code === 0));
  });
}

function detectUnix(): Env {
  const termux =
    process.env.TERMUX_VERSION !== undefined ||
    (process.env.PREFIX ?? '').includes('com.termux');
  if (termux) return 'termux';
  if (process.platform === 'darwin') return 'macos';
  return 'linux';
}

function spawnArgs(command: string, env: Env): { file: string; args: string[] } {
  switch (env) {
    case 'win-ps5':
      return { file: 'powershell.exe', args: ['-NoProfile', '-Command', command] };
    case 'win-ps7':
      return { file: 'pwsh', args: ['-NoProfile', '-Command', command] };
    default:
      return { file: '/bin/sh', args: ['-c', command] };
  }
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  const half = Math.floor(max / 2);
  return `${text.slice(0, half)}\n... [skipped ${text.length - max} characters] ...\n${text.slice(-half)}`;
}

export async function createShell(): Promise<Shell> {
  let env: Env;

  if (process.platform === 'win32') {
    if (await which('pwsh')) {
      env = 'win-ps7';
    } else if (await which('powershell')) {
      env = 'win-ps5';
    } else {
      throw new Error(
        'No PowerShell found on this machine. ' +
          'Install PowerShell (pwsh.exe or powershell.exe) so the bot can run commands.',
      );
    }
  } else {
    env = detectUnix();
  }

  function describe(): string {
    return DESCRIPTIONS[env];
  }

  function run(command: string, timeoutMs: number = DEFAULT_TIMEOUT): Promise<ShellResult> {
    const { file, args } = spawnArgs(command, env);
    return new Promise((resolve) => {
      console.log(`[shell] run: ${command}`);
      const child = spawn(file, args, { windowsHide: true });
      let out = '';
      const collect = (d: Buffer): void => {
        out += d.toString();
      };
      child.stdout?.on('data', collect);
      child.stderr?.on('data', collect);

      const timer = setTimeout(() => {
        child.kill();
        out += `\n[command stopped after ${Math.round(timeoutMs / 1000)}s]`;
        console.log(`[shell] timeout after ${Math.round(timeoutMs / 1000)}s`);
      }, timeoutMs);

      child.on('error', (err) => {
        clearTimeout(timer);
        console.log(`[shell] failed to spawn: ${err.message}`);
        resolve({ ok: false, output: `Failed to run command: ${err.message}` });
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        console.log(`[shell] exit code ${code}`);
        const output = truncate(out.trim() || '(no output)', MAX_OUTPUT);
        resolve({ ok: code === 0, output });
      });
    });
  }

  return { describe, run };
}
