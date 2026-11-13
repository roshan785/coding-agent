// ═══════════════════════════════════════════════════════════
// Shared types — single source of truth for cross-module contracts.
// No `any` allowed anywhere in this project.
// ═══════════════════════════════════════════════════════════

/** Arbitrary JSON-ish value. Use with narrowing helpers below. */
export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

/** Tool arguments as received from the model (untrusted, must be narrowed). */
export type ToolArgs = Record<string, unknown>;

/** Safely read a string field from unknown tool args. */
export function argString(args: ToolArgs, key: string, fallback = ''): string {
  const v = args[key];
  return typeof v === 'string' ? v : fallback;
}

/** Safely read a number field from unknown tool args. */
export function argNumber(args: ToolArgs, key: string, fallback: number): number {
  const v = args[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

/** Narrow an unknown thrown value to a message string. */
export function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === 'string') return e;
  if (e && typeof e === 'object' && 'message' in e) {
    const m = (e as { message?: unknown }).message;
    if (typeof m === 'string') return m;
  }
  return 'Unknown error';
}

/** Narrow an unknown thrown value to an object with optional stdout/stderr. */
export function errorOutput(e: unknown): { stdout: string; stderr: string; message: string } {
  const obj = (e && typeof e === 'object' ? e : {}) as { stdout?: unknown; stderr?: unknown; message?: unknown };
  return {
    stdout: typeof obj.stdout === 'string' ? obj.stdout : '',
    stderr: typeof obj.stderr === 'string' ? obj.stderr : '',
    message: errorMessage(e),
  };
}

/** Narrow an unknown thrown value to an Error-like name (e.g. 'AbortError'). */
export function errorName(e: unknown): string {
  if (e && typeof e === 'object' && 'name' in e) {
    const n = (e as { name?: unknown }).name;
    if (typeof n === 'string') return n;
  }
  return '';
}

// ─── OpenAI-compatible chat payloads ───

export interface ToolCallFunction {
  name: string;
  arguments: string;
}

export interface ToolCall {
  id: string;
  type: 'function';
  function: ToolCallFunction;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

export interface ChatCompletionChoice {
  message: {
    role: string;
    content: string | null;
    tool_calls?: ToolCall[];
  };
}

export interface ChatCompletionResponse {
  choices: ChatCompletionChoice[];
}

/** Streaming delta for a single tool call fragment. */
export interface ToolCallDelta {
  index?: number;
  id?: string;
  function?: { name?: string; arguments?: string };
}

export interface ChatCompletionDelta {
  content?: string;
  tool_calls?: ToolCallDelta[];
}

export interface ChatCompletionStreamChunk {
  choices?: Array<{ delta?: ChatCompletionDelta }>;
}

// ─── Server-Sent Events sent to the browser ───

export type ChatStreamEvent =
  | { type: 'text'; chunk: string }
  | { type: 'plan'; plan: string[] }
  | { type: 'tool_start'; name: string; args: ToolArgs }
  | { type: 'tool_output'; name: string; args: ToolArgs; chunk: string }
  | { type: 'tool_result'; name: string; args: ToolArgs; result: string }
  | { type: 'verify'; ok: boolean; command: string; output: string }
  | { type: 'review_result'; ok: boolean; feedback: string }
  | { type: 'done' };

// ─── File tree ───

export interface FileTreeNode {
  name: string;
  path: string;
  type: 'dir' | 'file';
  children?: FileTreeNode[];
}
