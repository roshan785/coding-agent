import { NextRequest } from 'next/server';
import { toolSchemas, executeTool, needsApproval, runVerify, getPreviewDiff, loadRules, loadMemory } from '@/lib/tools';

const API_URL = 'https://api.deepseek.com/v1/chat/completions';
const MODEL = 'deepseek-chat';
const MAX_TURNS = 30;

type ChatMsg = { role: 'system' | 'user' | 'assistant' | 'tool'; content: string | null; tool_calls?: any[]; tool_call_id?: string; };

export async function POST(req: NextRequest) {
  const { messages } = await req.json();
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) return new Response(JSON.stringify({ error: 'No API key' }), { status: 500 });

  const rules = await loadRules();
  const memory = await loadMemory();

  const SYSTEM_PROMPT = `You are an elite Senior Software Engineer.
CONSTITUTION: ${rules}
MEMORY: ${memory}

SELF-UPDATE PROTOCOL:
Core files (lib/tools.ts, app/page.tsx, app/api/*/route.ts): Use self_edit (surgical) or self_rewrite (full).
Non-core files: Use edit_file/write_file.
NEVER say "Done" unless tsc passes.`;

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (obj: any) => { try { controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`)); } catch {} };
      const convo: ChatMsg[] = [{ role: 'system', content: SYSTEM_PROMPT }, ...messages.slice(-15)];

      try {
        outer: for (let turn = 0; turn < MAX_TURNS; turn++) {
          const res = await fetch(API_URL, {
            method: 'POST', headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ model: MODEL, messages: convo, tools: toolSchemas, tool_choice: 'auto', temperature: 0, stream: true }),
          });

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
                if (typeof delta.content === 'string') { fullText += delta.content; send({ type: 'text', chunk: delta.content }); }
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

          for (let i = 0; i < toolCalls.length; i++) {
            const tc = toolCalls[i];
            let args: any = {};
            try { args = JSON.parse(tc.function.arguments || '{}'); } catch {}

            const check = needsApproval(tc.function.name, args);
            if (check.blocked) {
              send({ type: 'tool_start', name: tc.function.name, args });
              send({ type: 'tool_result', name: tc.function.name, args, result: `⛔ ${check.reason}` });
              convo.push({ role: 'tool', tool_call_id: tc.id, content: `⛔ ${check.reason}` });
              continue;
            }

            send({ type: 'tool_start', name: tc.function.name, args });
            const result = await executeTool(tc.function.name, args, (chunk) => send({ type: 'tool_output', name: tc.function.name, args, chunk }));
            send({ type: 'tool_result', name: tc.function.name, args, result: result.result });
            convo.push({ role: 'tool', tool_call_id: tc.id, content: result.result });

            if ((tc.function.name === 'self_edit' || tc.function.name === 'self_rewrite') && !result.result.startsWith('Error') && !result.result.startsWith('⛔')) {
              needsRestart = true;
            }

            // BUG 3 FIX: Skip remaining tools if self-heal triggers
            if (result.result.startsWith('Error') && tc.function.name.includes('edit')) {
              for (let j = i + 1; j < toolCalls.length; j++) {
                convo.push({ role: 'tool', tool_call_id: toolCalls[j].id, content: '⏸ Skipped (handled by self-heal)' });
              }
              needsRestart = true;
              break;
            }
          }

          if (needsRestart) {
            send({ type: 'restart_needed', message: 'Server restarting in 2s.' });
            send({ type: 'done' });
            break outer;
          }
        }
      } catch { try { send({ type: 'done' }); } catch {} }
      finally { try { controller.close(); } catch {} }
    },
  });

  return new Response(stream, { headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' } });
}
