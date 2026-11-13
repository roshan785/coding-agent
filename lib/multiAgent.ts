import { executeTool, needsApproval, runVerify, loadRules, loadMemory, toolSchemas } from './tools';
import { ChatCompletionResponse, ToolArgs, errorMessage } from '@/types';
import { exec } from 'child_process';
import { promisify } from 'util';
import fs from 'fs/promises';
import path from 'path';

const execAsync = promisify(exec);
const WORKSPACE = process.cwd();
const API_URL = 'https://api.deepseek.com/v1/chat/completions';
const MODEL = 'deepseek-chat';
const MAX_WORKER_TURNS = 20;
const RECOVERY_TIME_LIMIT_MS = 5 * 60 * 1000; // 5 minutes total for recovery
const RECOVERY_API_LIMIT = 40; // max API calls during recovery

function dlog(tag: string, msg: string, data?: unknown) {
  const ts = new Date().toISOString().split('T')[1].slice(0, 8);
  const dataStr = data ? ' ' + JSON.stringify(data).slice(0, 300) : '';
  console.log(`[${ts}] [${tag}] ${msg}${dataStr}`);
}

export interface Subtask {
  id: string;
  title: string;
  description: string;
  files_hint: string[];
  priority: number;
}

export type WorkerEvent = {
  type:
    | 'orchestrator_start' | 'orchestrator_done'
    | 'plan_ready' | 'integration_start' | 'integration_done'
    | 'worker_start' | 'worker_step' | 'worker_thought' | 'worker_done' | 'worker_error'
    | 'recovery_start' | 'recovery_strategy' | 'recovery_worker_start' | 'recovery_worker_done' | 'recovery_failed'
    | 'blackboard' | 'info';
  orchestratorId?: number;
  workerId?: number | string;
  message?: string;
  ok?: boolean;
  subtask?: Subtask;
  subtasks?: Subtask[];
  tool?: string;
  args?: unknown;
  elapsedMs?: number;
  strategy?: string;
  attempt?: number;
};

class SharedBlackboard {
  private entries: Array<{ workerId: number | string; type: string; content: string; timestamp: number }> = [];
  publish(workerId: number | string, type: string, content: string): void {
    this.entries.push({ workerId, type, content, timestamp: Date.now() });
  }
  read(forWorkerId: number | string): string {
    const relevant = this.entries.filter((e) => e.workerId !== forWorkerId);
    if (relevant.length === 0) return '(no messages yet)';
    return relevant.map((e) => `[${e.workerId === 'system' ? 'SYS' : 'W' + e.workerId}] ${e.type}: ${e.content}`).join('\n');
  }
}

class Semaphore {
  private permits: number;
  private waiting: Array<() => void> = [];
  constructor(permits: number) { this.permits = permits; }
  async acquire(): Promise<void> {
    if (this.permits > 0) { this.permits--; return; }
    return new Promise((r) => this.waiting.push(r));
  }
  release(): void {
    this.permits++;
    const next = this.waiting.shift();
    if (next) { this.permits--; next(); }
  }
}

// ═══════════════════════════════════════════════════════════
// DEEP DEBUGGER: 5 escalating strategies for hard errors
// ═══════════════════════════════════════════════════════════
interface DebugAttempt {
  strategy: string;
  ok: boolean;
  summary: string;
  filesChanged: string[];
}

interface FileSnapshot {
  path: string;
  content: string;
}

async function snapshotFiles(filePaths: string[]): Promise<FileSnapshot[]> {
  const snapshots: FileSnapshot[] = [];
  for (const p of filePaths) {
    try {
      const full = path.resolve(WORKSPACE, p);
      const content = await fs.readFile(full, 'utf-8');
      snapshots.push({ path: p, content });
    } catch {}
  }
  return snapshots;
}

async function restoreFiles(snapshots: FileSnapshot[]): Promise<void> {
  for (const s of snapshots) {
    try {
      const full = path.resolve(WORKSPACE, s.path);
      await fs.writeFile(full, s.content, 'utf-8');
      dlog('RESTORE', `Restored ${s.path}`);
    } catch {}
  }
}

