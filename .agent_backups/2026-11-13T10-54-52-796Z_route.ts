import { NextRequest } from 'next/server';
import { toolSchemas, executeTool, needsApproval, runVerify, getPreviewDiff, loadRules, loadMemory } from '@/lib/tools';
import { reviewCode } from '@/lib/reviewer';
import fs from 'fs/promises';
import path from 'path';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

const API_URL = 'https://api.deepseek.com/v1/chat/completions';
const MODEL = 'deepseek-chat';
const MAX_TURNS = 50;
const MAX_VERIFY_FAILS = 3;
const WORKSPACE = process.cwd();

type ChatMsg = { role: 'system' | 'user' | 'assistant' | 'tool'; content: string | null; tool_calls?: any[]; tool_call_id?: string; };

async function getProjectContext() {
  try {
    const files = await fs.readdir(WORKSPACE);
    return `Root files: ${files.filter(f => !['node_modules', '.git', '.next', '.agent_backups'].includes(f)).join(', ')}`;
  } catch { return 'Could not read project root.'; }
}

function validateToolArgs(name: string, args: any): { valid: boolean; error?: string } {
  if (name === 'write_file') {
    if (typeof args.path !== 'string' || !args.path.trim()) return { valid: false, error: 'path required' };
    if (typeof args.content !== 'string') return { valid: false, error: 'content must be string' };
    if (args.content.trim().length < 50) return { valid: false, error: `content too short (${args.content.length} bytes)` };
  } else if (name === 'edit_file') {
    if (typeof args.path !== 'string' || !args.path.trim()) return { valid: false, error: 'path required' };
    if (typeof args.old_string !== 'string' || !args.old_string) return { valid: false, error: 'old_string required' };
    if (typeof args.new_string !== 'string') return { valid: false, error: 'new_string required' };
  } else if (name === 'bash') {
    if (typeof args.command !== 'string' || !args.command.trim()) return { valid: false, error: 'command required' };
  } else if (name === 'read_file') {
    if (typeof args.path !== 'string' || !args.path.trim()) return { valid: false, error: 'path required' };
  }
  return { valid: true };
}

// ═══════════════════════════════════════════
// NAYA: DeepSeek API auto-retry
// ═══════════════════════════════════════════
async function fetchDeepSeek(body: any, apiKey: string, retries = 3): Promise<Response> {
  let lastErr: any = null;
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(API_URL, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(180000),
      });
      if (res.ok) return res;
      // 5xx → retry, 4xx → don't retry
      if (res.status >= 500 && i < retries - 1) {
        await new Promise((r) => setTimeout(r, 1000 * (i + 1)));
        continue;
      }
      return res;
    } catch (e) {
      lastErr = e;
      if (i < retries - 1) await new Promise((r) => setTimeout(r, 1000 * (i + 1)));
    }
  }
  throw lastErr || new Error('DeepSeek API failed after retries');
}

