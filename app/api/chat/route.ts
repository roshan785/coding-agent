import { NextRequest } from 'next/server';
import { toolSchemas, executeTool, needsApproval, runVerify, getPreviewDiff, loadRules, loadMemory } from '@/lib/tools';
import fs from 'fs/promises';
import path from 'path';

const API_URL = 'https://api.deepseek.com/v1/chat/completions';
const MODEL = 'deepseek-chat';
const MAX_TURNS = 15;
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

  const SYSTEM_PROMPT = `You are an elite Senior Software Engineer.

══════════ PROJECT CONSTITUTION ══════════
${rules}
══════════════════════════════════════════

LONG-TERM MEMORY:
${memory}

🎯 **NEW CAPABILITY: MULTI-PROJECT SUPPORT**
You are now allowed to work on other projects inside ~/Documents (e.g., ~/Documents/GentMart).
You have full read/write access to ~/Documents/*.

**TO OPEN A WEBSITE:**
1. If you need to run a dev server (e.g., \`npm run dev\`), NEVER run it in the foreground. ALWAYS use:
   \`nohup npm run dev > /tmp/app.log 2>&1 &\`
2. Wait a few seconds (\`sleep 5\`).
3. Check the log to ensure it started: \`cat /tmp/app.log\`
4. Open it in browser: \`xdg-open http://localhost:PORT\`
   - (GentMart uses port 4100. Our coding-agent uses 3000.)

**TO SETUP DATABASE & .env:**
- For PostgreSQL, use \`psql\` commands.
- Create .env using \`write_file\` tool (now allowed).
- Then run \`npx prisma generate && npx prisma db push && npm run db:seed\`.

══════════ ABSOLUTE RULES ══════════
- NEVER say "Done" unless you actually called edit_file/write_file/bash.
- ALWAYS use \`nohup ... &\` for dev servers.
- When cloning repos, do it inside ~/Documents.
- When asked to "open" a website, run \`xdg-open http://localhost:PORT\`.`;

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
            send({ type: 'text', chunk: `\n\n_⚠️ AI temporarily unavailable._\n\n` });
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
                const choice = parsed.choices?.[0];
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
                if (!flushTimer) flushTimer = setTimeout(flushOutput, 50);
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