function buildStrategyPrompt(strategy: string, subtask: Subtask, previousAttempts: DebugAttempt[], rules: string, memory: string): string {
  const attemptHistory = previousAttempts.length > 0
    ? `\n\n🔴 PREVIOUS FAILED ATTEMPTS (DO NOT REPEAT THESE):\n${previousAttempts.map((a, i) => `${i + 1}. Strategy "${a.strategy}": ${a.summary.slice(0, 200)}`).join('\n')}`
    : '';

  const base = `You are Worker #${subtask.id} in RECOVERY MODE. Previous attempts to complete this task have FAILED.

ASSIGNED TASK: ${subtask.title}
DESCRIPTION: ${subtask.description}
FILES TO TOUCH: ${subtask.files_hint.join(', ') || '(decide)'}

CONSTITUTION:
${rules}

MEMORY:
${memory}
${attemptHistory}

═══════════ CURRENT STRATEGY: ${strategy} ═══════════`;

  const strategies: Record<string, string> = {
    'direct-fix': `
STEP 1: Run \`npx tsc --noEmit\` (bash) and read the FIRST error carefully.
STEP 2: Read the exact file and line mentioned in the error.
STEP 3: Make ONE surgical fix for that error using edit_file.
STEP 4: Run \`npx tsc --noEmit\` again. If new error → repeat steps 1-3.

Be direct. Fix errors one at a time. Do not read extra files unless needed.
End with "DONE: <summary>" or "FAILED: <reason>".`,

    'read-analyze': `
This is attempt #2. Direct fixes failed. Take a step back and UNDERSTAND.

STEP 1: Read EVERY file in files_hint COMPLETELY (use read_file, not partial).
STEP 2: Read any other files that these import from (use grep_search to find them).
STEP 3: In your thinking, describe: "The file should import X from Y, expose Z as props, and handle W".
STEP 4: Identify the MISMATCH between requirements and current state.
STEP 5: Fix ALL issues in one surgical pass with edit_file.
STEP 6: Run \`npx tsc --noEmit\` to verify.

End with "DONE: <summary>" or "FAILED: <reason>".`,

    'isolate': `
This is attempt #3. Two fixes failed. The problem might be deeper.

STRATEGY: Isolate the exact failing line.
STEP 1: Run \`npx tsc --noEmit 2>&1 | head -20\` to see the full error list.
STEP 2: If error is complex, temporarily comment out parts of the file (use edit_file to add // before a block).
STEP 3: Run tsc again to see if error changes → narrows down the cause.
STEP 4: Once isolated, uncomment and fix ONLY the problematic part.
STEP 5: Run tsc to verify.

Do NOT rewrite the whole file. Only comment/uncomment and surgically edit.

End with "DONE: <summary>" or "FAILED: <reason>".`,

    'compare-similar': `
This is attempt #4. Three fixes failed. You may be missing an existing pattern.

STRATEGY: Find working code that does the same thing.
STEP 1: Use \`bash("ls -la components/") or grep_search\` to find similar files (e.g., other .tsx components).
STEP 2: Read those working files completely.
STEP 3: Compare their structure to your failing file.
STEP 4: What's different? Imports? Types? 'use client'? Export style?
STEP 5: Apply the SAME pattern to your file.
STEP 6: Run \`npx tsc --noEmit\`.

End with "DONE: <summary>" or "FAILED: <reason>".`,

    'safe-rewrite': `
This is attempt #5 — the FINAL strategy. Four previous fixes failed.
The file may be fundamentally broken (duplicate code, corrupted structure, etc).

STRATEGY: Rewrite from intent.
STEP 1: Read the current file ONCE (understand what's there).
STEP 2: In your thinking, write out what the file SHOULD do:
   - What does it export?
   - What props does it take?
   - What does it render/return?
STEP 3: Use edit_file to replace small broken sections. If the file is too broken, use write_file — BUT ONLY after reading the whole thing and understanding the intent.
STEP 4: Run \`npx tsc --noEmit\` to verify.
STEP 5: If TypeScript passes, run \`npm run build\` to check integration.

End with "DONE: <summary>" or "FAILED: <reason>".`,
  };

  return base + '\n' + (strategies[strategy] || strategies['direct-fix']);
}

