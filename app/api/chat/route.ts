import { NextRequest } from 'next/server';
import { toolSchemas, executeTool, needsApproval, runVerify, getPreviewDiff, loadRules, loadMemory } from '@/lib/tools';
import fs from 'fs/promises';
import path from 'path';

const API_URL = 'https://api.deepseek.com/v1/chat/completions';
const MODEL = 'deepseek-chat';
const MAX_TURNS = 30;
const WORKSPACE = process.cwd();

type ChatMsg = { role: 'system' | 'user' | 'assistant' | 'tool'; content: string | null; tool_calls?: any[]; tool_call_id?: string; };

async function fetchDeepSeek(body: any, apiKey: string, retries = 2): Promise<Response> {
  let lastErr: any = null;
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(API_URL, {
        method: 'POST', headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body), signal: AbortSignal.timeout(180000),
      });
      if (res.ok) return res;
      if (res.status >= 500 && i < retries - 1) { await new Promise((r) => setTimeout(r, 1000 * (i + 1))); continue; }
      return res;
    } catch (e) {
      lastErr = e;
      if (i < retries - 1) await new Promise((r) => setTimeout(r, 1000 * (i + 1)));
    }
  }
  throw lastErr || new Error('DeepSeek API failed');
}

export async function POST(req: NextRequest) {
  const { messages } = await req.json();
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) return new Response(JSON.stringify({ error: 'DEEPSEEK_API_KEY not set' }), { status: 500 });

  const rules = await loadRules();
  const memory = await loadMemory();

  const SYSTEM_PROMPT = `You are an elite Senior Software Engineer with FULL autonomy, including SELF-MODIFICATION.

══════════ PROJECT CONSTITUTION ══════════
${rules}
══════════════════════════════════════════

MEMORY: ${memory}

🎯 "OPEN" = ONE TOOL CALL:
- "open GentMart" / "open <project>" / "open <url>" → CALL open_url({ target }) IMMEDIATELY
- DO NOT ask questions. DO NOT scan first. JUST call open_url.

══════════ 🛡️ SELF-UPDATE PROTOCOL ══════════

CORE FILES (you MUST use self_edit for these):
- lib/tools.ts
- lib/multiAgent.ts
- app/api/chat/route.ts
- app/api/multi-chat/route.ts
- app/page.tsx
- app/multi/page.tsx

WHY self_edit IS MANDATORY FOR CORE FILES:
- edit_file on core files is BLOCKED (returns error)
- self_edit does: snapshot → validate → tsc check → auto-rollback on failure
- If tsc fails, your change is AUTOMATICALLY REVERTED — agent stays alive
- If successful, dev server will restart cleanly

WORKFLOW FOR "modify yourself" requests:
1. read_file the core file FIRST (understand current code)
2. update_plan (for multi-step changes)
3. self_edit({ path: "lib/tools.ts", old_string: "...", new_string: "..." })
4. The stream will end cleanly after self_edit (server restarting)
5. On next message, run verify_agent_health to confirm you're alive

CRITICAL RULES FOR self_edit:
- old_string must be EXACT text from the file (copy from read_file output)
- old_string must appear ONLY ONCE (add context if needed)
- Make surgical changes, not full rewrites
- If self_edit returns error → READ the error, fix the actual TypeScript issue, retry

EXAMPLES:
- Add new tool: self_edit("lib/tools.ts", "name: 'bash', description: 'Run a READ-ONLY bash'", "name: 'bash', description: 'Run bash'...ADD NEW TOOL HERE...")
- Change UI: self_edit("app/page.tsx", "<h1 className='...'>Coding Agent</h1>", "<h1 className='...'>Advanced Coding Agent</h1>")

══════════ NORMAL CODE (non-core) ══════════
For non-core files (components/, lib/hello.ts, etc.):
- edit_file for existing
- write_file ONLY for new files

══════════ VERIFICATION ══════════
- After self_edit → stream ends → server restarts
- On next message → call verify_agent_health FIRST
- If healthy → continue. If broken → read last snapshot in .agent_snapshots/ and rollback manually

══════════ ABSOLUTE RULES ══════════
- NEVER say "Done" unless you actually called a tool
- For core files → self_edit ONLY (edit_file is blocked)
- Start dev servers with: nohup npm run dev > /tmp/app.log 2>&1 &`;

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (obj: any) => { try { controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`)); } catch {} };
      const recentMessages = messages.slice(-15);
      const convo: ChatMsg[] = [{ role: 'system', content: SYSTEM_PROMPT }, ...recentMessages];

      try {
        outer: for (let turn = 0; turn < MAX_TURNS; turn++) {
          let res: Response;
          try {
            res = await fetchDeepSeek({ model: MODEL, messages: convo, tools: toolSchemas, tool_choice: 'auto', temperature: 0, stream: true }, apiKey);
          } catch {
            send({ type: 'text', chunk: `\n\n_⚠️ AI unavailable. Retry._\n\n` });
            send({ type: 'done' }); break;
          }

          if (!res.ok || !res.body) { send({ type: 'done' }); break; }

          const reader = res.body.getReader();
          const decoder = new TextDecoder();
          let buf = '', fullText = '';
          const toolCallsMap: Record<number, any> = {};

          while (true) {
            const { done, value } = await reader.read(); if (done) break;
            buf += decoder.decode(value, { stream: true });
            const lines = buf.split('\n'); buf = lines.pop() || '';
            for (const line of lines) {
              if (!line.startsWith('data: ')) continue;
              const raw = line.slice(6).trim(); if (raw === '[DONE]') continue;
              try {
                const parsed = JSON.parse(raw);
                const delta = parsed.choices?.[0]?.delta;
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

          const toolCalls = Object.values(toolCallsMap);
          if (toolCalls.length === 0) { send({ type: 'done' }); break; }
          convo.push({ role: 'assistant', content: fullText, tool_calls: toolCalls });

          let needsRestart = false;

          for (const tc of toolCalls) {
            try {
              let args: any = {};
              try { args = JSON.parse(tc.function.arguments || '{}'); } catch {}

              if (tc.function.name === 'update_plan') {
                send({ type: 'plan', plan: args.plan || [] });
                send({ type: 'tool_result', name: 'update_plan', args, result: 'Plan updated.' });
                convo.push({ role: 'tool', tool_call_id: tc.id, content: 'Plan updated.' });
                continue;
              }

              const check = needsApproval(tc.function.name, args);
              if (check.blocked) {
                send({ type: 'tool_start', name: tc.function.name, args });
                send({ type: 'tool_result', name: tc.function.name, args, result: `⛔ BLOCKED: ${check.reason}` });
                convo.push({ role: 'tool', tool_call_id: tc.id, content: `⛔ BLOCKED: ${check.reason}` });
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
                if (!flushTimer) flushTimer = setTimeout(flushOutput, 100);
              };

              send({ type: 'tool_start', name: tc.function.name, args });
              const result = await executeTool(tc.function.name, args, onOutput);

              if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
              flushOutput();

              send({ type: 'tool_result', name: tc.function.name, args, result: result.result });
              convo.push({ role: 'tool', tool_call_id: tc.id, content: result.result });

              // ═══════════════════════════════════════════
              // GRACEFUL SELF-EDIT RESTART
              // ═══════════════════════════════════════════
              if (tc.function.name === 'self_edit' && !result.result.startsWith('Error')) {
                needsRestart = true;
              }

            } catch (outerErr: any) {
              try { convo.push({ role: 'tool', tool_call_id: tc.id, content: `Tool error: ${outerErr.message}` }); } catch {}
            }
          }

          // If any self_edit succeeded → send restart signal and break
          if (needsRestart) {
            send({ type: 'restart_needed', message: 'Dev server restarting in 2s. Chat stream will reconnect.' });
            send({ type: 'done' });
            break outer;
          }
        }
      } catch {
        try { send({ type: 'done' }); } catch {}
      } finally {
        try { controller.close(); } catch {}
      }
    },
  });

  return new Response(stream, {
    headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' },
  });
}