export async function POST(req: NextRequest) {
  const { messages } = await req.json();
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) return new Response(JSON.stringify({ error: 'DEEPSEEK_API_KEY not set' }), { status: 500 });

  const rules = await loadRules();
  const memory = await loadMemory();
  const projectContext = await getProjectContext();

  const SYSTEM_PROMPT = `You are a Universal Autonomous Software Architect.

============== PROJECT CONSTITUTION ==============
${rules}
==================================================

LONG-TERM MEMORY:
${memory}

CURRENT WORKSPACE CONTEXT:
${projectContext}

═══════════════ ABSOLUTE RULES ═══════════════

1. **DO EXACTLY WHAT THE USER ASKS**: If user says "run build", run build and SHOW OUTPUT, then STOP. If a command fails → report error and STOP (do NOT fix unless asked). NEVER edit config files (next.config.ts, tsconfig.json, package.json).

2. **EXPLAIN BEFORE EVERY TOOL**: One short sentence explaining WHY.

3. **FINAL SUMMARY MANDATORY**:
   ### 📋 Summary
   - **What I did:** ...
   - **Files changed:** ...
   - **Verification:** ...

4. **TRUTHFULNESS**: NEVER say "Done" unless you ACTUALLY called a tool. If build fails → say "I failed: <error>".

5. **TOOLS**: read_file, write_file, edit_file, bash (READ-ONLY), check_build. Bash file writes are BLOCKED. NEVER use 'any' in TypeScript.`;

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (obj: any) => { try { controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`)); } catch {} };
      const recentMessages = messages.slice(-15);
      const convo: ChatMsg[] = [{ role: 'system', content: SYSTEM_PROMPT }, ...recentMessages];

      let verifyFailCount = 0;
      let writesThisTurn = 0;
      const userAskedForChange = messages[messages.length - 1]?.content?.match(/(add|create|thap|बनाऊ|हटाऊ|remove|change|update|fix|modify|implement|गर)/i) !== null;

      try {
        for (let turn = 0; turn < MAX_TURNS; turn++) {
          let res: Response;
          try {
            res = await fetchDeepSeek({
              model: MODEL, messages: convo, tools: toolSchemas, tool_choice: 'auto', temperature: 0, stream: true,
            }, apiKey);
          } catch (e: any) {
            // DeepSeek API is down even after retries → send a single friendly event, no fatal error
            send({ type: 'text', chunk: `\n\n_⚠️ AI service temporarily unavailable. Please try again in a moment._\n\n` });
            send({ type: 'done' });
            break;
          }

          if (!res.ok || !res.body) {
            send({ type: 'text', chunk: `\n\n_⚠️ AI service error (${res.status}). Try again._\n\n` });
            send({ type: 'done' });
            break;
          }

          const reader = res.body.getReader();
          const decoder = new TextDecoder();
          let buf = '', fullText = '';
          const toolCallsMap: Record<number, any> = {};
          let finishReason: string | null = null;
          let streamErrored = false;

          while (true) {
            let chunk;
            try { chunk = await reader.read(); } catch { streamErrored = true; break; }
            const { done, value } = chunk;
            if (done) break;
            buf += decoder.decode(value, { stream: true });
            const lines = buf.split('\n'); buf = lines.pop() || '';
            for (const line of lines) {
              if (!line.startsWith('data: ')) continue;
              const raw = line.slice(6).trim(); if (raw === '[DONE]') continue;
              try {
                const parsed = JSON.parse(raw);
                const choice = parsed.choices?.[0];
                if (choice?.finish_reason) finishReason = choice.finish_reason;
                const delta = choice?.delta;
                if (!delta) continue;
                if (typeof delta.content === 'string' && delta.content.length > 0) { fullText += delta.content; send({ type: 'text', chunk: delta.content }); }
                if (Array.isArray(delta.tool_calls)) {
                  for (const tc of delta.tool_calls) {
                    const i = tc.index ?? 0;
                    if (!toolCallsMap[i]) toolCallsMap[i] = { id: '', type: 'function', function: { name: '', arguments: '' } };
                    if (tc.id) toolCallsMap[i].id = tc.id;
                    if (tc.function?.name) toolCallsMap[i].function.name += tc.function.name;
                    if (tc.function?.arguments) toolCallsMap[i].function.arguments += tc.function.arguments;
                  }
                }
              } catch {}
            }
          }

          const hasToolCalls = Object.keys(toolCallsMap).length > 0;
          if (streamErrored) { send({ type: 'done' }); break; }
          if (finishReason === 'length') { send({ type: 'done' }); break; }
          if (hasToolCalls && finishReason !== 'tool_calls') { send({ type: 'done' }); break; }

          const toolCalls = Object.values(toolCallsMap);

          if (toolCalls.length === 0) {
            if (userAskedForChange && writesThisTurn === 0 && turn === 0) {
              send({ type: 'text', chunk: '\n\n_⚠️ कुनै tool call भएन — पुनः प्रयास..._\n\n' });
              convo.push({ role: 'assistant', content: fullText });
              convo.push({ role: 'user', content: 'STOP. You did not call any tool. Use edit_file or write_file.' });
              continue;
            }
            send({ type: 'done' });
            break;
          }

          convo.push({ role: 'assistant', content: fullText, tool_calls: toolCalls });

          for (const tc of toolCalls) {
            let args: any = {};
            let parseError: string | null = null;
            try { args = JSON.parse(tc.function.arguments || '{}'); } catch (e: any) { parseError = e.message; }

            const validation = validateToolArgs(tc.function.name, args);
            if (parseError || !validation.valid) {
              const reason = parseError ? `Invalid JSON: ${parseError}` : (validation.error || 'Invalid args');
              send({ type: 'tool_start', name: tc.function.name, args: {} });
              const msg = `⛔ REJECTED: ${reason}.`;
              send({ type: 'tool_result', name: tc.function.name, args: {}, result: msg });
              convo.push({ role: 'tool', tool_call_id: tc.id, content: msg });
              continue;
            }

            const check = needsApproval(tc.function.name, args);
            if (check.blocked) {
              send({ type: 'tool_start', name: tc.function.name, args });
              const msg = check.reason || 'Blocked.';
              send({ type: 'tool_result', name: tc.function.name, args, result: `⛔ BLOCKED: ${msg}` });
              convo.push({ role: 'tool', tool_call_id: tc.id, content: `⛔ BLOCKED: ${msg}` });
              continue;
            }

            if (tc.function.name === 'update_plan') {
              send({ type: 'plan', plan: args.plan || [] });
              send({ type: 'tool_result', name: 'update_plan', args, result: 'Plan updated.' });
              convo.push({ role: 'tool', tool_call_id: tc.id, content: 'Plan updated.' });
              continue;
            }

            let outputBuffer = '';
            let flushTimer: ReturnType<typeof setTimeout> | null = null;
            const flushOutput = () => {
              if (outputBuffer) { send({ type: 'tool_output', name: tc.function.name, args, chunk: outputBuffer }); outputBuffer = ''; }
              flushTimer = null;
            };
            const onOutput = (chunk: string) => {
              outputBuffer += chunk;
              if (!flushTimer) flushTimer = setTimeout(flushOutput, 50);
            };

            send({ type: 'tool_start', name: tc.function.name, args });
            const result = await executeTool(tc.function.name, args, onOutput);

            if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
            flushOutput();

            send({ type: 'tool_result', name: tc.function.name, args, result: result.result });
            convo.push({ role: 'tool', tool_call_id: tc.id, content: result.result });

            const succeeded = !result.result.startsWith('Error') && !result.result.startsWith('Blocked') && !result.result.startsWith('⛔');
            const isWrite = tc.function.name === 'write_file' || tc.function.name === 'edit_file';

            if (isWrite && succeeded) {
              writesThisTurn++;
              const v = await runVerify();
              send({ type: 'verify', ok: v.ok, command: v.command, output: v.output });

              if (!v.ok) {
                verifyFailCount++;
                if (verifyFailCount > MAX_VERIFY_FAILS) convo.push({ role: 'user', content: `Auto-verify FAILED ${verifyFailCount}x. STOP. Tell user honestly.\n\n${v.output}` });
                else convo.push({ role: 'user', content: `Auto-verify FAILED:\n\n${v.output}\n\nFix immediately.` });
              } else {
                verifyFailCount = 0;
                if (typeof args.path === 'string') {
                  send({ type: 'review_start', file: args.path });
                  try {
                    const fullPath = path.resolve(WORKSPACE, args.path);
                    const contentToReview = await fs.readFile(fullPath, 'utf-8');
                    const review = await reviewCode(args.path, contentToReview);
                    send({ type: 'review_result', ok: review.ok, feedback: review.feedback });
                    if (!review.ok) convo.push({ role: 'user', content: `Reviewer REJECTED ${args.path}:\n\n${review.feedback}` });
                  } catch (e: any) { send({ type: 'review_result', ok: false, feedback: e.message }); }
                }
              }
            }
          }
        }
      } catch (e: any) {
        // Last resort: send done, never throw
        try { send({ type: 'done' }); } catch {}
      } finally {
        try { controller.close(); } catch {}
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}
