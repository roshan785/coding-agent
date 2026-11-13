import { NextRequest } from 'next/server';
import { toolSchemas, executeTool, needsApproval, runVerify, getPreviewDiff, loadRules, loadMemory, parseTscErrors, snapshotFile, restoreSnapshot, readFileSafe, extractImports } from '@/lib/tools';
import fs from 'fs/promises';
import path from 'path';

const API_URL = 'https://api.deepseek.com/v1/chat/completions';
const MODEL = 'deepseek-chat';
const MAX_TURNS = 40;
const MAX_VERIFY_FAILS = 5; // 5 escalating strategies
const WORKSPACE = process.cwd();

type ChatMsg = { role: 'system' | 'user' | 'assistant' | 'tool'; content: string | null; tool_calls?: any[]; tool_call_id?: string; };

interface HealAttempt {
  attempt: number;
  strategy: string;
  errorSnapshot: string;
  fixSummary: string;
}

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

// ═══════════════════════════════════════════════════════════
// STRATEGY PROMPTS — escalating, each more thorough
// ═══════════════════════════════════════════════════════════
function getHealStrategy(attempt: number, errorOutput: string, targetFile: string, fileContent: string, relatedContext: string, previousAttempts: HealAttempt[]): string {
  const attemptHistory = previousAttempts.length > 0
    ? `\n\n🔴 PREVIOUS FAILED ATTEMPTS (DO NOT REPEAT THESE):\n${previousAttempts.map((a) => `Attempt ${a.attempt} (${a.strategy}): ${a.fixSummary.slice(0, 150)}`).join('\n')}\n\n→ Your previous fix attempt failed. Try a DIFFERENT approach.`
    : '';

  const strategies: Record<number, string> = {
    1: `STEP 1 — DIRECT FIX
You have the exact error and the file content below. Fix the SPECIFIC TypeScript error shown.
Use edit_file with exact old_string from the file content.
Do NOT explore. Do NOT read other files. Just fix this ONE error.`,

    2: `STEP 2 — READ ALL RELATED FILES
Direct fix failed. Now go DEEPER:
1. The file imports from: (see related context below)
2. Read ALL those imported files completely with read_file
3. Check: does the import path exist? Does the exported type match?
4. Your fix may have missed a type mismatch in a related file
5. Now fix with full cross-file understanding`,

    3: `STEP 3 — ISOLATE THE ERROR
Two fixes failed. Isolate the exact problematic line:
1. Use edit_file to COMMENT OUT a suspected block (add /* ... */ or //)
2. Run: bash("npx tsc --noEmit")
3. If the error CHANGES → the problem is in that block. Narrow down.
4. If the error STAYS → try commenting a different block
5. Once isolated to a single line, fix ONLY that line

Use the isolation technique — don't guess, prove where the bug is.`,

    4: `STEP 4 — COMPARE WITH WORKING CODE
Three fixes failed. Find code in this project that WORKS and copy the pattern:
1. Use bash("ls components/") or bash("ls app/") to list similar files
2. Read 2-3 working files completely
3. Compare: what's different? imports? types? 'use client'? export style?
4. Apply the SAME pattern to your broken file
5. Your bug is likely a pattern mismatch — fix it to match the working code`,

    5: `STEP 5 — SAFE REWRITE (LAST RESORT)
Four fixes failed. The file may be fundamentally broken.
1. Read the ENTIRE current file one more time
2. In your thinking, write out: what SHOULD this file export? what SHOULD it render? what's the intent?
3. Use self_rewrite with the CLEAN implementation (snapshot + tsc validate + auto-rollback is built in)
4. Write it as if you're writing it fresh from the spec — ignore the broken code's structure
5. Verify with bash("npx tsc --noEmit")

⚠️ Last attempt. If this fails, I will honestly report the failure to the user.`,
  };

  return `🚨 SELF-HEAL MODE — Attempt ${attempt}/${MAX_VERIFY_FAILS}

═══ ROOT CAUSE (TypeScript error) ═══
${errorOutput}

═══ TARGET FILE: ${targetFile} ═══
${fileContent}

═══ RELATED FILES (imports) ═══
${relatedContext}
${attemptHistory}

═══════════════════════════════════════════════
${strategies[attempt] || strategies[1]}
═══════════════════════════════════════════════

After your fix, the system will automatically run tsc again. If it fails, we escalate to next strategy.
Work carefully. Do NOT say DONE unless tsc passes.`;
}

