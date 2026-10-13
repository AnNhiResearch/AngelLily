import OpenAI from 'openai';
import { t } from './i18n.js';

type Message = { role: 'system' | 'user' | 'assistant'; content: string };

export interface CommandApproval {
  approved: boolean;
  output: string;
}

export interface AIOptions {
  apiKey: string;
  baseURL?: string;
  model?: string;
  /** Max messages kept per session (user + assistant). Default 20. */
  maxHistory?: number;
  /** Base system prompt, usually loaded from .angellily/AGENTS.md. */
  system?: string;
  /**
   * Optional shell tool. When set, the LLM may end a reply with
   * <cmd>command</cmd>; the result (or the denial) comes back as the next
   * user message and the LLM continues.
   */
  runCommand?: (sessionId: string, command: string) => Promise<CommandApproval>;
  /** Environment description injected into the system prompt (with runCommand). */
  environment?: string;
  /** Extra system prompt appended after the base prompt (from plugins). */
  extraSystem?: string;
  /** Plugin tools the LLM may invoke with <tool name="...">input</tool>. */
  tools?: { name: string; description: string }[];
  /**
   * Executes a plugin tool. The result (or the denial) comes back as the next
   * user message and the LLM continues.
   */
  runTool?: (sessionId: string, name: string, input: string) => Promise<CommandApproval>;
}

export interface AI {
  /**
   * Send a user message, get the assistant reply.
   * Streams: calls onPartial with the accumulated text as tokens arrive
   * (command blocks are stripped from partials).
   * When the LLM requests a shell command or a plugin tool, onCommit is
   * awaited first so the UI can close the current preview — the next round
   * then appears as a new message below the command/tool result.
   * History is session-only (in memory, gone on restart).
   */
  chat(
    sessionId: string,
    text: string,
    onPartial?: (accumulated: string) => void,
    onCommit?: () => Promise<void>,
  ): Promise<string>;
  /** Reset a session's history. */
  clear(sessionId: string): void;
}

// The persona and Telegram HTML rules live in .angellily/AGENTS.md (loaded in main).
// The prompts below are the dynamic shell/tool protocol, kept in English:
// models tend to follow instructions more reliably in English.

const SHELL_PROMPT = [
  '',
  "You can run commands on the user's machine.",
  'Execution environment: {ENV}.',
  'When you need to run a command, end your reply with exactly ONE block:',
  '<cmd>the command to run</cmd>',
  'and write NOTHING after that block. You will receive the result (or a denial) in the next message, and only then continue.',
  'Example: "Let me check that folder for you.<cmd>Get-ChildItem -Path "D:\\project"</cmd>"',
  'Only request a command when truly necessary. The user has every right to refuse.',
].join('\n');

function toolsPrompt(tools: { name: string; description: string }[]): string {
  return [
    '',
    'You can also use tools provided by plugins:',
    ...tools.map((tool) => `- ${tool.name}: ${tool.description}`),
    'When you want to use a tool, end your reply with exactly ONE block:',
    '<tool name="tool_name">input</tool>',
    'and write NOTHING after that block. You will receive the result (or a denial) in the next message, and only then continue.',
    'Only use tools when truly necessary.',
  ].join('\n');
}

// Guard against the LLM looping on commands forever.
const MAX_TOOL_ROUNDS = 5;

// Strip command and tool blocks from text shown to the user: complete blocks
// and any trailing "<cmd>..." / "<tool ..." that is still being streamed.
function visible(text: string): string {
  let s = text
    .replace(/<cmd>[\s\S]*?<\/cmd>/g, '')
    .replace(/<tool\s[^>]*>[\s\S]*?<\/tool>/g, '');
  const cutCmd = s.indexOf('<cmd>');
  const cutTool = s.indexOf('<tool');
  const cuts = [cutCmd, cutTool].filter((i) => i >= 0);
  if (cuts.length > 0) s = s.slice(0, Math.min(...cuts));
  return s;
}

