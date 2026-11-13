import { NextRequest } from 'next/server';
import { randomUUID } from 'crypto';
import { toolSchemas, executeTool, needsApproval, runVerify } from '@/lib/tools';
import { waitForApproval } from '@/lib/permissions';

const API_URL = 'https://api.deepseek.com/v1/chat/completions';
const MODEL = 'deepseek-chat';
const MAX_TURNS = 30;
const MAX_VERIFY_FAILS = 3;

type ChatMsg = {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: any[];
  tool_call_id?: string;
};

const SYSTEM_PROMPT = `You are a coding agent running inside a Next.js app on the user's Linux machine.
Workspace = current project directory.

TOOLS:
- read_file(path)
- write_file(path, content): overwrite whole file (NEW files or complete rewrites)
- edit_file(path, old_string, new_string): surgical replace (PREFERRED for edits)
- bash(command)

STRICT RULES:
1. ALWAYS read_file before editing.
2. For edits use edit_file with UNIQUE old_string copied from the file.
3. write_file only for NEW files.
4. AUTO-VERIFY: after every write_file or edit_file, the system automatically runs the project's verification (e.g. npx tsc --noEmit).
   - If it FAILS, you will receive the exact error in a user message. Fix it with edit_file.
   - You have max 3 fix attempts. After 3, stop and report the exact error.
   - Do NOT declare "done" for code changes until verify passes.
5. Never fabricate file contents or command output. Use tools.
6. Be concise. Report what you did and whether verify passed.
7. Ambiguous task → ask one short clarifying question.
8. User will be asked to approve writes and risky commands. If denied, stop and ask how to proceed.`;

export async function POST(req: NextRequest) {
  const { messages } = await req.json();
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) {
    return new Response(JSON.stringify({ error: 'DEEPSEEK_API_KEY not set' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (obj: any) => {
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));
        } catch {}
      };

      const convo: ChatMsg[] = [
        { role: 'system', content: SYSTEM_PROMPT },
        ...messages,
      ];

      let verifyFailCount = 0;

      try {
        for (let turn = 0; turn < MAX_TURNS; turn++) {
          const res = await fetch(API_URL, {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${apiKey}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              model: MODEL,
              messages: convo,
              tools: toolSchemas,
              tool_choice: 'auto',
              temperature: 0.2,
              stream: true,
            }),
          });

          if (!res.ok || !res.body) {
            send({ type: 'error', message: `DeepSeek ${res.status}: ${await res.text()}` });
            break;
          }

          const reader = res.body.getReader();
          const decoder = new TextDecoder();
          let buf = '';
          let fullText = '';
          const toolCallsMap: Record<number, any> = {};

          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buf += decoder.decode(value, { stream: true });
            const lines = buf.split('\n');
            buf = lines.pop() || '';
            for (const line of lines) {
              if (!line.startsWith('data: ')) continue;
              const raw = line.slice(6).trim();
              if (raw === '[DONE]') continue;
              try {
                const parsed = JSON.parse(raw);
                const delta = parsed.choices?.[0]?.delta;
                if (!delta) continue;
                if (typeof delta.content === 'string' && delta.content.length > 0) {
                  fullText += delta.content;
                  send({ type: 'text', chunk: delta.content });
                }
                if (Array.isArray(delta.tool_calls)) {
                  for (const tc of delta.tool_calls) {
                    const i = tc.index ?? 0;
                    if (!toolCallsMap[i]) {
                      toolCallsMap[i] = { id: '', type: 'function', function: { name: '', arguments: '' } };
                    }
                    if (tc.id) toolCallsMap[i].id = tc.id;
                    if (tc.function?.name) toolCallsMap[i].function.name += tc.function.name;
                    if (tc.function?.arguments) toolCallsMap[i].function.arguments += tc.function.arguments;
                  }
                }
              } catch {}
            }
          }

          const toolCalls = Object.values(toolCallsMap);
          if (toolCalls.length === 0) {
            send({ type: 'done' });
            break;
          }

          convo.push({ role: 'assistant', content: fullText, tool_calls: toolCalls });

          for (const tc of toolCalls) {
            let args: any = {};
            try {
              args = JSON.parse(tc.function.arguments || '{}');
            } catch {}

            const check = needsApproval(tc.function.name, args);

            if (check.blocked) {
              send({ type: 'tool_start', name: tc.function.name, args });
              const msg = 'Blocked: dangerous command. Refusing to run.';
              send({ type: 'tool_result', name: tc.function.name, args, result: msg });
              convo.push({ role: 'tool', tool_call_id: tc.id, content: msg });
              continue;
            }

            if (check.need) {
              const reqId = randomUUID();
              send({ type: 'permission_request', id: reqId, tool: tc.function.name, args, reason: check.reason });
              send({ type: 'tool_start', name: tc.function.name, args });
              const approved = await waitForApproval(reqId);
              if (!approved) {
                const msg = 'Permission denied by user. Do not retry this exact action; ask the user how to proceed.';
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

            // ---- SELF-HEAL: auto-verify after successful writes ----
            const isWrite = tc.function.name === 'write_file' || tc.function.name === 'edit_file';
            const succeeded = !result.result.startsWith('Error') && !result.result.startsWith('Blocked');
            if (isWrite && succeeded) {
              const v = await runVerify();
              send({ type: 'verify', ok: v.ok, command: v.command, output: v.output });

              if (v.ok) {
                verifyFailCount = 0;
              } else {
                verifyFailCount++;
                if (verifyFailCount > MAX_VERIFY_FAILS) {
                  convo.push({
                    role: 'user',
                    content: `Auto-verify has now FAILED ${verifyFailCount} times. STOP trying to fix it. Report the exact errors below to the user and ask how to proceed.\n\n${v.output}`,
                  });
                } else {
                  convo.push({
                    role: 'user',
                    content: `Auto-verify FAILED (attempt ${verifyFailCount}/${MAX_VERIFY_FAILS}) running \`${v.command}\`:\n\n${v.output}\n\nFix these errors with edit_file. The system will auto-verify again after your fix.`,
                  });
                }
              }
            }
          }
        }
      } catch (e: any) {
        send({ type: 'error', message: e.message });
      } finally {
        try { controller.close(); } catch {}
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}
