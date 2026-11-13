import { NextRequest } from 'next/server';
import { randomUUID } from 'crypto';
import { toolSchemas, executeTool, needsApproval, runVerify, getPreviewDiff, loadRules, loadMemory } from '@/lib/tools';
import { waitForApproval } from '@/lib/permissions';
import { reviewCode } from '@/lib/reviewer';
import { exec } from 'child_process';
import { promisify } from 'util';
import fs from 'fs/promises';
import path from 'path';

const execAsync = promisify(exec);
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

// ============================================================
// NAYA LAYER 1: Tool Argument Validation (defense before execute)
// ============================================================
function validateToolArgs(name: string, args: any): { valid: boolean; error?: string } {
  if (name === 'write_file') {
    if (typeof args.path !== 'string' || !args.path.trim()) return { valid: false, error: 'path is required and must be a non-empty string' };
    if (typeof args.content !== 'string') return { valid: false, error: 'content must be a string' };
    if (args.content.trim().length < 20) return { valid: false, error: `content is only ${args.content.length} chars — likely truncated. Read the target file first and re-write.` };
  } else if (name === 'edit_file') {
    if (typeof args.path !== 'string' || !args.path.trim()) return { valid: false, error: 'path is required' };
    if (typeof args.old_string !== 'string' || args.old_string.length === 0) return { valid: false, error: 'old_string is required and must be non-empty' };
    if (typeof args.new_string !== 'string') return { valid: false, error: 'new_string must be a string (use "" to delete)' };
  } else if (name === 'bash') {
    if (typeof args.command !== 'string' || !args.command.trim()) return { valid: false, error: 'command is required' };
  } else if (name === 'read_file') {
    if (typeof args.path !== 'string' || !args.path.trim()) return { valid: false, error: 'path is required' };
  } else if (name === 'update_plan') {
    if (!Array.isArray(args.plan)) return { valid: false, error: 'plan must be an array of strings' };
  } else if (name === 'update_memory') {
    if (typeof args.content !== 'string' || args.content.trim().length < 5) return { valid: false, error: 'content is required' };
  }
  return { valid: true };
}