// ═══════════════════════════════════════════════════════════
// MAIN ENTRY
// ═══════════════════════════════════════════════════════════
export async function runMultiAgent(
  userRequest: string,
  apiKey: string,
  emit: (event: WorkerEvent) => void
): Promise<{ plan: Subtask[]; results: Array<{ subtask: Subtask; ok: boolean; summary: string }> }> {
  const startTime = Date.now();
  dlog('START', 'Multi-agent run', { request: userRequest.slice(0, 100) });

  const rules = await loadRules();
  const memory = await loadMemory();
  const blackboard = new SharedBlackboard();

  // ─── ORCHESTRATOR 1: PLAN ───
  emit({ type: 'orchestrator_start', orchestratorId: 1, message: 'Planning...' });

  const plannerPrompt = `You are Orchestrator 1 (Planner). Break the request into 3-10 INDEPENDENT subtasks for PARALLEL execution.

CONSTITUTION: ${rules}
USER REQUEST: ${userRequest}

RULES:
1. Subtasks run SIMULTANEOUSLY.
2. No dependencies between subtasks.
3. Combine shared files into ONE subtask.
4. Last subtask: verify build, start server, open website.

OUTPUT STRICT JSON ONLY:
{"subtasks":[{"id":"1","title":"...","description":"...","files_hint":["path"],"priority":2}]}`;

  let subtasks: Subtask[] = [];
  try {
    const res = await fetch(API_URL, {
      method: 'POST', headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: MODEL, messages: [{ role: 'user', content: plannerPrompt }], temperature: 0 }),
      signal: AbortSignal.timeout(60000),
    });
    const data = (await res.json()) as ChatCompletionResponse;
    const content = data.choices[0]?.message.content ?? '';
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]) as { subtasks?: unknown };
      const rawSubtasks = Array.isArray(parsed.subtasks) ? parsed.subtasks : [];
      subtasks = rawSubtasks.slice(0, 10).map((t: unknown, i: number) => {
        const item = (t && typeof t === 'object' ? t : {}) as Record<string, unknown>;
        return {
          id: String(item.id ?? i + 1),
          title: String(item.title ?? `Task ${i + 1}`),
          description: String(item.description ?? ''),
          files_hint: Array.isArray(item.files_hint) ? item.files_hint.map(String) : [],
          priority: Number(item.priority) || 2,
        };
      });
    }
  } catch {
    emit({ type: 'orchestrator_done', orchestratorId: 1, ok: false, message: 'Planner failed' });
    return { plan: [], results: [] };
  }

  if (subtasks.length === 0) return { plan: [], results: [] };
  emit({ type: 'plan_ready', subtasks });
  emit({ type: 'orchestrator_done', orchestratorId: 1, ok: true, message: `Planned ${subtasks.length} subtasks` });

  // ─── PHASE 1: PARALLEL EXECUTION ───
  const semaphore = new Semaphore(5);
  const results: Array<{ subtask: Subtask; ok: boolean; summary: string }> = [];

  await Promise.all(subtasks.map(async (subtask, idx) => {
    const workerId = idx + 1;
    const wStart = Date.now();
    await semaphore.acquire();
    try {
      emit({ type: 'worker_start', workerId, subtask, message: `Starting: ${subtask.title}` });
      const r = await runWorker(subtask, workerId, apiKey, rules, memory, blackboard, emit);
      results.push({ subtask, ok: r.ok, summary: r.summary });
      blackboard.publish(workerId, r.ok ? 'DONE' : 'FAILED', `${subtask.title} — ${r.summary.slice(0, 100)}`);
      emit({ type: r.ok ? 'worker_done' : 'worker_error', workerId, ok: r.ok, message: r.summary, elapsedMs: Date.now() - wStart });
    } catch (e) {
      const msg = errorMessage(e);
      results.push({ subtask, ok: false, summary: msg });
      emit({ type: 'worker_error', workerId, ok: false, message: msg, elapsedMs: Date.now() - wStart });
    } finally {
      semaphore.release();
    }
  }));

  // ─── PHASE 2: DEEP DEBUGGER (5 escalating strategies) ───
  const failedTasks = results.filter((r) => !r.ok);
  if (failedTasks.length === 0) {
    emit({ type: 'orchestrator_done', orchestratorId: 2, ok: true, message: `✅ All ${results.length} succeeded` });
    return { plan: subtasks, results };
  }

  dlog('DEEP_DEBUG', `Starting deep debugger for ${failedTasks.length} failed tasks`);
  emit({ type: 'recovery_start', message: `Deep Debugger starting for ${failedTasks.length} failures` });

  const recoveryStartTime = Date.now();
  let recoveryApiCalls = 0;

  for (const failed of failedTasks) {
    // Check time/API budget
    if (Date.now() - recoveryStartTime > RECOVERY_TIME_LIMIT_MS || recoveryApiCalls > RECOVERY_API_LIMIT) {
      dlog('DEEP_DEBUG', 'Budget exhausted, stopping recovery');
      emit({ type: 'recovery_failed', workerId: failed.subtask.id, message: '⏱ Recovery budget exhausted — manual fix needed' });
      continue;
    }

    const strategies = ['direct-fix', 'read-analyze', 'isolate', 'compare-similar', 'safe-rewrite'];
    const attempts: DebugAttempt[] = [];
    let recoverySucceeded = false;

    for (let i = 0; i < strategies.length; i++) {
      const strategy = strategies[i];
      
      // Budget check before each strategy
      if (Date.now() - recoveryStartTime > RECOVERY_TIME_LIMIT_MS || recoveryApiCalls > RECOVERY_API_LIMIT) {
        emit({ type: 'recovery_failed', workerId: failed.subtask.id, strategy, message: '⏱ Budget exhausted mid-recovery' });
        break;
      }

      emit({ 
        type: 'recovery_strategy', 
        workerId: failed.subtask.id, 
        strategy, 
        attempt: i + 1, 
        message: `[${i + 1}/5] ${strategy}` 
      });
      dlog('DEEP_DEBUG', `Task ${failed.subtask.id} → strategy ${i + 1}/5: ${strategy}`);

      // Snapshot files before attempt
      const snapshots = await snapshotFiles(failed.subtask.files_hint);

      try {
        const r = await runWorkerWithStrategy(
          failed.subtask, 
          `SRE-${i + 1}`, 
          apiKey, 
          rules, 
          memory, 
          blackboard, 
          emit, 
          strategy, 
          attempts,
          () => { recoveryApiCalls++; }
        );

        attempts.push({ strategy, ok: r.ok, summary: r.summary, filesChanged: failed.subtask.files_hint });

        if (r.ok) {
          // Verify the whole project still builds
          const v = await runVerify();
          if (v.ok) {
            failed.ok = true;
            failed.summary = `[Recovered via ${strategy}] ${r.summary}`;
            recoverySucceeded = true;
            emit({ type: 'recovery_worker_done', workerId: failed.subtask.id, strategy, ok: true, message: `✅ Fixed via ${strategy}` });
            dlog('DEEP_DEBUG', `✅ Task ${failed.subtask.id} recovered via ${strategy}`);
            break;
          } else {
            // Reported success but build fails — restore snapshot
            dlog('DEEP_DEBUG', `Strategy ${strategy} claimed OK but tsc fails — restoring`);
            await restoreFiles(snapshots);
            attempts.push({ strategy: `${strategy}-post-check`, ok: false, summary: `tsc failed after fix: ${v.output.slice(0, 200)}`, filesChanged: [] });
          }
        } else {
          // Restore snapshot if attempt made things worse
          const v = await runVerify();
          if (!v.ok) {
            // Check if it's worse than before
            dlog('DEEP_DEBUG', `Strategy ${strategy} failed — restoring file snapshots`);
            await restoreFiles(snapshots);
          }
        }
      } catch (e) {
        const msg = errorMessage(e);
        attempts.push({ strategy, ok: false, summary: msg, filesChanged: [] });
        await restoreFiles(snapshots);
      }
    }

    if (!recoverySucceeded) {
      failed.summary = `[Failed after 5 strategies] Original: ${failed.summary.slice(0, 300)}`;
      emit({ 
        type: 'recovery_failed', 
        workerId: failed.subtask.id, 
        message: `❌ Task failed after 5 strategies. Manual fix needed.`,
      });
      dlog('DEEP_DEBUG', `❌ Task ${failed.subtask.id} failed all 5 strategies`);
    }
  }

  // ─── FINAL REVIEW ───
  emit({ type: 'orchestrator_start', orchestratorId: 2, message: 'Final review...' });
  const okCount = results.filter((r) => r.ok).length;
  const allOk = okCount === results.length;
  const totalTime = Date.now() - startTime;
  
  emit({ 
    type: 'orchestrator_done', 
    orchestratorId: 2, 
    ok: allOk, 
    message: allOk 
      ? `✅ ${okCount}/${results.length} succeeded (${(totalTime / 1000).toFixed(1)}s)` 
      : `⚠️ ${okCount}/${results.length} succeeded (${(totalTime / 1000).toFixed(1)}s)` 
  });

  return { plan: subtasks, results };
}