export async function POST(req: NextRequest) {
  const { messages } = await req.json();
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) return new Response(JSON.stringify({ error: 'DEEPSEEK_API_KEY not set' }), { status: 500 });

  const rules = await loadRules();
  const memory = await loadMemory();

  const SYSTEM_PROMPT = `You are an elite Senior Software Engineer with FULL autonomy.

══════════ PROJECT CONSTITUTION ══════════
${rules}
══════════════════════════════════════════

MEMORY: ${memory}

🎯 "OPEN" = ONE TOOL CALL: open_url({ target }) — no questions.

══════════ SELF-UPDATE PROTOCOL ══════════
Core files (lib/tools.ts, app/page.tsx, app/api/*/route.ts, etc.): use self_edit (surgical) or self_rewrite (full file).
Non-core files: edit_file (existing) or write_file (new).

══════════ ABSOLUTE RULES ══════════
- NEVER say "Done" unless you called a tool AND tsc passed.
- For core files: self_edit or self_rewrite ONLY.
- Start dev servers with: nohup npm run dev > /tmp/app.log 2>&1 &
- When tsc fails, the system will auto-inject a SELF-HEAL prompt with escalating strategies.`;

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (obj: any) => { try { controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`)); } catch {} };
      const recentMessages = messages.slice(-15);
      const convo: ChatMsg[] = [{ role: 'system', content: SYSTEM_PROMPT }, ...recentMessages];

      let verifyFailCount = 0;
      let lastWrittenFile = '';
      let lastSnap: { path: string; content: string } | null = null;
      const healAttempts: HealAttempt[] = [];

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
          let verifyFailed = false;

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

              // Snapshot before write (for potential restore)
              const isWrite = ['write_file', 'edit_file', 'self_edit', 'self_rewrite'].includes(tc.function.name);
              if (isWrite && typeof args.path === 'string') {
                lastWrittenFile = args.path;
                lastSnap = await snapshotFile(args.path);
              }

              send({ type: 'tool_start', name: tc.function.name, args });
              const result = await executeTool(tc.function.name, args, onOutput);

              if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
              flushOutput();

              send({ type: 'tool_result', name: tc.function.name, args, result: result.result });
              convo.push({ role: 'tool', tool_call_id: tc.id, content: result.result });

              // Self-edit → restart signal
              if ((tc.function.name === 'self_edit' || tc.function.name === 'self_rewrite') && !result.result.startsWith('Error')) {
                needsRestart = true;
              }

              // ═══════════════════════════════════════════════════════════
              // SELF-HEAL ENGINE — 5 escalating strategies
              // ═══════════════════════════════════════════════════════════
              if (isWrite && !result.result.startsWith('Error') && !result.result.startsWith('⛔')) {
                const v = await runVerify();
                send({ type: 'verify', ok: v.ok, command: v.command, output: v.output });

                if (!v.ok) {
                  verifyFailed = true;
                  verifyFailCount++;

                  if (verifyFailCount > MAX_VERIFY_FAILS) {
                    send({ 
                      type: 'text', 
                      chunk: `\n\n⛔ **Self-heal gave up after ${MAX_VERIFY_FAILS} attempts.**\n\nOriginal error:\n\`\`\`\n${v.output.slice(0, 500)}\n\`\`\`\n\n**What I tried:**\n${healAttempts.map(a => `- ${a.strategy}`).join('\n')}\n\n**Action needed:** Please review the error manually, or tell me a different approach to try.` 
                    });
                    break outer;
                  }

                  // Parse errors → find failing files
                  const errorFiles = parseTscErrors(v.output);
                  const targetFile = errorFiles[0] || lastWrittenFile;
                  
                  // Read file + related imports
                  const fileContent = await readFileSafe(targetFile) || '(could not read)';
                  const imports = extractImports(fileContent);
                  const relatedParts: string[] = [];
                  for (const imp of imports.slice(0, 5)) {
                    // Resolve @/ to project root
                    let resolved = imp;
                    if (imp.startsWith('@/')) resolved = imp.slice(2);
                    else if (imp.startsWith('./') || imp.startsWith('../')) {
                      const dir = path.dirname(targetFile);
                      resolved = path.normalize(path.join(dir, imp));
                    }
                    const exts = ['', '.ts', '.tsx', '/index.ts', '/index.tsx'];
                    for (const ext of exts) {
                      const content = await readFileSafe(resolved + ext);
                      if (content) {
                        relatedParts.push(`=== ${resolved + ext} ===\n${content.slice(0, 3000)}`);
                        break;
                      }
                    }
                  }
                  const relatedContext = relatedParts.length > 0 ? relatedParts.join('\n\n') : '(no related files found)';

                  // Get strategy for this attempt
                  const strategyNumber = Math.min(verifyFailCount, 5);
                  const strategyNames = ['', 'direct-fix', 'read-related', 'isolate', 'compare-working', 'safe-rewrite'];
                  const strategyName = strategyNames[strategyNumber];

                  send({ 
                    type: 'self_heal', 
                    attempt: verifyFailCount, 
                    maxAttempts: MAX_VERIFY_FAILS, 
                    strategy: strategyName,
                    message: `🔁 Self-heal attempt ${verifyFailCount}/${MAX_VERIFY_FAILS}: ${strategyName}` 
                  });

                  // Build escalating prompt
                  const healPrompt = getHealStrategy(strategyNumber, v.output, targetFile, fileContent, relatedContext, healAttempts);
                  
                  // Record attempt
                  healAttempts.push({
                    attempt: verifyFailCount,
                    strategy: strategyName,
                    errorSnapshot: v.output.slice(0, 200),
                    fixSummary: 'fix attempted',
                  });

                  convo.push({ role: 'user', content: healPrompt });
                  continue outer;
                } else {
                  // Success — reset counter
                  if (verifyFailCount > 0) {
                    send({ type: 'text', chunk: `\n\n✅ **Self-heal succeeded after ${verifyFailCount} attempt(s)!** TypeScript passes.\n\n` });
                  }
                  verifyFailCount = 0;
                  healAttempts.length = 0;
                }
              }

            } catch (outerErr: any) {
              try { convo.push({ role: 'tool', tool_call_id: tc.id, content: `Tool error: ${outerErr.message}` }); } catch {}
            }
          }

          if (needsRestart) {
            send({ type: 'restart_needed', message: 'Dev server restarting in 2s.' });
            send({ type: 'done' });
            break;
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