export async function POST(req: NextRequest) {
  const { messages, autoApprove } = await req.json();
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) return new Response(JSON.stringify({ error: 'DEEPSEEK_API_KEY not set' }), { status: 500 });

  const rules = await loadRules();
  const memory = await loadMemory();
  const projectContext = await getProjectContext();

  const SYSTEM_PROMPT = `You are an Advanced Autonomous Coding Agent. You MUST strictly follow the PROJECT CONSTITUTION below.

============== PROJECT CONSTITUTION ==============
${rules}
==================================================

LONG-TERM MEMORY:
${memory}

CURRENT WORKSPACE CONTEXT:
${projectContext}

AVAILABLE TOOLS:
- update_memory(content)
- update_plan(plan: string[])
- read_file(path)
- write_file(path, content)
- edit_file(path, old_string, new_string)
- bash(command)

Instructions:
- You are in a LOOP. Continue using tools until the task is fully complete and verified.
- SELF-UPDATE: You are fully authorized to upgrade your own UI and logic.
- Do not ask for permission in text; if you need to run a tool, just run it.
- The system will automatically verify (tsc) and auto-review after edits.`;

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (obj: any) => { try { controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`)); } catch {} };
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

          if (!res.ok || !res.body) {
            send({ type: 'error', message: `DeepSeek ${res.status}: ${await res.text()}` });
            break;
          }

          const reader = res.body.getReader();
          const decoder = new TextDecoder();
          let buf = '', fullText = '';
          const toolCallsMap: Record<number, any> = {};

          // ============================================================
          // NAYA LAYER 0: Stream Integrity Tracking
          // ============================================================
          let finishReason: string | null = null;
          let gotDone = false;
          let streamErrored = false;
          let streamError: string | null = null;

          while (true) {
            let chunk;
            try {
              chunk = await reader.read();
            } catch (e: any) {
              streamErrored = true;
              streamError = e.message || 'Network error mid-stream';
              break;
            }
            const { done, value } = chunk;
            if (done) break;
            buf += decoder.decode(value, { stream: true });
            const lines = buf.split('\n');
            buf = lines.pop() || '';
            for (const line of lines) {
              if (!line.startsWith('data: ')) continue;
              const raw = line.slice(6).trim();
              if (raw === '[DONE]') { gotDone = true; continue; }
              try {
                const parsed = JSON.parse(raw);
                const choice = parsed.choices?.[0];
                if (choice?.finish_reason) finishReason = choice.finish_reason;
                const delta = choice?.delta;
                if (!delta) continue;
                if (typeof delta.content === 'string' && delta.content.length > 0) {
                  fullText += delta.content;
                  send({ type: 'text', chunk: delta.content });
                }
                if (Array.isArray(delta.tool_calls)) {
                  for (const tc of delta.tool_calls) {
                    const i = tc.index ?? 0;
                    if (!toolCallsMap[i]) toolCallsMap[i] = { id: '', type: 'function', function: { name: '', arguments: '' } };
                    if (tc.id) toolCallsMap[i].id = tc.id;
                    if (tc.function?.name) toolCallsMap[i].function.name += tc.function.name;
                    if (tc.function?.arguments) toolCallsMap[i].function.arguments += tc.function.arguments;
                  }
                }
              } catch { /* ignore non-JSON keepalive */ }
            }
          }

          // ============================================================
          // STREAM INTEGRITY GATE: refuse to apply partial output
          // ============================================================
          const hasToolCalls = Object.keys(toolCallsMap).length > 0;
          const streamIncomplete =
            streamErrored ||
            (!gotDone && !finishReason) ||
            (hasToolCalls && finishReason !== 'tool_calls');

          if (streamErrored) {
            send({ type: 'error', message: `⛔ Network dropped mid-response (${streamError}). No partial changes were applied. Please retry your request.` });
            break;
          }

          if (finishReason === 'length') {
            send({ type: 'error', message: '⛔ Response hit token limit before completion. No partial changes were applied. Please break the task into smaller steps.' });
            break;
          }

          if (hasToolCalls && finishReason !== 'tool_calls') {
            send({ type: 'error', message: `⛔ Response was truncated (finish_reason=${finishReason ?? 'null'}). Tool call arguments are incomplete. No changes applied. Please retry.` });
            break;
          }

          if (streamIncomplete && !hasToolCalls && !fullText) {
            send({ type: 'error', message: '⛔ Empty response from API. Please retry.' });
            break;
          }

          // If we reached here: stream completed cleanly.
          const toolCalls = Object.values(toolCallsMap);
          if (toolCalls.length === 0) { send({ type: 'done' }); break; }
          convo.push({ role: 'assistant', content: fullText, tool_calls: toolCalls });

          for (const tc of toolCalls) {
            // Parse args safely
            let args: any;
            let parseError: string | null = null;
            try {
              args = JSON.parse(tc.function.arguments || '{}');
            } catch (e: any) {
              args = {};
              parseError = e.message;
            }

            // LAYER 1: validate arguments before anything else
            if (parseError || !validateToolArgs(tc.function.name, args).valid) {
              const reason = parseError
                ? `Invalid JSON in tool arguments: ${parseError}`
                : (validateToolArgs(tc.function.name, args).error || 'Invalid arguments');
              send({ type: 'tool_start', name: tc.function.name, args: {} });
              const msg = `⛔ REJECTED (SAFETY LAYER 1): ${reason}. The tool call was not executed. Read the file and retry with complete, valid arguments.`;
              send({ type: 'tool_result', name: tc.function.name, args: {}, result: msg });
              convo.push({ role: 'tool', tool_call_id: tc.id, content: msg });
              continue;
            }

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
            const needsPrompt = check.need && !autoApprove;

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

              if (!v.ok) {
                verifyFailCount++;
                if (verifyFailCount > MAX_VERIFY_FAILS) {
                  convo.push({ role: 'user', content: `Auto-verify FAILED ${verifyFailCount} times. STOP.\n\n${v.output}` });
                } else {
                  convo.push({ role: 'user', content: `Auto-verify FAILED:\n\n${v.output}\n\nFix this immediately.` });
                }
              } else {
                verifyFailCount = 0;
                if (typeof args.path === 'string') {
                  send({ type: 'review_start', file: args.path });
                  try {
                    const fullPath = path.resolve(WORKSPACE, args.path);
                    const contentToReview = await fs.readFile(fullPath, 'utf-8');
                    const review = await reviewCode(args.path, contentToReview);
                    send({ type: 'review_result', ok: review.ok, feedback: review.feedback });
                    if (!review.ok) {
                      convo.push({ role: 'user', content: `Reviewer Agent REJECTED your code for ${args.path}:\n\n${review.feedback}\n\nFix the code according to this review.` });
                    }
                  } catch (e: any) {
                    send({ type: 'review_result', ok: false, feedback: e.message });
                  }
                }
              }
            }
          }
        }
      } catch (e: any) {
        send({ type: 'error', message: `Fatal error: ${e.message}` });
      } finally {
        try { controller.close(); } catch {}
      }
    },
  });

  return new Response(stream, {
    headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' }
  });
}
