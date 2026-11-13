import { NextRequest } from 'next/server';
import { randomUUID } from 'crypto';
import { toolSchemas, executeTool, needsApproval, runVerify, getPreviewDiff, loadRules, loadMemory } from '@/lib/tools';
import { waitForApproval } from '@/lib/permissions';
import fs from 'fs/promises';
import path from 'path';

const API_URL = 'https://api.deepseek.com/v1/chat/completions';
const MODEL = 'deepseek-chat';
const MAX_TURNS = 40;
const MAX_VERIFY_FAILS = 3;
const WORKSPACE = process.cwd();

type ChatMsg = { role: 'system' | 'user' | 'assistant' | 'tool'; content: string | null; tool_calls?: any[]; tool_call_id?: string; };

async function getProjectContext() {
  try {
    const files = await fs.readdir(WORKSPACE);
    return `Root files: ${files.filter(f => !['node_modules', '.git', '.next', '.agent_backups'].includes(f)).join(', ')}`;
  } catch { return 'Could not read project root.'; }
}

export async function POST(req: NextRequest) {
  const { messages, autoApprove } = await req.json();
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) return new Response(JSON.stringify({ error: 'DEEPSEEK_API_KEY not set' }), { status: 500 });

  const rules = await loadRules();
  const memory = await loadMemory(); // NAYA
  const projectContext = await getProjectContext();
  
  const SYSTEM_PROMPT = `You are an autonomous coding agent. You MUST strictly follow the PROJECT CONSTITUTION below.

============== PROJECT CONSTITUTION ==============
${rules}
==================================================

LONG-TERM MEMORY (Things you learned previously):
${memory}

CURRENT WORKSPACE CONTEXT:
${projectContext}

AVAILABLE TOOLS:
- update_memory(content): Save important context so you don't forget.
- update_plan(plan: string[]): Use for complex tasks.
- read_file(path)
- write_file(path, content): Only for NEW files.
- edit_file(path, old_string, new_string): PREFERRED for edits.
- bash(command)

Instructions:
- You are in a LOOP. Continue using tools until the task is fully complete and verified.
- Do not ask for permission in text; if you need to run a tool, just run it.
- The system will automatically ask the user for permission if needed, and auto-verify after edits.`;

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (obj: any) => { try { controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`)); } catch {} };
      
      // NAYA: Context Trimming (Keep only last 15 messages to save tokens)
      const recentMessages = messages.slice(-15);
      const convo: ChatMsg[] = [{ role: 'system', content: SYSTEM_PROMPT }, ...recentMessages];
      
      let verifyFailCount = 0;

      try {
        for (let turn = 0; turn < MAX_TURNS; turn++) {
          const res = await fetch(API_URL, {
            method: 'POST',
            headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ model: MODEL, messages: convo, tools: toolSchemas, tool_choice: 'auto', temperature: 0, stream: true }),
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

            if (tc.function.name === 'update_plan') {
              send({ type: 'plan', plan: args.plan || [] });
              send({ type: 'tool_result', name: 'update_plan', args, result: 'Plan updated.' });
              convo.push({ role: 'tool', tool_call_id: tc.id, content: 'Plan updated.' });
              continue;
            }

            const previewDiff = await getPreviewDiff(tc.function.name, args);
            const isWrite = tc.function.name === 'write_file' || tc.function.name === 'edit_file';
            const needsPrompt = check.need && !(autoApprove && isWrite);

            if (needsPrompt) {
              const reqId = randomUUID();
              send({ type: 'permission_request', id: reqId, tool: tc.function.name, args, reason: check.reason, diff: previewDiff });
              send({ type: 'tool_start', name: tc.function.name, args });
              const approved = await waitForApproval(reqId);
              if (!approved) {
                const msg = 'Permission denied by user.';
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

            const succeeded = !result.result.startsWith('Error') && !result.result.startsWith('Blocked');
            if (isWrite && succeeded) {
              const v = await runVerify();
              send({ type: 'verify', ok: v.ok, command: v.command, output: v.output });
              if (v.ok) { verifyFailCount = 0; }
              else {
                verifyFailCount++;
                if (verifyFailCount > MAX_VERIFY_FAILS) { convo.push({ role: 'user', content: `Auto-verify FAILED ${verifyFailCount} times. STOP.\n\n${v.output}` }); }
                else { convo.push({ role: 'user', content: `Auto-verify FAILED:\n\n${v.output}\n\nFix this immediately.` }); }
              }
            }
          }
        }
      } catch (e: any) { send({ type: 'error', message: e.message }); }
      finally { try { controller.close(); } catch {} }
    },
  });

  return new Response(stream, { headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' } });
}