// ═══════════════════════════════════════════════════════════
// WORKER with strategy-specific prompt
// ═══════════════════════════════════════════════════════════
async function runWorker(
  subtask: Subtask,
  workerId: number | string,
  apiKey: string,
  rules: string,
  memory: string,
  blackboard: SharedBlackboard,
  emit: (event: WorkerEvent) => void
): Promise<{ ok: boolean; summary: string }> {
  return runWorkerWithStrategy(subtask, workerId, apiKey, rules, memory, blackboard, emit, 'first-attempt', [], () => {});
}

async function runWorkerWithStrategy(
  subtask: Subtask,
  workerId: number | string,
  apiKey: string,
  rules: string,
  memory: string,
  blackboard: SharedBlackboard,
  emit: (event: WorkerEvent) => void,
  strategy: string,
  previousAttempts: DebugAttempt[],
  onApiCall: () => void
): Promise<{ ok: boolean; summary: string }> {
  const isFirstAttempt = strategy === 'first-attempt';
  
  const systemPrompt = isFirstAttempt
    ? `You are Worker #${workerId} — a powerful autonomous coding agent.

TASK: ${subtask.title}
DESCRIPTION: ${subtask.description}
FILES: ${subtask.files_hint.join(', ') || '(decide)'}

CONSTITUTION:
${rules}

MEMORY:
${memory}

YOUR CAPABILITIES:
- read_file, write_file (NEW files only), edit_file (PREFERRED for changes)
- bash (READ-ONLY + nohup npm run dev &, npm install, npx tsc)
- open_url (open a website in browser)
- check_build (verify production build)

STEPS:
1. Understand what's needed (read existing files first)
2. Implement using edit_file (or write_file for NEW files)
3. Verify with tsc (auto-runs after edit_file)
4. If task needs server: nohup npm run dev > /tmp/app.log 2>&1 &
5. If task needs website: use open_url tool

End with "DONE: <summary>" or "FAILED: <reason>".`
    : buildStrategyPrompt(strategy, subtask, previousAttempts, rules, memory);

  const messages: Array<Record<string, unknown>> = [{ role: 'system', content: systemPrompt }];

  for (let turn = 0; turn < MAX_WORKER_TURNS; turn++) {
    const sharedState = blackboard.read(workerId);
    messages.push({
      role: 'user',
      content: turn === 0
        ? `Execute: ${subtask.title}\n\n${subtask.description}\n\nSHARED STATE:\n${sharedState}`
        : `Continue.`,
    });

    let res: Response;
    try {
      onApiCall();
      res = await fetch(API_URL, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: MODEL, messages, tools: toolSchemas, tool_choice: 'auto', temperature: 0 }),
        signal: AbortSignal.timeout(120000),
      });
    } catch {
      return { ok: false, summary: 'API Timeout' };
    }

    if (!res.ok) return { ok: false, summary: `API ${res.status}` };

    const data = (await res.json()) as ChatCompletionResponse;
    const msg = data.choices[0]?.message;
    const toolCalls = msg?.tool_calls ?? [];
    const content = msg?.content ?? '';

    if (content && content.length > 15) {
      blackboard.publish(workerId, 'says', content.slice(0, 150).replace(/\n/g, ' '));
      emit({ type: 'worker_thought', workerId, message: content.slice(0, 250) });
    }

    if (toolCalls.length === 0) {
      if (turn === 0 && !/DONE|FAILED/i.test(content)) {
        messages.push({ role: 'assistant', content });
        messages.push({ role: 'user', content: 'Execute with tools now. Do not just describe.' });
        continue;
      }
      const ok = /DONE/i.test(content) && !/FAILED/i.test(content);
      return { ok, summary: content.slice(0, 500) || (ok ? 'Done' : 'No output') };
    }

    messages.push({ role: 'assistant', content, tool_calls: toolCalls });

    for (const tc of toolCalls) {
      let args: ToolArgs = {};
      try { args = JSON.parse(tc.function.arguments || '{}') as ToolArgs; } catch {}

      if (needsApproval(tc.function.name, args).blocked) {
        messages.push({ role: 'tool', tool_call_id: tc.id, content: 'BLOCKED' });
        continue;
      }

      emit({ type: 'worker_step', workerId, tool: tc.function.name, args, message: `${tc.function.name}(${JSON.stringify(args).slice(0, 50)})` });

      const result = await executeTool(tc.function.name, args);
      messages.push({ role: 'tool', tool_call_id: tc.id, content: result.result });

      if ((tc.function.name === 'edit_file' || tc.function.name === 'write_file') && !result.result.startsWith('Error')) {
        const v = await runVerify();
        if (!v.ok) {
          messages.push({ role: 'user', content: `❌ tsc failed:\n${v.output.slice(0, 1500)}\n\nFix now.` });
        }
      }
    }
  }

  return { ok: false, summary: 'Max turns reached' };
}
