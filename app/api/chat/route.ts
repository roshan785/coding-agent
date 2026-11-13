import { NextRequest } from 'next/server';
import { toolSchemas, executeTool, needsApproval, runVerify, getPreviewDiff, loadRules, loadMemory } from '@/lib/tools';
import fs from 'fs/promises';
import path from 'path';

const API_URL = 'https://api.deepseek.com/v1/chat/completions';
const MODEL = 'deepseek-chat';
const MAX_TURNS = 25;
const WORKSPACE = process.cwd();

type ChatMsg = { role: 'system' | 'user' | 'assistant' | 'tool'; content: string | null; tool_calls?: any[]; tool_call_id?: string; };

async function fetchDeepSeek(body: any, apiKey: string, retries = 2): Promise<Response> {
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

  const SYSTEM_PROMPT = `You are an elite Senior Software Engineer with full autonomy.

══════════ PROJECT CONSTITUTION ══════════
${rules}
══════════════════════════════════════════

LONG-TERM MEMORY:
${memory}

🎯 **"OPEN" = ONE TOOL CALL. NO QUESTIONS. NO EXPLORATION.**

When the user says ANY of these:
- "open GentMart" / "GentMart खोल" / "genmart website open gara"
- "open <project name>"
- "open <url>" / "open website"
- "yo website khola"

You MUST **immediately** call:
\`\`\`
open_url({ "target": "<project name or URL>" })
\`\`\`

**DO NOT:**
- ❌ Ask "which URL?"
- ❌ Run scan_project first
- ❌ Run grep_search to find the project
- ❌ Check if node_modules exist
- ❌ Try to "understand" what GentMart is
- ❌ Do 5 bash commands before opening
- ❌ Say "मलाई थाहा छैन"

**JUST ONE CALL:** \`open_url({ "target": "GentMart" })\`

The tool AUTOMATICALLY:
- Finds the project in ~/Documents/
- Reads package.json for the port
- Starts dev server if not running
- Waits for it to be ready
- Opens it in the browser

**EXAMPLES:**
- User: "GentMart खोल" → You: \`open_url({ "target": "GentMart" })\`
- User: "open google.com" → You: \`open_url({ "target": "https://google.com" })\`
- User: "open localhost:4100" → You: \`open_url({ "target": "localhost:4100" })\`
- User: "open my-project" → You: \`open_url({ "target": "my-project" })\`

That's it. ONE sentence of text, ONE tool call, DONE.

══════════ OTHER TASKS ══════════
For code changes / bugs / features: understand first, use edit_file surgically, verify with tsc.

══════════ ABSOLUTE RULES ══════════
- When user says "open", call open_url IMMEDIATELY. Do not think. Do not ask.
- NEVER say "Done" unless you called a tool.
- Use \`nohup npm run dev > /tmp/x.log 2>&1 &\` for background servers.`;

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (obj: any) => { try { controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`)); } catch {} };
      const recentMessages = messages.slice(-15);
      const convo: ChatMsg[] = [{ role: 'system', content: SYSTEM_PROMPT }, ...recentMessages];

      try {
        for (let turn = 0; turn < MAX_TURNS; turn++) {
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

            } catch (outerErr: any) {
              try { convo.push({ role: 'tool', tool_call_id: tc.id, content: `Tool error: ${outerErr.message}` }); } catch {}
            }
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