export function createAI(opts: AIOptions): AI {
  const client = new OpenAI({
    apiKey: opts.apiKey,
    baseURL: opts.baseURL,
  });
  const model = opts.model ?? 'gpt-4o-mini';
  const maxHistory = opts.maxHistory ?? 20;
  let system = opts.system ?? '';
  system += opts.extraSystem ? `\n\n${opts.extraSystem}` : '';
  if (opts.runCommand) {
    system += SHELL_PROMPT.replace('{ENV}', opts.environment ?? 'unknown');
  }
  if (opts.runTool && opts.tools?.length) {
    system += toolsPrompt(opts.tools);
  }

  // Session-only history: lives in memory, gone on restart. No persistence.
  const sessions = new Map<string, Message[]>();

  function history(sessionId: string): Message[] {
    let h = sessions.get(sessionId);
    if (!h) {
      h = [];
      sessions.set(sessionId, h);
    }
    return h;
  }

  function trim(h: Message[]): void {
    if (h.length > maxHistory) {
      h.splice(0, h.length - maxHistory);
    }
  }

  function clear(sessionId: string): void {
    sessions.delete(sessionId);
    console.log(`[ai] history cleared for session ${sessionId}`);
  }

  // Parse the shell command block: a complete block, or a lenient fallback
  // for a truncated reply that left it unclosed.
  function parseCmd(raw: string): string | null {
    const closed = raw.match(/<cmd>([\s\S]*?)<\/cmd>/);
    if (closed) return closed[1].trim() || null;
    const open = raw.indexOf('<cmd>');
    if (open !== -1) {
      const rest = raw.slice(open + 5).trim();
      if (rest) {
        console.log('[ai] note: unclosed <cmd> block, using the rest as the command');
        return rest;
      }
    }
    return null;
  }

  // Parse a plugin tool call: <tool name="...">input</tool> (same leniency).
  function parseTool(raw: string): { name: string; input: string } | null {
    const closed = raw.match(/<tool\s+name=["']([^"']+)["']\s*>([\s\S]*?)<\/tool>/);
    if (closed) return { name: closed[1].trim(), input: closed[2].trim() };
    const open = raw.search(/<tool\s/);
    if (open !== -1) {
      const head = raw.slice(open);
      const name = head.match(/name\s*=\s*["']([^"']+)["']/)?.[1];
      const gt = head.indexOf('>');
      if (name && gt !== -1) {
        console.log('[ai] note: unclosed <tool> block, using the rest as the input');
        return { name: name.trim(), input: head.slice(gt + 1).trim() };
      }
    }
    return null;
  }

  async function runShell(sessionId: string, command: string): Promise<string> {
    if (!opts.runCommand) {
      console.log('[ai] no shell tool configured');
      return `The user refused to run the command:\n> ${command}\nDo not try this command again. Continue your reply without the result.`;
    }
    const res = await opts.runCommand(sessionId, command);
    if (res.approved) {
      console.log('[ai] command approved, result sent back to the LLM');
      return `Command result:\n> ${command}\n\n${res.output}`;
    }
    console.log('[ai] command denied by user');
    return `The user refused to run the command:\n> ${command}\nDo not try this command again. Continue your reply without the result.`;
  }

  async function runToolCall(
    sessionId: string,
    call: { name: string; input: string },
  ): Promise<string> {
    if (!opts.runTool) {
      console.log('[ai] no plugin tools configured');
      return `The user refused to use the tool ${call.name}:\n> ${call.input}\nDo not try again. Continue your reply without the result.`;
    }
    const res = await opts.runTool(sessionId, call.name, call.input);
    if (res.approved) {
      console.log(`[ai] tool ${call.name} executed, result sent back to the LLM`);
      return `Tool ${call.name} result:\n\n${res.output}`;
    }
    console.log(`[ai] tool ${call.name} denied or unavailable`);
    return res.output
      ? `Cannot use the tool ${call.name}.\n${res.output}`
      : `The user refused to use the tool ${call.name}:\n> ${call.input}\nDo not try again. Continue your reply without the result.`;
  }

  // One streaming completion. Returns the raw reply (may contain <cmd>).
  async function streamOnce(h: Message[], onPartial?: (acc: string) => void): Promise<string> {
    const stream = await client.chat.completions.create({
      model,
      messages: [{ role: 'system', content: system }, ...h],
      stream: true,
    });
    let reply = '';
    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta?.content;
      if (delta) {
        reply += delta;
        onPartial?.(visible(reply));
      }
    }
    return reply || t.noResponse;
  }

  async function chat(
    sessionId: string,
    text: string,
    onPartial?: (accumulated: string) => void,
    onCommit?: () => Promise<void>,
  ): Promise<string> {
    if (!sessions.has(sessionId)) console.log(`[ai] new session ${sessionId}`);
    const h = history(sessionId);
    h.push({ role: 'user', content: text });
    trim(h);

    let full = '';
    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      if (round > 0) {
        console.log(`[ai] round ${round + 1}/${MAX_TOOL_ROUNDS}: continuing after command result`);
      }
      const raw = await streamOnce(h, onPartial);
      console.log(`[ai] round ${round + 1} reply received (${raw.length} chars)`);
      h.push({ role: 'assistant', content: raw });
      trim(h);

      const shown = visible(raw);
      full += shown;
      onPartial?.(shown); // preview ends on the cleaned text before approval opens

      const cmd = parseCmd(raw);
      const toolCall = !cmd && opts.runTool ? parseTool(raw) : null;
      if (!cmd && !toolCall) {
        if (/<cmd/i.test(raw) || /<tool/i.test(raw)) {
          console.log(`[ai] malformed command/tool block, raw reply: ${raw}`);
        }
        break;
      }
      if (cmd) console.log(`[ai] LLM requested command: ${cmd}`);
      if (toolCall) console.log(`[ai] LLM requested tool ${toolCall.name}: ${toolCall.input}`);
      // Close the current preview before the approval UI opens, so the next
      // round appears as a new message below the command/tool result.
      await onCommit?.();

      const content = cmd
        ? await runShell(sessionId, cmd)
        : await runToolCall(sessionId, toolCall!);
      h.push({ role: 'user', content });
      trim(h);
    }

    return full.trim() || t.noResponse;
  }

  return { chat, clear };
}
