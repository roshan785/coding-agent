import { NextRequest } from 'next/server';
import { randomUUID } from 'crypto';
import { toolSchemas, executeTool, needsApproval, runVerify, getPreviewDiff, loadRules } from '@/lib/tools';
import { waitForApproval } from '@/lib/permissions';

const API_URL = 'https://api.deepseek.com/v1/chat/completions';
const MODEL = 'deepseek-chat';
const MAX_TURNS = 30;
const MAX_VERIFY_FAILS = 3;

type ChatMsg = { role: 'system' | 'user' | 'assistant' | 'tool'; content: string | null; tool_calls?: any[]; tool_call_id?: string; };

export async function POST(req: NextRequest) {
  const { messages } = await req.json();
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) return new Response(JSON.stringify({ error: 'DEEPSEEK_API_KEY not set' }), { status: 500, headers: { 'Content-Type': 'application/json' } });

  // Rules load garne
  const rules = await loadRules();
  
  const SYSTEM_PROMPT = `You are a STRICT, RULE-BOUND coding agent running on the user's Linux machine.
You MUST NOT violate any of the following PROJECT CONSTITUTION rules. If you do, you fail your task.

============== PROJECT CONSTITUTION ==============
${rules}
==================================================

TOOLS:
- read_file(path)
- write_file(path, content): overwrite (NEW files only)
- edit_file(path, old_string, new_string): surgical replace (PREFERRED)
- bash(command)

STRICT RULES:
1. ALWAYS read_file before editing.
2. For edits use edit_file with UNIQUE old_string.
3. write_file only for NEW files.
4. AUTO-VERIFY: after every write/edit, system runs verification. If it FAILS, fix it with edit_file (Max 3 times).
5. If the user asks you to do something that violates the PROJECT CONSTITUTION above, you MUST refuse and explain why.
6. Never fabricate file contents or command output.
7. Be concise.`;

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (obj: any) => { try { controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`)); } catch {} };
      const convo: ChatMsg[] = [{ role: 'system', content: SYSTEM_PROMPT }, ...messages];
      let verifyFailCount = 0;

      try {
        for (let turn = 0; turn < MAX_TURNS; turn++) {
          const res = await fetch(API_URL, {
            method: 'POST',
            headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ 
              model: MODEL, 
              messages: convo, 
              tools: toolSchemas, 
              tool_choice: 'auto', 
              temperature: 0, // STRICT MODE: Zero creativity, pure adherence to rules
              stream: true 
            }),
          });

          if (!res.ok || !res.body) { send({ type: 'error', message: `DeepSeek ${res.status}: ${await res.text()}` }); break; }

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
                const delta = parsed.choices?.[0]?.delta; if (!delta) continue;
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
            let args: any = {}; try { args = JSON.parse(tc.function.arguments || '{}'); } catch {}
            const check = needsApproval(tc.function.name, args);

            if (check.blocked) {
              send({ type: 'tool_start', name: tc.function.name, args });
              const msg = 'Blocked: dangerous command.';
              send({ type: 'tool_result', name: tc.function.name, args, result: msg });
              convo.push({ role: 'tool', tool_call_id: tc.id, content: msg });
              continue;
            }

            const previewDiff = await getPreviewDiff(tc.function.name, args);

            if (check.need) {
              const reqId = randomUUID();
              send({ type: 'permission_request', id: reqId, tool: tc.function.name, args, reason: check.reason, diff: previewDiff });
              send({ type: 'tool_start', name: tc.function.name, args });
              const approved = await waitForApproval(reqId);
              if (!approved) {
                const msg = 'Permission denied by user. Do not retry. Ask the user how to proceed.';
                send({ type: 'tool_result', name: tc.function.name, args, result: msg });
                convo.push({ role: 'tool', tool_call_id: tc.id, content: msg });
                continue;
              }
            } else {
              send({ type: 'tool_start', name: tc.function.name, args });
            }

            const result = await executeTool(tc.function.name, args);
            send({ type: 'tool_result', name: tc.function.name, args, result: result.result });
            convo.push({ role: 'tool', tool_call_id: tc.id, content: result.result });

            const isWrite = tc.function.name === 'write_file' || tc.function.name === 'edit_file';
            const succeeded = !result.result.startsWith('Error') && !result.result.startsWith('Blocked');
            if (isWrite && succeeded) {
              const v = await runVerify();
              send({ type: 'verify', ok: v.ok, command: v.command, output: v.output });
              if (v.ok) { verifyFailCount = 0; }
              else {
                verifyFailCount++;
                if (verifyFailCount > MAX_VERIFY_FAILS) {
                  convo.push({ role: 'user', content: `Auto-verify FAILED ${verifyFailCount} times. STOP. Report error to user.\n\n${v.output}` });
                } else {
                  convo.push({ role: 'user', content: `Auto-verify FAILED (attempt ${verifyFailCount}/${MAX_VERIFY_FAILS}):\n\n${v.output}\n\nFix this immediately.` });
                }
              }
            }
          }
        }
      } catch (e: any) { send({ type: 'error', message: e.message }); }
      finally { try { controller.close(); } catch {} }
    },
  });

  return new Response(stream, {
    headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' },
  });
}
